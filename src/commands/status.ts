import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkAnchor, parseAnchors } from '../anchors.js';
import type { AnchorReason, AnchorState } from '../anchors.js';
import { loadCache, saveCache, scan } from '../cache.js';
import type { CacheData } from '../cache.js';
import { CACHE_DIR, loadConfig } from '../config.js';
import { checkDocLink, parseDocLinks } from '../links.js';
import type { LinkReason, LinkState } from '../links.js';
import { loadManifest, emptyManifest, validateManifest } from '../manifest.js';
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

export interface LinkReport {
  /** Link target exactly as written in the page. */
  target: string;
  /** Resolved doc-tree-relative path. */
  resolved: string;
  state: LinkState;
  reason: LinkReason;
  /** 1-based line of the link within the page. */
  line: number;
}

export interface PageReport {
  /** Path relative to docRoot, as declared in the manifest. */
  path: string;
  type: PageType;
  state: PageState;
  anchors: AnchorReport[];
  links: LinkReport[];
  /** Present when the page itself could not be checked. */
  note?: string;
}

export interface StatusReport {
  pages: PageReport[];
  summary: { broken: number; drift: number; missing: number };
}

/** Worst state wins: broken > drift > fresh. Links share the ladder. */
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
    return {
      path: entry.path,
      type: entry.type,
      state: 'broken',
      anchors: [],
      links: [],
      note: 'page file missing',
    };
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
  const links = parseDocLinks(markdown, entry.path, docRoot).map((link) => ({
    target: link.target,
    resolved: link.resolved,
    ...checkDocLink(link, root, docRoot),
    line: link.line,
  }));
  return {
    path: entry.path,
    type: entry.type,
    state: worstState([...anchors, ...links].map((r) => r.state)),
    anchors,
    links,
  };
}

/** Default output: one freshness line per declared page — the whole tree at a glance. */
function tableLines(report: StatusReport, docRoot: string): string[] {
  const lines: string[] = [];
  if (report.pages.length === 0) return lines;
  lines.push(`${'STATE'.padEnd(7)} ${'TYPE'.padEnd(11)}PAGE`);
  for (const page of report.pages) {
    lines.push(`${page.state.padEnd(7)} ${page.type.padEnd(11)}${path.join(docRoot, page.path)}`);
  }
  return lines;
}

/** Drill-down: every stale anchor, broken doc link and missing page, with reasons. */
function detailLines(report: StatusReport, docRoot: string): string[] {
  const lines: string[] = [];
  for (const page of report.pages) {
    const staleAnchors = page.anchors.filter((a) => a.state !== 'fresh');
    const brokenLinks = page.links.filter((l) => l.state !== 'fresh');
    if (staleAnchors.length === 0 && brokenLinks.length === 0 && !page.note) continue;
    lines.push('');
    lines.push(`${path.join(docRoot, page.path)} (${page.type})`);
    for (const anchor of staleAnchors) {
      lines.push(`  ${anchor.state.padEnd(7)} ${anchor.symbol} — ${anchor.reason}`);
    }
    for (const link of brokenLinks) {
      lines.push(`  ${link.state.padEnd(7)} ${link.target} — ${link.reason}`);
    }
    if (page.note) lines.push(`  ${page.note}`);
  }
  return lines;
}

function summaryLine(report: StatusReport): string {
  const { broken, drift } = report.summary;
  const total = report.pages.length;
  const fresh = total - broken - drift;
  if (total === 0) {
    return `0 pages, all accurate. Cache in ${CACHE_DIR}/, rebuildable at any time.`;
  }
  if (broken === 0 && drift === 0) {
    return `${total} pages: all accurate.`;
  }
  return `${total} pages: ${broken} broken, ${drift} drift, ${fresh} fresh.`;
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

  const manifest = validateManifest(loadManifest(root, config.docRoot) ?? emptyManifest());
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
    for (const line of [
      ...tableLines(report, config.docRoot),
      ...detailLines(report, config.docRoot),
      '',
      summaryLine(report),
    ]) {
      console.log(line);
    }
  }
  if (report.summary.broken > 0) return 2;
  if (report.summary.drift > 0) return 1;
  return 0;
}
