import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import { collectComments, fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, FileRefs, ImportBinding, Span, SymbolKind, SymbolRecord } from './types.js';
import { noRefs, refCollector, symbolId } from './types.js';

/**
 * Java extractor: tree-sitter-java (WASM) behind the same Extractor
 * contract as TS/JS. Parity rules, all pinned by unit tests:
 *
 * - Symbols are top-level type declarations (class/interface/enum/record)
 *   plus the direct methods of those types. Nested and local types,
 *   their methods, fields and constructors are not symbols — a
 *   constructor's name is the class's name and would collide in the
 *   file#name anchor lookup.
 * - Visibility follows Java access rules: only `public` is public;
 *   package-private (no modifier), `protected` and `private` are
 *   internal. Interface members are implicitly public unless marked
 *   private (language rule, not a stylistic choice).
 * - Every declaration splits the same way: signature = modifiers through
 *   the header, body = the declaration body. A body-less (abstract)
 *   method hashes the whole declaration for both, like TS declarations
 *   without a body.
 * - Overloads are one record per declaration but one `file#name` key:
 *   downstream they compare as a whole declaration set (ADR-0006).
 */

const require = createRequire(import.meta.url);

const JAVA_PKG_ROOT = path.dirname(require.resolve('tree-sitter-java/package.json'));
const JAVA_WASM = path.join(JAVA_PKG_ROOT, 'tree-sitter-java.wasm');

let parserInit: Promise<void> | undefined;
let languagePromise: Promise<Language> | undefined;

function getLanguage(): Promise<Language> {
  languagePromise ??= Language.load(JAVA_WASM);
  return languagePromise;
}

/** Captures a declaration plus its name; the decl node drives span logic. */
const QUERY = `
  (class_declaration name: (identifier) @name) @decl
  (interface_declaration name: (identifier) @name) @decl
  (enum_declaration name: (identifier) @name) @decl
  (record_declaration name: (identifier) @name) @decl
  (method_declaration name: (identifier) @name) @decl
`;

/**
 * Call-ref sites per ADR-0004: any method invocation by its name field
 * (bare, `this.x()`, chained and static-import calls all expose the
 * final method name there), construction, `extends`/`implements`.
 * Method references (`this::x`) and field accesses are no invocations
 * and match nothing. The invocation capture lets the calls pass read
 * the receiver and apply the type rule (#41).
 */
const REF_QUERY = `
  (method_invocation name: (identifier) @callee) @invocation
  (object_creation_expression type: (type_identifier) @callee)
  (object_creation_expression type: (scoped_type_identifier) @scoped)
  (class_declaration superclass: (superclass (type_identifier) @callee))
  (class_declaration superclass: (superclass (scoped_type_identifier) @scoped))
  (class_declaration interfaces: (super_interfaces (type_list (type_identifier) @callee)))
  (class_declaration interfaces: (super_interfaces (type_list (scoped_type_identifier) @scoped)))
`;

/**
 * Receiver-type declarations (#41): a local name whose declared type
 * says whether a member call on it can resolve to a repo symbol at all.
 * Generic types count by their root name (`List<String>` → `List`);
 * `var`, arrays and other shapes yield no root and claim nothing.
 */
const TYPE_QUERY = `
  (field_declaration type: (_) @type (variable_declarator name: (identifier) @name))
  (formal_parameter type: (_) @type name: (identifier) @name)
  (local_variable_declaration type: (_) @type (variable_declarator name: (identifier) @name))
`;

/** Comment node shapes of the Java grammar. */
const COMMENT_QUERY = `[(line_comment) (block_comment)] @comment`;

/** Whole import declarations — the FQCN shape is decoded here, not in a query. */
const IMPORT_QUERY = `(import_declaration) @import`;

/** The file's package declaration — same-package claims resolve through it (#41). */
const PACKAGE_QUERY = `(package_declaration) @package`;

/** Body wrappers a method may sit under on its way to the type declaration. */
const TYPE_BODIES = new Set(['class_body', 'interface_body', 'enum_body', 'enum_body_declarations']);

/** tree-sitter node type → SymbolKind. Records are classes (no core change). */
const KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  method_declaration: 'function',
};

/**
 * The `modifiers` node, when present. tree-sitter-java exposes it as a
 * plain named child, not a field; keyword tokens inside it are anonymous.
 */
function modifiersOf(decl: SyntaxNode): SyntaxNode | undefined {
  return decl.namedChildren.find((c) => c.type === 'modifiers');
}

function hasModifier(decl: SyntaxNode, keyword: string): boolean {
  const mods = modifiersOf(decl);
  return !!mods && mods.children.some((c) => c.type === keyword);
}

