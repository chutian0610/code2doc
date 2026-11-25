import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';
import { collectComments, fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, FileRefs, Span, SymbolKind, SymbolRecord } from './types.js';
import { claimCollector, noRefs, refCollector, symbolId } from './types.js';

/**
 * TS/JS extractor built on web-tree-sitter (WASM) with the official
 * tree-sitter-typescript grammar. `.tsx`/`.jsx` use the tsx grammar;
 * everything else uses the typescript grammar (a JS superset).
 */

/** Extensions this extractor claims — also the import-resolution candidates (one source, ADR-0005). */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const require = createRequire(import.meta.url);

const TS_PKG_ROOT = path.dirname(require.resolve('tree-sitter-typescript/package.json'));
const TS_WASM = path.join(TS_PKG_ROOT, 'tree-sitter-typescript.wasm');
const TSX_WASM = path.join(TS_PKG_ROOT, 'tree-sitter-tsx.wasm');

let parserInit: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();

function getLanguage(kind: 'typescript' | 'tsx'): Promise<Language> {
  let lang = languages.get(kind);
  if (!lang) {
    lang = Language.load(kind === 'tsx' ? TSX_WASM : TS_WASM);
    languages.set(kind, lang);
  }
  return lang;
}

/** Captures a declaration plus its name; the decl node drives span logic. */
const QUERY = `
  (function_declaration name: (identifier) @name) @decl
  (class_declaration name: (type_identifier) @name) @decl
  (abstract_class_declaration name: (type_identifier) @name) @decl
  (interface_declaration name: (type_identifier) @name) @decl
  (type_alias_declaration name: (type_identifier) @name) @decl
  (enum_declaration name: (identifier) @name) @decl
  (lexical_declaration (variable_declarator name: (identifier) @name)) @decl
`;

/** Comment node shape of the TS/JS grammars. */
const COMMENT_QUERY = `(comment) @comment`;

/**
 * Call-ref sites per ADR-0004: bare calls by name, `new`,
 * `extends`/`implements` — and member calls captured whole (#26): their
 * name is only ours when the receiver chain bottoms out in a namespace
 * import, decided in code. Function-as-value references are a
 * documented blind spot and match none of these patterns.
 */
const REF_QUERY = `
  (call_expression function: (identifier) @callee)
  (call_expression function: (member_expression) @member)
  (new_expression constructor: (identifier) @callee)
  (new_expression constructor: (member_expression property: (property_identifier) @callee))
  (extends_clause value: (identifier) @callee)
  (extends_clause value: (member_expression property: (property_identifier) @callee))
  (implements_clause (type_identifier) @callee)
`;

/** Named imports (specifier node read whole, so `a as b` yields local b), default imports, and namespace bases. */
const IMPORT_QUERY = `
  (import_statement (import_clause (named_imports (import_specifier) @spec)) source: (string (string_fragment) @source))
  (import_statement (import_clause (identifier) @local) source: (string (string_fragment) @source))
  (import_statement (import_clause (namespace_import (identifier) @ns)) source: (string (string_fragment) @source))
`;

/**
 * Calls taking a string first argument — the shape a `require` has (#25).
 * Filtering by callee text happens in code; the query just narrows the walk.
 */
const REQUIRE_QUERY = `
  (call_expression function: (identifier) @fn arguments: (arguments (string (string_fragment) @source))) @call
`;

/** How a declaration type maps to kind + signature/body spans. */
interface DeclShape {
  kind: SymbolKind;
  signatureStart(decl: SyntaxNode): SyntaxNode;
  /** Byte offset where the signature ends. */
  signatureEnd(decl: SyntaxNode): number;
  body(decl: SyntaxNode): SyntaxNode;
}

function declaratorOf(decl: SyntaxNode): SyntaxNode {
  return decl.namedChildren.find((c) => c.type === 'variable_declarator') ?? decl;
}

