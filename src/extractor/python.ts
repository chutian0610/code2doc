import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, Parser, Query, Node as SyntaxNode } from 'web-tree-sitter';
import { collectComments, fingerprintOf, spanOf } from './fingerprint.js';
import type { CommentRange } from './fingerprint.js';
import type { Extractor, Span, SymbolKind, SymbolRecord } from './types.js';

/**
 * Python extractor: tree-sitter-python (WASM) behind the same Extractor
 * contract as TS/JS and Java. Parity rules, all pinned by unit tests:
 *
 * - Symbols are module-level only: `def`/`class` targets, plus assignments
 *   whose name is UPPER_CASE (the constants convention; kind: variable).
 *   Methods, nested defs and `if`-guarded blocks are not symbols, and
 *   assignments inside them never surface.
 * - Dunder names (`__all__`, `__version__`, …) are absent from the symbol
 *   surface: bookkeeping, not API.
 * - Visibility follows the underscore convention: a leading underscore
 *   (single or double, non-dunder) is internal; everything else public.
 *   `__all__`-driven visibility is a documented blind spot — dynamic
 *   construction makes half-support worse than none.
 * - Decorators sit inside the signature span: adding or removing one
 *   changes the interface (Broken), not the body.
 * - A constant splits the TS way: the name (and its annotation) are the
 *   signature, the value is the body — a value edit drifts a claim, an
 *   annotation edit breaks it. Signals stay at parity across languages.
 * - A same-name redefinition (legal Python; later binding wins at runtime)
 *   is one record per declaration; downstream the name key compares as a
 *   set (ADR-0006).
 * - Only `#` line comments are comments; docstrings are string statements
 *   and belong to the body — editing one drifts a claim, never breaks it.
 */

const require = createRequire(import.meta.url);

const PYTHON_PKG_ROOT = path.dirname(require.resolve('tree-sitter-python/package.json'));
const PYTHON_WASM = path.join(PYTHON_PKG_ROOT, 'tree-sitter-python.wasm');

let parserInit: Promise<void> | undefined;
let languagePromise: Promise<Language> | undefined;

function getLanguage(): Promise<Language> {
  languagePromise ??= Language.load(PYTHON_WASM);
  return languagePromise;
}

/** Captures a declaration plus its name; the decl node drives span logic. */
const QUERY = `
  (function_definition name: (identifier) @name) @decl
  (class_definition name: (identifier) @name) @decl
  (assignment left: (identifier) @name) @decl
`;

/** Comment node shapes of the Python grammar: `#` line comments only. */
const COMMENT_QUERY = `(comment) @comment`;

/** tree-sitter node type → SymbolKind. */
const KINDS: Record<string, SymbolKind> = {
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
};

/** `__all__` and friends: bookkeeping names that are never symbols. */
function isDunder(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__') && name.length > 4;
}

/**
 * The constants convention: all caps, digits and underscores, one letter
 * at least. A leading underscore keeps the name a constant and marks it
 * internal (`_RATE = 0.5` is a private constant, still a symbol).
 */
function isUpperConstant(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name);
}

/** Visibility by the underscore convention (see the header comment). */
function visibilityOf(name: string): 'public' | 'internal' {
  return name.startsWith('_') ? 'internal' : 'public';
}

/**
 * The decorated_definition wrapper when present — its start is where the
 * signature begins, decorators included.
 */
function outerOf(decl: SyntaxNode): SyntaxNode {
  return decl.parent?.type === 'decorated_definition' ? decl.parent : decl;
}

/**
 * Module-level only. Assignments sit one `expression_statement` wrapper
 * below the module; defs, classes and decorated definitions are statements
 * in their own right.
 */
function isModuleLevel(outer: SyntaxNode): boolean {
  const parent = outer.parent;
  if (parent?.type === 'module') return true;
  return parent?.type === 'expression_statement' && parent.parent?.type === 'module';
}

/**
 * The header ends at its colon. The body block node starts after the
 * newline and indent — slicing at its start would fold that whitespace
 * into the signature.
 */
function headerEnd(decl: SyntaxNode, bodyNode: SyntaxNode | null): number {
  if (!bodyNode) return decl.endIndex;
  const colon = decl.children.find((c) => c.type === ':');
  return colon ? colon.endIndex : bodyNode.startIndex;
}

/** Parse a file once; extract and the later ref layers share the preamble. */
async function parseTree(code: string) {
  parserInit ??= Parser.init();
  await parserInit;
  const language = await getLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  return { language, tree: parser.parse(code) };
}

export function createPythonExtractor(): Extractor {
  return {
    languageId: 'python',
    extensions: ['.py'],
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
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        // dunder names are bookkeeping, whatever the kind (PEP 562 makes
        // module-level `def __getattr__` real); assignments additionally
        // must read as constants — most assignments are module state
        if (isDunder(name)) continue;
        if (decl.type === 'assignment' && !isUpperConstant(name)) continue;
        const outer = outerOf(decl);
        if (!isModuleLevel(outer)) continue;

        // a constant splits like a TS variable (parity of signals, #32):
        // the name and its annotation are the signature, the value is the
        // body — a value edit drifts a claim, an annotation edit breaks it
        const bodyNode = decl.childForFieldName('body') ?? decl.childForFieldName('right');
        const signature: Span = {
          start: outer.startIndex,
          end:
            decl.type === 'assignment'
              ? bodyNode
                ? bodyNode.startIndex
                : decl.endIndex
              : headerEnd(decl, bodyNode),
          row: outer.startPosition.row,
          col: outer.startPosition.column,
        };
        const body = spanOf(bodyNode ?? decl);
        records.push({
          name,
          kind: KINDS[decl.type],
          file,
          signature,
          body,
          visibility: visibilityOf(name),
          fingerprint: fingerprintOf(code, signature, body, comments),
        });
      }
      return records;
    },
  };
}
