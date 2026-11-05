import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkAnchor, parseAnchors } from '../anchors.js';
import type { AnchorReason, AnchorState } from '../anchors.js';
import { loadCache, saveCache, scan } from '../cache.js';
import type { CacheData } from '../cache.js';
import { CACHE_DIR, loadConfig } from '../config.js';
import { loadManifest, emptyManifest } from '../manifest.js';
import type { PageEntry, PageType } from '../manifest.js';

/** A page's state is the worst state among its anchors ('fresh' == Accurate). */
export type PageState = AnchorState;

export interface AnchorReport {
  /** `file#name` of the anchored symbol. */
  symbol: string;
  state: AnchorState;
  reason: AnchorReason;
  /** 1-based line of the anchor within the page. */
  line: number;
}

export interface PageReport {
  /** Path relative to docRoot, as declared in the manifest. */
  path: string;
  type: PageType;
  state: PageState;
  anchors: AnchorReport[];
  /** Present when the page itself could not be checked. */
  note?: string;
}

export interface StatusReport {
  pages: PageReport[];
  summary: { broken: number; drift: number; missing: number };
}

/** Worst anchor state wins: broken > drift > fresh. */
function worstState(states: PageState[]): PageState {
  if (states.includes('broken')) return 'broken';
  if (states.includes('drift')) return 'drift';
  return 'fresh';
}

function reportPage(entry: PageEntry, root: string, docRoot: string, cache: CacheData): PageReport {
  const abs = path.join(root, docRoot, entry.path);
  let markdown: string;
  try {
    markdown = readFileSync(abs, 'utf8');
  } catch {
    return { path: entry.path, type: entry.type, state: 'broken', anchors: [], note: 'page file missing' };
  }
  const anchors = parseAnchors(markdown).map((anchor) => {
    const check = checkAnchor(anchor, cache);
    return {
      symbol: `${anchor.file}#${anchor.name}`,
      state: check.state,
      reason: check.reason,
      line: anchor.line,
    };
  });
  return {
    path: entry.path,
    type: entry.type,
    state: worstState(anchors.map((a) => a.state)),
    anchors,
  };
}

function humanLines(report: StatusReport, docRoot: string): string[] {
  const lines: string[] = [];
  for (const page of report.pages) {
    lines.push(`${page.state.padEnd(7)} ${path.join(docRoot, page.path)} (${page.type})`);
    for (const anchor of page.anchors) {
      if (anchor.state === 'fresh') continue;
      lines.push(`  ${anchor.state.padEnd(7)} ${anchor.symbol} — ${anchor.reason}`);
    }
    if (page.note) lines.push(`  ${page.note}`);
  }
  const { broken, drift } = report.summary;
  const total = report.pages.length;
  const fresh = total - broken - drift;
  if (total === 0) {
    lines.push(`0 pages, all accurate. Cache in ${CACHE_DIR}/, rebuildable at any time.`);
  } else if (broken === 0 && drift === 0) {
    lines.push(`\n${total} pages: all accurate.`);
  } else {
    lines.push(`\n${total} pages: ${broken} broken, ${drift} drift, ${fresh} fresh.`);
  }
  return lines;
}

export async function runStatus(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const config = loadConfig(root);
  if (!config) {
    throw new Error('not initialized: run `code2doc init` first');
  }
  // Always bring the cache to current state: anchors are compared against
  // the code as it stands now, whether or not a cache file exists.
  const cache = await scan(root, config, loadCache(root));
  saveCache(root, cache);

  const manifest = loadManifest(root, config.docRoot) ?? emptyManifest();
  const pages = manifest.pages.map((entry) =>
    reportPage(entry, root, config.docRoot, cache),
  );
  const report: StatusReport = {
    pages,
    summary: {
      broken: pages.filter((p) => p.state === 'broken').length,
      drift: pages.filter((p) => p.state === 'drift').length,
      missing: 0, // T4: the Missing signal (module pages only)
    },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of humanLines(report, config.docRoot)) console.log(line);
  }
  if (report.summary.broken > 0) return 2;
  if (report.summary.drift > 0) return 1;
  return 0;
}