/** Shape declarations where the whole node is the shape (interface/type/enum). */
function wholeNode(kind: SymbolKind): DeclShape {
  return {
    kind,
    signatureStart: (d) => d,
    signatureEnd: (d) => d.endIndex,
    body: (d) => d,
  };
}

/** Classes and abstract classes share one shape: header vs body (#22 — tree-sitter parses them as distinct node types). */
const classShape: DeclShape = {
  kind: 'class',
  signatureStart: (d) => d,
  signatureEnd: (d) => {
    const body = d.childForFieldName('body');
    return body ? body.startIndex : d.endIndex;
  },
  body: (d) => d.childForFieldName('body') ?? d,
};

const DECL_SHAPES: Record<string, DeclShape> = {
  function_declaration: {
    kind: 'function',
    signatureStart: (d) => d,
    signatureEnd: (d) => (d.childForFieldName('return_type') ?? d.childForFieldName('parameters') ?? d).endIndex,
    body: (d) => d.childForFieldName('body') ?? d,
  },
  class_declaration: classShape,
  abstract_class_declaration: classShape,
  lexical_declaration: {
    kind: 'variable',
    signatureStart: declaratorOf,
    signatureEnd: (d) => {
      const value = declaratorOf(d).childForFieldName('value');
      return value ? value.startIndex : declaratorOf(d).endIndex;
    },
    body: (d) => declaratorOf(d).childForFieldName('value') ?? declaratorOf(d),
  },
  interface_declaration: wholeNode('interface'),
  type_alias_declaration: wholeNode('type'),
  enum_declaration: wholeNode('enum'),
};

function makeRecord(
  code: string,
  decl: SyntaxNode,
  shape: DeclShape,
  name: string,
  file: string,
  visibility: 'public' | 'internal',
  comments: CommentRange[],
): SymbolRecord {
  const sigStart = shape.signatureStart(decl);
  const signature: Span = {
    start: sigStart.startIndex,
    end: shape.signatureEnd(decl),
    row: sigStart.startPosition.row,
    col: sigStart.startPosition.column,
  };
  const body = spanOf(shape.body(decl));
  return {
    name,
    kind: shape.kind,
    file,
    signature,
    body,
    visibility,
    fingerprint: fingerprintOf(code, signature, body, comments),
  };
}

/** True when the declaration sits at module top level (possibly under export). */
function isTopLevel(decl: SyntaxNode): boolean {
  const parent = decl.parent;
  if (!parent) return false;
  if (parent.type === 'program') return true;
  return parent.type === 'export_statement' && parent.parent?.type === 'program';
}

/**
 * Attribute a ref site to its enclosing top-level declaration. Calls and
 * `new` belong to the enclosing function/variable symbol; heritage
 * (`extends`/`implements`) belongs to the class itself, which the walk
 * reaches without entering the class body. Everything else — method
 * bodies, top-level statements, interface heritage — has no caller
 * symbol and yields nothing (a tolerated missing edge, never a false one).
 */
function callerOf(callee: SyntaxNode): string | undefined {
  let sawClassBody = false;
  for (let cur = callee.parent; cur; cur = cur.parent) {
    if (cur.type === 'class_body') sawClassBody = true;
    if (isTopLevel(cur)) return callerNameOf(cur, sawClassBody);
  }
  return undefined;
}

/** The caller name of a top-level declaration, or undefined when the decl cannot own calls. */
function callerNameOf(decl: SyntaxNode, sawClassBody: boolean): string | undefined {
  if (decl.type === 'class_declaration') {
    return sawClassBody ? undefined : (decl.childForFieldName('name')?.text ?? undefined);
  }
  if (decl.type === 'lexical_declaration') {
    return declaratorOf(decl).childForFieldName('name')?.text ?? undefined;
  }
  if (decl.type === 'function_declaration') {
    return decl.childForFieldName('name')?.text ?? undefined;
  }
  return undefined;
}

