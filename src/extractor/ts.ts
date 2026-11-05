import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import { FINGERPRINT_HEX } from './types.js';
import type { Extractor, Fingerprint, Span, SymbolKind, SymbolRecord } from './types.js';

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

function spanOf(node: SyntaxNode): Span {
  return {
    start: node.startIndex,
    end: node.endIndex,
    row: node.startPosition.row,
    col: node.startPosition.column,
  };
}

/** Sortable byte range of a comment node. */
type CommentRange = [start: number, end: number];

/**
 * Hash input for a span: comment ranges cut at AST granularity (a regex
 * would misfire on `//` inside string literals), then whitespace runs
 * collapsed to single spaces. Both keep comment-only and reflow-only
 * edits from producing false Drift signals (T2's no-false-signal
 * criterion) while keeping single-space differences — inside string
 * literals especially — significant, so real changes are never missed.
 */
function spanText(bytes: Buffer, start: number, end: number, comments: CommentRange[]): string {
  const parts: string[] = [];
  let cursor = start;
  for (const [cs, ce] of comments) {
    if (ce <= cursor) continue;
    if (cs >= end) break;
    if (cs > cursor) parts.push(bytes.toString('utf8', cursor, cs));
    cursor = Math.max(ce, cursor);
  }
  if (cursor < end) parts.push(bytes.toString('utf8', cursor, end));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, FINGERPRINT_HEX);
}

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
  const fingerprint: Fingerprint = {
    signature: hash(spanText(code, signature.start, signature.end, comments)),
    body: hash(spanText(code, body.start, body.end, comments)),
  };
  return {
    id: `${file}#${name}@${signature.row}`,
    name,
    kind: shape.kind,
    file,
    signature,
    body,
    visibility,
    fingerprint,
  };
}

/** True when the declaration sits at module top level (possibly under export). */
function isTopLevel(decl: SyntaxNode): boolean {
  const parent = decl.parent;
  if (!parent) return false;
  if (parent.type === 'program') return true;
  return parent.type === 'export_statement' && parent.parent?.type === 'program';
}

export function createTsExtractor(): Extractor {
  return {
    languageId: 'ts-family',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    async extract(code, file) {
      parserInit ??= Parser.init();
      await parserInit;
      const ext = path.extname(file).toLowerCase();
      const kind = ext === '.tsx' || ext === '.jsx' ? 'tsx' : 'typescript';
      const language = await getLanguage(kind);

      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(code);
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
  };
}
