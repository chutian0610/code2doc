import type { CacheData } from './cache.js';
import { FINGERPRINT_HEX } from './extractor/types.js';
import type { Fingerprint } from './extractor/types.js';

/**
 * Anchors: plain markdown links whose title carries the whole machine
 * payload — `[text](target "c2d:<file>#<name>:<sig>.<body>")`. The URL
 * stays a normal, clickable link for Readers; the verifier never parses it.
 */

/** A parsed `c2d:` anchor from a page. */
export interface Anchor {
  /** Link text, kept for human listings. */
  text: string;
  /** Link URL exactly as written. */
  target: string;
  /** Repo-relative source file of the anchored symbol. */
  file: string;
  /** Symbol name. */
  name: string;
  /** Fingerprint as written at doc time. */
  fingerprint: Fingerprint;
  /** 1-based line of the anchor within the page. */
  line: number;
}

/** Markdown link with an optional double-quoted title. */
const LINK_RE = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g;

/** Anchor payload: `c2d:<file>#<name>:<sig>.<body>` (hex hashes, fixed length). */
const PAYLOAD_RE = new RegExp(
  `^c2d:(.+)#([\\w$]+):([0-9a-f]{${FINGERPRINT_HEX}})\\.([0-9a-f]{${FINGERPRINT_HEX}})$`,
);

/** A markdown link as written: text, URL, optional title. */
export interface MarkdownLink {
  text: string;
  target: string;
  title?: string;
  /** 0-based offset of the link within the page (the `[`). */
  index: number;
  /** 1-based line of the link within the page. */
  line: number;
}

/** Every inline markdown link in the page, anchors and ordinary links alike. */
export function parseMarkdownLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const m of markdown.matchAll(LINK_RE)) {
    links.push({
      text: m[1],
      target: m[2],
      title: m[3],
      index: m.index,
      line: markdown.slice(0, m.index).split('\n').length,
    });
  }
  return links;
}

/** The machine payload of an anchor, without the surrounding link. */
export interface AnchorPayload {
  file: string;
  name: string;
  fingerprint: Fingerprint;
}

/** The anchor payload in a link title, when the title carries one. */
export function parseAnchorTitle(title: string): AnchorPayload | undefined {
  const payload = PAYLOAD_RE.exec(title);
  if (!payload) return undefined;
  return {
    file: payload[1],
    name: payload[2],
    fingerprint: { signature: payload[3], body: payload[4] },
  };
}

export function parseAnchors(markdown: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const link of parseMarkdownLinks(markdown)) {
    if (!link.title) continue;
    const payload = parseAnchorTitle(link.title);
    if (!payload) continue;
    anchors.push({ text: link.text, target: link.target, ...payload, line: link.line });
  }
  return anchors;
}

/**
 * Freshness of one anchor (and, as the worst of its anchors, of a page).
 * `ripple`: the anchor's own fingerprint still matches, but a callee
 * under it went stale since the last status (ADR-0004) — weaker
 * evidence than drift, so it ranks below it.
 */
export type AnchorState = 'fresh' | 'drift' | 'broken' | 'ripple';

/** '' when fresh; why the anchor is stale otherwise. */
export type AnchorReason = '' | 'symbol gone' | 'signature changed' | 'body changed' | 'callee went stale';

export interface AnchorCheck {
  state: AnchorState;
  reason: AnchorReason;
}

/**
 * Resolve an anchor against the current symbol cache. Lookup is by
 * file + name only — the row in a symbol id is cache-local, so line
 * shifts never break an anchor.
 */
export function checkAnchor(anchor: Anchor, cache: CacheData): AnchorCheck {
  const symbols = cache.files[anchor.file]?.symbols ?? [];
  const symbol = symbols.find((s) => s.name === anchor.name);
  if (!symbol) return { state: 'broken', reason: 'symbol gone' };
  if (symbol.fingerprint.signature !== anchor.fingerprint.signature) {
    return { state: 'broken', reason: 'signature changed' };
  }
  if (symbol.fingerprint.body !== anchor.fingerprint.body) {
    return { state: 'drift', reason: 'body changed' };
  }
  return { state: 'fresh', reason: '' };
}