/** The function-like nodes that own a parameter list. */
const FUNCTION_LIKE = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'function_signature',
  'method_definition',
  'generator_function_declaration',
]);

/**
 * True when the called name is a parameter of any function wrapping the
 * call site. Every layer on the climb must be checked before the name
 * resolves to the import or global of the same spelling — that resolve
 * is the false edge ADR-0004 forbids (#38, Python's rule in #35): a
 * nested arrow closing over the outer parameter still calls the
 * argument, and a function expression or the second declarator carries
 * parameters just as much as the first. Type-annotation identifiers
 * land in the set too — conservative, the missing-edge direction. A
 * member call is a property access, not a name lookup, so it never
 * checks this. Python checks only its innermost def because its
 * callerOf refuses to climb out of a nested def; this climb
 * attributes through one.
 */
function shadowedByParameter(site: SyntaxNode, name: string): boolean {
  for (let cur = site.parent; cur; cur = cur.parent) {
    if (!FUNCTION_LIKE.has(cur.type)) continue;
    const params = cur.childForFieldName('parameters');
    if (params?.descendantsOfType('identifier').some((p) => p.text === name)) return true;
  }
  return false;
}

/** Grammar kind for a file extension (`.tsx`/`.jsx` use the tsx grammar). */
function grammarFor(file: string): 'typescript' | 'tsx' {
  const ext = path.extname(file).toLowerCase();
  return ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'typescript';
}

/** Parse a file once; both extract and extractRefs share the preamble. */
async function parseTree(code: string, file: string) {
  parserInit ??= Parser.init();
  await parserInit;
  const language = await getLanguage(grammarFor(file));
  const parser = new Parser();
  parser.setLanguage(language);
  return { language, tree: parser.parse(code) };
}

/**
 * The claims pass: ESM import bindings and CommonJS requires are both
 * claim factories — the bound name never falls through to same-file or
 * global guesses (#25), relative sources resolve through the same
 * resolveImport machinery as ESM, bare ones stay claimed.
 */
function readImportClaims(language: Language, tree: Tree) {
  const claims = claimCollector();
  const { imports, namespaces } = claims;
  for (const { captures } of new Query(language, IMPORT_QUERY).matches(tree.rootNode)) {
    const spec = captures.find((c) => c.name === 'spec')?.node;
    const local = captures.find((c) => c.name === 'local')?.node;
    const ns = captures.find((c) => c.name === 'ns')?.node;
    const source = captures.find((c) => c.name === 'source')?.node;
    if (!source) continue;
    if (spec) {
      const imported = spec.childForFieldName('name')?.text ?? '';
      const alias = spec.childForFieldName('alias')?.text ?? imported;
      imports[alias] = { kind: 'named', imported, source: source.text };
    } else if (local) {
      // default import: the binding is claimed but unresolvable by name —
      // the disambiguation steps must not fall through to same-file/global guesses
      imports[local.text] = { kind: 'default', source: source.text };
    } else if (ns) {
      namespaces.set(ns.text, source.text);
    }
  }

  for (const { captures } of new Query(language, REQUIRE_QUERY).matches(tree.rootNode)) {
    const fn = captures.find((c) => c.name === 'fn')?.node;
    const source = captures.find((c) => c.name === 'source')?.node;
    if (!source || fn?.text !== 'require') continue;
    // `const <pattern> = require('<source>')` — the call's parent is the declarator
    const declarator = captures.find((c) => c.name === 'call')?.node?.parent;
    if (declarator?.type !== 'variable_declarator') continue;
    const name = declarator.childForFieldName('name');
    if (!name) continue;
    if (name.type === 'identifier') {
      // whole-module binding: claimed, unresolvable by name — like a default import
      imports[name.text] = { kind: 'default', source: source.text };
    } else if (name.type === 'object_pattern') {
      for (const prop of name.namedChildren) {
        const key = prop.childForFieldName('key');
        const value = prop.childForFieldName('value');
        const fallback = prop.childForFieldName('left'); // `{ a = 1 }`
        if (key && value) imports[value.text] = { kind: 'named', imported: key.text, source: source.text };
        else if (fallback) imports[fallback.text] = { kind: 'named', imported: fallback.text, source: source.text };
        else if (prop.type === 'shorthand_property_identifier_pattern') {
          imports[prop.text] = { kind: 'named', imported: prop.text, source: source.text };
        }
      }
    }
  }

  return claims;
}

