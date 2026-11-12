import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import { fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, FileRefs, Span, SymbolKind, SymbolRecord } from './types.js';
import { collapseCallers, noRefs } from './types.js';

/**
 * TS/JS extractor built on web-tree-sitter (WASM) with the official
 * tree-sitter-typescript grammar. `.tsx`/`.jsx` use the tsx grammar;
 * everything else uses the typescript grammar (a JS superset).
 */

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
  (interface_declaration name: (type_identifier) @name) @decl
  (type_alias_declaration name: (type_identifier) @name) @decl
  (enum_declaration name: (identifier) @name) @decl
  (lexical_declaration (variable_declarator name: (identifier) @name)) @decl
`;

/** Comment ranges are cut from hash input, in every hashed span. */
const COMMENT_QUERY = `(comment) @comment`;

/**
 * Call-ref sites per ADR-0004: call/member-call by final identifier,
 * `new`, `extends`/`implements`. Function-as-value references are a
 * documented blind spot and match none of these patterns.
 */
const REF_QUERY = `
  (call_expression function: (identifier) @callee)
  (call_expression function: (member_expression property: (property_identifier) @callee))
  (new_expression constructor: (identifier) @callee)
  (new_expression constructor: (member_expression property: (property_identifier) @callee))
  (extends_clause value: (identifier) @callee)
  (extends_clause value: (member_expression property: (property_identifier) @callee))
  (implements_clause (type_identifier) @callee)
`;

/** Named imports (specifier node read whole, so `a as b` yields local b) and default imports. */
const IMPORT_QUERY = `
  (import_statement (import_clause (named_imports (import_specifier) @spec)) source: (string (string_fragment) @source))
  (import_statement (import_clause (identifier) @local) source: (string (string_fragment) @source))
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

const DECL_SHAPES: Record<string, DeclShape> = {
  function_declaration: {
    kind: 'function',
    signatureStart: (d) => d,
    signatureEnd: (d) => (d.childForFieldName('return_type') ?? d.childForFieldName('parameters') ?? d).endIndex,
    body: (d) => d.childForFieldName('body') ?? d,
  },
  class_declaration: {
    kind: 'class',
    signatureStart: (d) => d,
    signatureEnd: (d) => {
      const body = d.childForFieldName('body');
      return body ? body.startIndex : d.endIndex;
    },
    body: (d) => d.childForFieldName('body') ?? d,
  },
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
  code: Buffer,
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
    id: `${file}#${name}@${signature.row}`,
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

export function createTsExtractor(): Extractor {
  return {
    languageId: 'ts-family',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    async extract(code, file) {
      const { language, tree } = await parseTree(code, file);
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
        if (!isTopLevel(decl)) continue;

        const shape = DECL_SHAPES[decl.type];
        if (!shape) continue;
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const visibility = decl.parent?.type === 'export_statement' ? 'public' : 'internal';
        records.push(makeRecord(bytes, decl, shape, name, file, visibility, comments));
      }
      return records;
    },
    async extractRefs(code, file) {
      const { language, tree } = await parseTree(code, file);
      if (!tree) return noRefs();

      const imports: FileRefs['imports'] = {};
      for (const { captures } of new Query(language, IMPORT_QUERY).matches(tree.rootNode)) {
        const spec = captures.find((c) => c.name === 'spec')?.node;
        const local = captures.find((c) => c.name === 'local')?.node;
        const source = captures.find((c) => c.name === 'source')?.node;
        if (!source) continue;
        if (spec) {
          const imported = spec.childForFieldName('name')?.text ?? '';
          const alias = spec.childForFieldName('alias')?.text ?? imported;
          imports[alias] = { imported, source: source.text };
        } else if (local) {
          // default import: the binding is claimed but unresolvable by name —
          // the cascade must not fall through to same-file/global guesses
          imports[local.text] = { imported: '', source: source.text };
        }
      }

      const called: Record<string, Set<string>> = {};
      for (const { captures } of new Query(language, REF_QUERY).matches(tree.rootNode)) {
        const callee = captures.find((c) => c.name === 'callee')?.node;
        if (!callee) continue;
        const caller = callerOf(callee);
        if (caller) (called[caller] ??= new Set<string>()).add(callee.text);
      }
      return { imports, callers: collapseCallers(called) };
    },
  };
}
