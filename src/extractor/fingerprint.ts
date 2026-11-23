import { createHash } from 'node:crypto';
import { Query } from 'web-tree-sitter';
import type { Language, Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { FINGERPRINT_HEX } from './types.js';
import type { Fingerprint, Span } from './types.js';

/**
 * Fingerprint machinery shared by every extractor: spans, comment cutting,
 * whitespace collapsing, hashing. Language parity starts here — two
 * extractors that hash the same text the same way make anchor verification
 * language-blind.
 */

/** Sortable byte range of a comment node. */
export type CommentRange = [start: number, end: number];

/**
 * Every comment range of a tree, sorted — the input `fingerprintOf`
 * cuts from hash text. The loop lives here, next to the cutting, so
 * the collection algorithm cannot drift between adapters; the query
 * text is a grammar fact and stays with each language (TS speaks
 * `comment`, Java `line_comment`/`block_comment`).
 */
export function collectComments(language: Language, tree: Tree, commentQuery: string): CommentRange[] {
  const comments: CommentRange[] = [];
  for (const { captures } of new Query(language, commentQuery).matches(tree.rootNode)) {
    const node = captures.find((c) => c.name === 'comment')?.node;
    if (node) comments.push([node.startIndex, node.endIndex]);
  }
  return comments.sort((a, b) => a[0] - b[0]);
}

export function spanOf(node: SyntaxNode): Span {
  return {
    start: node.startIndex,
    end: node.endIndex,
    row: node.startPosition.row,
    col: node.startPosition.column,
  };
}

/**
 * Hash input for a span: comment ranges cut at AST granularity (a regex
 * would misfire on `//` inside string literals), then whitespace runs
 * collapsed to single spaces. Both keep comment-only and reflow-only
 * edits from producing false Drift signals (T2's no-false-signal
 * criterion) while keeping single-space differences — inside string
 * literals especially — significant, so real changes are never missed.
 *
 * Slices the source STRING, never bytes: web-tree-sitter's node offsets
 * are string indices, and byte-slicing a Buffer with them shifts the
 * window by the multibyte excess above the span — a file with a single
 * em dash would hash the wrong bytes and every fingerprint below the
 * dash would drift when unrelated text above it changed.
 */
function spanText(code: string, start: number, end: number, comments: CommentRange[]): string {
  const parts: string[] = [];
  let cursor = start;
  for (const [cs, ce] of comments) {
    if (ce <= cursor) continue;
    if (cs >= end) break;
    if (cs > cursor) parts.push(code.slice(cursor, cs));
    cursor = Math.max(ce, cursor);
  }
  if (cursor < end) parts.push(code.slice(cursor, end));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, FINGERPRINT_HEX);
}

/** Fingerprint of a signature/body span pair against the source text. */
export function fingerprintOf(
  code: string,
  signature: Span,
  body: Span,
  comments: CommentRange[],
): Fingerprint {
  return {
    signature: hash(spanText(code, signature.start, signature.end, comments)),
    body: hash(spanText(code, body.start, body.end, comments)),
  };
}
