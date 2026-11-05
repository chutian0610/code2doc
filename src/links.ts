import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseAnchorTitle, parseMarkdownLinks } from './anchors.js';
import { toPosix } from './paths.js';

/**
 * Doc links: ordinary markdown links between pages of the doc tree.
 * Checked for target existence only, so a rename never silently
 * leaves a link pointing at a missing page. Anchor URLs are never
 * parsed (the fingerprint in the title is their verification); links
 * leaving the doc tree (code, external sites), same-page fragments
 * and images are none of this checker's business.
 */

/** A doc link found in a page, resolved against the doc root. */
export interface DocLink {
  /** Link target exactly as written, e.g. "../overview.md". */
  target: string;
  /** Resolved doc-tree-relative path, posix separators, e.g. "overview.md". */
  resolved: string;
  /** 1-based line of the link within the page. */
  line: number;
}

/** Freshness of one doc link. Missing target = broken. */
export type LinkState = 'fresh' | 'broken';

/** '' when fresh; why the link is stale otherwise. */
export type LinkReason = '' | 'doc link target missing';

export interface LinkCheck {
  state: LinkState;
  reason: LinkReason;
}

/** Links with a URL scheme (https:, mailto:, …) point outside the tree. */
const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve `target` (as written in page `pagePath` under doc root
 * `docRoot`) to a doc-tree-relative path, or undefined when the link
 * is not a doc link: external URL, same-page fragment, anchor, image,
 * or resolving outside the doc tree.
 */
function resolveDocLink(target: string, pagePath: string, docRoot: string): string | undefined {
  if (EXTERNAL_RE.test(target)) return undefined;
  const file = target.split('#')[0]; // `other.md#section` targets other.md
  if (file === '') return undefined; // `#section` — same page
  // Resolve as the Reader's renderer does: relative to the page's real
  // directory inside the doc tree — not naively from the doc root.
  const pageDir = path.posix.dirname(path.posix.join(toPosix(docRoot), toPosix(pagePath)));
  const real = path.posix.normalize(path.posix.join(pageDir, file));
  if (real === '' || real === '..' || real.startsWith('../') || path.posix.isAbsolute(real)) {
    return undefined; // outside the doc tree
  }
  const root = toPosix(docRoot);
  if (root === '.') return real;
  if (real !== root && !real.startsWith(`${root}/`)) return undefined;
  return real === root ? undefined : real.slice(root.length + 1); // the tree root itself is not a page
}

export function parseDocLinks(markdown: string, pagePath: string, docRoot: string): DocLink[] {
  const links: DocLink[] = [];
  for (const link of parseMarkdownLinks(markdown)) {
    if (link.index > 0 && markdown[link.index - 1] === '!') continue; // image, not a page link
    if (link.title && parseAnchorTitle(link.title)) continue; // an anchor: URL never parsed
    const resolved = resolveDocLink(link.target, pagePath, docRoot);
    if (!resolved) continue;
    links.push({ target: link.target, resolved, line: link.line });
  }
  return links;
}

export function checkDocLink(link: DocLink, root: string, docRoot: string): LinkCheck {
  if (!existsSync(path.join(root, docRoot, link.resolved))) {
    return { state: 'broken', reason: 'doc link target missing' };
  }
  return { state: 'fresh', reason: '' };
}
