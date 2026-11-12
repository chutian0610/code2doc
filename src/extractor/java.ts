import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import { fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, FileRefs, ImportBinding, Span, SymbolKind, SymbolRecord } from './types.js';
import { collapseCallers, noRefs, symbolId } from './types.js';

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

/** Comment ranges are cut from hash input, in every hashed span. */
const COMMENT_QUERY = `[(line_comment) (block_comment)] @comment`;

/**
 * Call-ref sites per ADR-0004: any method invocation by its name field
 * (bare, `this.x()`, chained and static-import calls all expose the
 * final method name there), construction, `extends`/`implements`.
 * Method references (`this::x`) and field accesses are no invocations
 * and match nothing.
 */
const REF_QUERY = `
  (method_invocation name: (identifier) @callee)
  (object_creation_expression type: (type_identifier) @callee)
  (object_creation_expression type: (scoped_type_identifier) @scoped)
  (class_declaration superclass: (superclass (type_identifier) @callee))
  (class_declaration superclass: (superclass (scoped_type_identifier) @scoped))
  (class_declaration interfaces: (super_interfaces (type_list (type_identifier) @callee)))
  (class_declaration interfaces: (super_interfaces (type_list (scoped_type_identifier) @scoped)))
`;

/** Whole import declarations — the FQCN shape is decoded here, not in a query. */
const IMPORT_QUERY = `(import_declaration) @import`;

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

function makeRecord(
  code: Buffer,
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
      const commentQuery = new Query(language, COMMENT_QUERY);

      const comments: CommentRange[] = [];
      for (const { captures } of commentQuery.matches(tree.rootNode)) {
        const node = captures.find((c) => c.name === 'comment')?.node;
        if (node) comments.push([node.startIndex, node.endIndex]);
      }
      comments.sort((a, b) => a[0] - b[0]);

      const bytes = Buffer.from(code, 'utf8');
      const records: SymbolRecord[] = [];
      for (const { captures } of query.matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'decl')?.node;
        const nameNode = captures.find((c) => c.name === 'name')?.node;
        if (!decl || !nameNode) continue;
        if (!isTopLevelType(decl) && !isMethodOfTopLevelType(decl)) continue;

        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        records.push(makeRecord(bytes, decl, name, file, comments));
      }
      return records;
    },
    async extractRefs(code) {
      const { language, tree } = await parseTree(code);
      if (!tree) return noRefs();

      const imports: FileRefs['imports'] = {};
      for (const { captures } of new Query(language, IMPORT_QUERY).matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'import')?.node;
        const binding = decl && importBinding(decl);
        if (binding) imports[binding[0]] = binding[1];
      }

      const called: Record<string, Set<string>> = {};
      for (const { captures } of new Query(language, REF_QUERY).matches(tree.rootNode)) {
        const node =
          captures.find((c) => c.name === 'callee')?.node ??
          captures.find((c) => c.name === 'scoped')?.node;
        if (!node) continue;
        const name = node.type === 'scoped_type_identifier' ? finalTypeSegment(node) : node.text;
        const caller = name ? callerOf(node) : undefined;
        if (name && caller) (called[caller] ??= new Set<string>()).add(name);
      }
      return { imports, callers: collapseCallers(called) };
    },
    resolveImport(_file, binding, index) {
      if (binding.kind !== 'named') return undefined;
      const matches = index.matching(binding.source);
      if (matches.length !== 1) return undefined; // external, or ambiguous across package roots
      return index.at(matches[0])?.includes(binding.imported)
        ? symbolId(matches[0], binding.imported)
        : undefined;
    },
  };
}