/**
 * The calls pass: a member call's name is ours only through a namespace
 * import — walk left to the receiver chain's base identifier and ask the
 * claims (#26). Any other receiver — a call result, a field, a builtin —
 * names some object's method, and methods are not symbols in this
 * language family: field-measured, every such name the
 * global-uniqueness step resolved was a false edge. Bare calls, `new`
 * and heritage go straight to the shared accumulator.
 */
function readCalls(language: Language, tree: Tree, claims: ReturnType<typeof claimCollector>): FileRefs['callers'] {
  const refs = refCollector();
  for (const { captures } of new Query(language, REF_QUERY).matches(tree.rootNode)) {
    const member = captures.find((c) => c.name === 'member')?.node;
    if (member) {
      let base = member.childForFieldName('object');
      while (base?.type === 'member_expression') base = base.childForFieldName('object');
      const prop = member.childForFieldName('property')?.text;
      if (!prop) continue;
      const source = claims.claimViaNamespace(base?.type === 'identifier' ? base.text : undefined, prop);
      if (!source) continue;
      refs.note(callerOf(member), prop);
      continue;
    }
    const callee = captures.find((c) => c.name === 'callee')?.node;
    if (!callee) continue;
    if (shadowedByParameter(callee, callee.text)) continue;
    refs.note(callerOf(callee), callee.text);
  }
  return refs.finish();
}

export function createTsExtractor(): Extractor {
  return {
    languageId: 'ts-family',
    extensions: EXTENSIONS,
    async extract(code, file) {
      const { language, tree } = await parseTree(code, file);
      if (!tree) return [];
      const query = new Query(language, QUERY);
      const comments = collectComments(language, tree, COMMENT_QUERY);

      const records: SymbolRecord[] = [];
      for (const { captures } of query.matches(tree.rootNode)) {
        const decl = captures.find((c) => c.name === 'decl')?.node;
        const nameNode = captures.find((c) => c.name === 'name')?.node;
        if (!decl || !nameNode) continue;
        if (!isTopLevel(decl)) continue;

        const shape = DECL_SHAPES[decl.type];
        if (!shape) continue;
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const visibility = decl.parent?.type === 'export_statement' ? 'public' : 'internal';
        records.push(makeRecord(code, decl, shape, name, file, visibility, comments));
      }
      return records;
    },
    async extractRefs(code, file) {
      const { language, tree } = await parseTree(code, file);
      if (!tree) return noRefs();

      const claims = readImportClaims(language, tree);
      return { imports: claims.imports, callers: readCalls(language, tree, claims) };
    },
    resolveImport(file, binding, index) {
      if (binding.kind !== 'named') return undefined; // default: claimed, unresolvable by name
      const { imported, source } = binding;
      if (!(source.startsWith('.') || source.startsWith('/'))) return undefined; // bare specifier: ignored
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
      const stripped = EXTENSIONS.some((e) => base.endsWith(e)) ? base.slice(0, base.lastIndexOf('.')) : base;
      const candidates = [
        base,
        ...EXTENSIONS.map((e) => stripped + e),
        ...EXTENSIONS.map((e) => `${stripped}/index${e}`),
      ];
      for (const candidate of candidates) {
        if (index.at(candidate)?.includes(imported)) return symbolId(candidate, imported);
      }
      return undefined;
    },
  };
}