/** True when decl is a top-level type (program is its direct parent). */
function isTopLevelType(decl: SyntaxNode): boolean {
  return decl.parent?.type === 'program';
}

/**
 * True when decl is a method of a top-level type — the only methods that
 * are symbols. Nested and local classes are not types of their own here,
 * so their methods stay out too.
 */
function isMethodOfTopLevelType(decl: SyntaxNode): boolean {
  if (decl.type !== 'method_declaration') return false;
  // climb through body wrappers (enum methods sit under enum_body_declarations)
  let type: SyntaxNode | null | undefined = decl.parent;
  while (type && TYPE_BODIES.has(type.type)) type = type.parent;
  return !!type && type.type in KINDS && type.parent?.type === 'program';
}

/** Visibility by Java access rules (see the header comment). */
function visibilityOf(decl: SyntaxNode): 'public' | 'internal' {
  if (hasModifier(decl, 'public')) return 'public';
  if (hasModifier(decl, 'private') || hasModifier(decl, 'protected')) return 'internal';
  const body = decl.parent;
  // interface members without an access modifier are implicitly public
  return body?.type === 'interface_body' ? 'public' : 'internal';
}

/** Parse a file once; both extract and extractRefs share the preamble. */
async function parseTree(code: string) {
  parserInit ??= Parser.init();
  await parserInit;
  const language = await getLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  return { language, tree: parser.parse(code) };
}

/**
 * Attribute a ref site: calls and `new` belong to the enclosing
 * top-level method (methods are symbols here — finer-grained than TS);
 * heritage belongs to the top-level class, which the walk reaches
 * without entering a type body. Constructor bodies, field initializers,
 * nested-type methods and interface heritage have no caller symbol and
 * yield nothing (a tolerated missing edge, never a false one).
 */
function callerOf(callee: SyntaxNode): string | undefined {
  let sawTypeBody = false;
  for (let cur = callee.parent; cur; cur = cur.parent) {
    if (cur.type === 'method_declaration' && isMethodOfTopLevelType(cur)) {
      return cur.childForFieldName('name')?.text ?? undefined;
    }
    if (TYPE_BODIES.has(cur.type)) sawTypeBody = true;
    if (cur.type === 'class_declaration' && isTopLevelType(cur)) {
      return sawTypeBody ? undefined : (cur.childForFieldName('name')?.text ?? undefined);
    }
  }
  return undefined;
}

/** The final segment of a dotted type, e.g. `demo.deep.Thing` → `Thing`. */
function finalTypeSegment(scoped: SyntaxNode): string | undefined {
  return scoped.namedChildren.filter((c) => c.type === 'type_identifier').at(-1)?.text;
}

/** The root name of a declared type: `List<String>` → `List`, `demo.other.Base` → `Base`. */
function rootTypeName(type: SyntaxNode): string | undefined {
  if (type.type === 'type_identifier') return type.text;
  if (type.type === 'generic_type') {
    return type.namedChildren.find((c) => c.type === 'type_identifier')?.text;
  }
  if (type.type === 'scoped_type_identifier') return finalTypeSegment(type);
  return undefined; // var, arrays, wildcards — no root, claims nothing
}

/**
 * Local name → declared root type, from same-file fields, parameters
 * and local variables (#41). The map a member call's receiver consults:
 * if the declared type names no repo symbol, the call resolves to some
 * runtime object's method that is not ours to claim.
 */
function collectTypeDecls(language: Language, tree: Tree): Map<string, string> {
  const decls = new Map<string, string>();
  for (const { captures } of new Query(language, TYPE_QUERY).matches(tree.rootNode)) {
    const type = captures.find((c) => c.name === 'type')?.node;
    const name = captures.find((c) => c.name === 'name')?.node;
    const root = type && rootTypeName(type);
    if (root && name) decls.set(name.text, root);
  }
  return decls;
}

/** Names of the file's top-level types — a receiver of one of these is same-file surface. */
function collectTopLevelTypeNames(language: Language, tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const { captures } of new Query(language, QUERY).matches(tree.rootNode)) {
    const decl = captures.find((c) => c.name === 'decl')?.node;
    if (decl && isTopLevelType(decl)) {
      const name = decl.childForFieldName('name')?.text;
      if (name) names.add(name);
    }
  }
  return names;
}

/** The file's package as a path (`com.google.gson` → `com/google/gson`), or undefined for the default package. */
function readPackagePath(language: Language, tree: Tree): string | undefined {
  for (const { captures } of new Query(language, PACKAGE_QUERY).matches(tree.rootNode)) {
    const decl = captures.find((c) => c.name === 'package')?.node;
    if (decl) return decl.text.replace(/^package\s+/, '').replace(/;/g, '').trim().replace(/\./g, '/') || undefined;
  }
  return undefined;
}

