import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAnchorTitle, parseMarkdownLinks } from '../anchors.js';
import { emptyManifest, loadManifest, validateManifest } from '../manifest.js';
import type { PageEntry } from '../manifest.js';
import { currentCache } from './common.js';

export interface RefreshEntry {
  /** Path relative to docRoot, as declared in the manifest. */
  page: string;
  /** 1-based line of the anchor within the page (0: the page itself). */
  line: number;
  /** `file#name` of the anchored symbol. */
  symbol: string;
}

export interface UnresolvedEntry {
  /** Path relative to docRoot, as declared in the manifest. */
  page: string;
  /** 1-based line of the anchor within the page (0: the page itself). */
  line: number;
  /** `file#name` of the anchored symbol; absent when the page itself is the problem. */
  symbol?: string;
  /** Why refresh refused: the claim needs a rewrite, not a new fingerprint. */
  reason: string;
}

export interface RefreshReport {
  refreshed: RefreshEntry[];
  unresolved: UnresolvedEntry[];
}

/** Human line for an entry: `page:line`, or bare page for page-level findings. */
function where(entry: RefreshEntry | UnresolvedEntry): string {
  return entry.line > 0 ? `${entry.page}:${entry.line}` : entry.page;
}

/**
 * Re-sign every manifest-declared anchor whose claim was reviewed and still
 * holds — Drift only (ADR-0007): a signature change or a vanished symbol is
 * reported unresolved and left as written, because Broken is resolved by
 * rewriting the claim, never by refreshing over it. Reviewed drift on the
 * same page still re-signs; the unresolved anchors fail the run regardless.
 */
export async function runRefresh(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const { config, cache } = await currentCache(root);

  const manifest = validateManifest(loadManifest(root, config.docRoot) ?? emptyManifest());
  const refreshed: RefreshEntry[] = [];
  const unresolved: UnresolvedEntry[] = [];

  for (const entry of manifest.pages as PageEntry[]) {
    const abs = path.join(root, config.docRoot, entry.path);
    let markdown: string;
    try {
      markdown = readFileSync(abs, 'utf8');
    } catch {
      unresolved.push({ page: entry.path, line: 0, reason: 'page file missing' });
      continue;
    }
    let pageRefreshed = 0;
    for (const link of parseMarkdownLinks(markdown)) {
      if (!link.title) continue;
      const payload = parseAnchorTitle(link.title);
      if (!payload) continue; // an ordinary link, not an anchor
      const symbol = cache.files[payload.file]?.symbols.find((s) => s.name === payload.name);
      const ref = { page: entry.path, line: link.line, symbol: `${payload.file}#${payload.name}` };
      if (!symbol) {
        unresolved.push({ ...ref, reason: 'symbol gone' });
        continue;
      }
      const { signature, body } = symbol.fingerprint;
      if (signature !== payload.fingerprint.signature) {
        unresolved.push({ ...ref, reason: 'signature changed' });
        continue;
      }
      if (body === payload.fingerprint.body) continue; // already current
      const title = `c2d:${payload.file}#${payload.name}:${signature}.${body}`;
      // the quoted title is exact and unique enough; replaceAll also fixes a
      // payload the page repeats verbatim
      markdown = markdown.replaceAll(`"${link.title}"`, `"${title}"`);
      refreshed.push(ref);
      pageRefreshed++;
    }
    if (pageRefreshed > 0) writeFileSync(abs, markdown, 'utf8');
  }

  if (json) {
    console.log(JSON.stringify({ refreshed, unresolved } satisfies RefreshReport, null, 2));
  } else {
    const perPage = new Map<string, number>();
    for (const r of refreshed) perPage.set(r.page, (perPage.get(r.page) ?? 0) + 1);
    for (const [page, n] of perPage) console.log(`${page}: ${n} anchor(s) refreshed`);
    if (refreshed.length === 0 && unresolved.length === 0) console.log('all anchors already current');
    for (const u of unresolved) {
      const head = u.symbol ? `${where(u)} ${u.symbol}` : where(u);
      console.error(`${head} — ${u.reason}`);
    }
    if (unresolved.length > 0) {
      console.error(`${unresolved.length} anchor(s) unresolved — rewrite those claims by hand`);
    }
  }
  return unresolved.length > 0 ? 2 : 0;
}
