import { createHash } from 'node:crypto';
import type { Node as SyntaxNode } from 'web-tree-sitter';
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

/** Fingerprint of a signature/body span pair against the source bytes. */
export function fingerprintOf(
  bytes: Buffer,
  signature: Span,
  body: Span,
  comments: CommentRange[],
): Fingerprint {
  return {
    signature: hash(spanText(bytes, signature.start, signature.end, comments)),
    body: hash(spanText(bytes, body.start, body.end, comments)),
  };
}