/**
 * Type names declared inside other types — inner, nested, local. A
 * member call on such a receiver resolves to the inner class's own
 * method, and inner-class methods are not symbols: claiming the name
 * would land on whichever top-level method happens to share it (#41
 * shape B, measured on gson's `Impl.createAdapter`).
 */
function collectInnerClassTypeNames(language: Language, tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const { captures } of new Query(language, QUERY).matches(tree.rootNode)) {
    const decl = captures.find((c) => c.name === 'decl')?.node;
    if (decl && decl.type !== 'method_declaration' && !isTopLevelType(decl)) {
      const name = decl.childForFieldName('name')?.text;
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * One import declaration → a normalized binding for the cascade. The
 * FQCN becomes a package-path suffix (`demo.other.Base` →
 * `demo/other/Base.java`); a static import binds the member name with
 * the class as its path; wildcard imports claim no name at all.
 */
function importBinding(decl: SyntaxNode): void | [string, ImportBinding] {
  if (decl.children.some((c) => c.type === 'asterisk')) return; // wildcard: claims nothing
  const scoped = decl.namedChildren.find((c) => c.type === 'scoped_identifier');
  if (!scoped) return;
  const segments = scoped.text.split('.');
  const isStatic = decl.children.some((c) => c.type === 'static');
  const path = (isStatic ? segments.slice(0, -1) : segments).join('/');
  const name = segments.at(-1)!;
  return [name, { kind: 'named', imported: name, source: `${path}.java` }];
}

/**
 * The calls pass. Bare calls, `new` and heritage go straight to the
 * shared accumulator. A member call reports only when its receiver's
 * type names a repo symbol (#41, the Java counterpart of #26) — a
 * method invocation on a JDK or library object shares its name with
 * any repo method that happens to be globally unique, and field-testing
 * measured those as the dominant false-edge shape:
 *
 * - `this` and a receiver declared with a same-file top-level type:
 *   claimed bare — same-file uniqueness resolves it;
 * - a receiver whose declared type (or an explicit class name) carries
 *   an import binding: claimed against that binding's FQCN source, so
 *   `resolveImport` settles repo-vs-external (`demo.other.Base` matches,
 *   `java.util.List` does not);
 * - an explicit class name with no import (same-package statics):
 *   claimed against the `./Name` form, which `resolveImport` settles by
 *   exact directory — `./ProxyFactory` hits, `./Arrays` never;
 * - everything else (chained calls, undeclared receivers, inner-class
 *   types, `var`) reports nothing — the missing-edge direction.
 */
function readCalls(
  language: Language,
  tree: Tree,
  imports: FileRefs['imports'],
  pkg: string | undefined,
): FileRefs['callers'] {
  const typeDecls = collectTypeDecls(language, tree);
  const topLevel = collectTopLevelTypeNames(language, tree);
  const innerTypes = collectInnerClassTypeNames(language, tree);
  const refs = refCollector();

  /**
   * How a type name may be claimed: same-file types bare, inner-class
   * types never (their methods are not symbols — shape B), imported
   * types against the FQCN (resolveImport settles repo vs external),
   * everything else the same-package form — the caller's own package
   * path when declared (`com/google/gson/JsonParser.java` resolves
   * across main/test source roots by unique suffix), `./Name.java` as
   * the default-package fallback (exact directory, resolveImport).
   */
  function typeClaim(typeName: string): { bare?: boolean; source?: string; samePackage?: string } | undefined {
    if (innerTypes.has(typeName)) return undefined;
    if (topLevel.has(typeName)) return { bare: true };
    const binding = imports[typeName];
    if (binding?.kind === 'named') return { source: binding.source };
    return { samePackage: pkg ? `${pkg}/${typeName}.java` : `${typeName}.java` };
  }

  /**
   * How a member call on this receiver may be claimed, per the rule
   * above; undefined when the receiver names nothing of ours. Java
   * cannot distinguish an undeclared variable from an explicit class
   * name, so both go through the type claim — the same-package form
   * resolves only where a uniquely-named file backs it.
   */
  function memberClaim(object: SyntaxNode): { bare?: boolean; source?: string; samePackage?: string } | undefined {
    if (object.type === 'this') return { bare: true };
    let typeName: string | undefined;
    if (object.type === 'field_access') {
      // `Type.CONSTANT.method()` — the value names the type or enum holder
      const value = object.childForFieldName('object');
      typeName = value?.type === 'identifier' ? value.text : undefined;
    } else if (object.type === 'identifier') {
      // a declared variable resolves through its declared type; an
      // undeclared identifier can only be an explicit class name
      typeName = typeDecls.get(object.text) ?? object.text;
    }
    return typeName ? typeClaim(typeName) : undefined;
  }

  for (const { captures } of new Query(language, REF_QUERY).matches(tree.rootNode)) {
    const invocation = captures.find((c) => c.name === 'invocation')?.node;
    if (invocation) {
      const callee = captures.find((c) => c.name === 'callee')?.node;
      const object = invocation.childForFieldName('object');
      const name = callee?.text;
      if (!callee || !name) continue;
      if (!object) {
        refs.note(callerOf(callee), name); // bare call
        continue;
      }
      const claim = memberClaim(object);
      if (!claim) continue;
      // an explicit import owns its name — a member claim never
      // overwrites it (the claimCollector policy, #26): overwriting
      // would point the bare call at the wrong module's symbol. The
      // call itself is still recorded — every caller that invokes the
      // name deserves the edge the claim resolves.
      if (!(name in imports)) {
        if (claim.source) imports[name] = { kind: 'named', imported: name, source: claim.source };
        else if (claim.samePackage)
          imports[name] = { kind: 'same-package', imported: name, source: claim.samePackage };
      }
      refs.note(callerOf(callee), name);
      continue;
    }
    const node =
      captures.find((c) => c.name === 'callee')?.node ??
      captures.find((c) => c.name === 'scoped')?.node;
    if (!node) continue;
    const name = node.type === 'scoped_type_identifier' ? finalTypeSegment(node) : node.text;
    if (!name) continue;
    refs.note(callerOf(node), name);
  }
  return refs.finish();
}

function makeRecord(
  code: string,
  decl: SyntaxNode,
  name: string,
  file: string,
  comments: CommentRange[],
): SymbolRecord {
  const bodyNode = decl.childForFieldName('body');
  const signature: Span = {
    start: decl.startIndex,
    end: bodyNode ? bodyNode.startIndex : decl.endIndex,
    row: decl.startPosition.row,
    col: decl.startPosition.column,
  };
  const body = spanOf(bodyNode ?? decl);
  return {
    name,
    kind: KINDS[decl.type],
    file,
    signature,
    body,
    visibility: visibilityOf(decl),
    fingerprint: fingerprintOf(code, signature, body, comments),
  };
}

export function createJavaExtractor(): Extractor {
  return {
    languageId: 'java',
    extensions: ['.java'],
    async extract(code, file) {
      const { language, tree } = await parseTree(code);
      if (!tree) return [];
      const query = new Query(language, QUERY);
      const comments = collectComments(language, tree, COMMENT_QUERY);

      const records: SymbolRecord[] = [];
      for (const { captures } of query.matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'decl')?.node;
        const nameNode = captures.find((c) => c.name === 'name')?.node;
        if (!decl || !nameNode) continue;
        if (!isTopLevelType(decl) && !isMethodOfTopLevelType(decl)) continue;

        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        records.push(makeRecord(code, decl, name, file, comments));
      }
      return records;
    },
    async extractRefs(code, file) {
      const { language, tree } = await parseTree(code);
      if (!tree) return noRefs();

      // prototype-less: `toString` and friends are ordinary Java method
      // names here, and must stay plain keys (#21)
      const imports: FileRefs['imports'] = Object.create(null);
      for (const { captures } of new Query(language, IMPORT_QUERY).matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'import')?.node;
        const binding = decl && importBinding(decl);
        if (binding) imports[binding[0]] = binding[1];
      }

      const pkg = readPackagePath(language, tree);
      return { imports, callers: readCalls(language, tree, imports, pkg) };
    },
    resolveImport(_file, binding, index) {
      if (binding.kind !== 'named' && binding.kind !== 'same-package') return undefined;
      const { imported, source } = binding;
      if (binding.kind === 'same-package') {
        // a receiver-type claim whose type has no import: try the
        // package-path suffix first, then the bare file name — a repo
        // may lay one package across source roots (main/test, #41)
        for (const candidate of [source, path.posix.basename(source)]) {
          const matches = index.matching(candidate);
          if (matches.length === 1) {
            return index.at(matches[0])?.includes(imported)
              ? symbolId(matches[0], imported)
              : undefined;
          }
        }
        return undefined;
      }
      const matches = index.matching(source);
      if (matches.length !== 1) return undefined; // external, or ambiguous across package roots
      return index.at(matches[0])?.includes(imported) ? symbolId(matches[0], imported) : undefined;
    },
  };
}
