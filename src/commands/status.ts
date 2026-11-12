import { readFileSync } from 'node:fs';
import path from 'node:path';
import { anchorVerdict, checkAnchor, parseAnchors, renameCandidates, worse } from '../anchors.js';
import type { AnchorReason, AnchorState } from '../anchors.js';
import { loadCache, saveCache, scan, allSymbols } from '../cache.js';
import type { CacheData } from '../cache.js';
import { CACHE_DIR, loadConfig } from '../config.js';
import { checkDocLink, parseDocLinks } from '../links.js';
import type { LinkReason, LinkState } from '../links.js';
import { loadManifest, emptyManifest, validateManifest } from '../manifest.js';
import type { PageEntry, PageType } from '../manifest.js';
import { dirOf, normalizeModuleDir } from '../paths.js';
import { symbolId } from '../extractor/types.js';
import { buildBaseline } from '../ripple.js';
import type { Baseline, Ripple } from '../ripple.js';

/** A page's state is the worst state among its anchors ('fresh' == Accurate). */
export type PageState = AnchorState;

export interface AnchorReport {
  /** `file#name` of the anchored symbol. */
  symbol: string;
  state: AnchorState;
  reason: AnchorReason;
  /**
   * Stale callees under the anchor since the last status, with their
   * propagation paths. Empty unless the anchor itself is fresh — a
   * stale anchor is reported directly, not through its callees.
   */
  ripples: readonly Ripple[];
  /**
   * Advisory rename guesses (≤3) for a vanished symbol — pure advice,
   * never a state or an exit code. Empty for every other anchor.
   */
  candidates: string[];
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
  /** Module pages only: `file#name` of public exports with no anchor on this page. */
  missing: string[];
  /** Present when the page itself could not be checked. */
  note?: string;
}

export interface StatusReport {
  pages: PageReport[];
  /** broken/drift/ripple count pages (worst state); missing counts symbols. */
  summary: { broken: number; drift: number; ripple: number; missing: number };
}

/** Worst state wins; the ladder itself is `worse`, defined once in anchors.ts. */
function worstState(states: PageState[]): PageState {
  return states.reduce(worse, 'fresh');
}

/** Exit tier from the summary: 0 clean, 1 review (drift/ripple), 2 any broken/missing. */
function exitTier(summary: StatusReport['summary']): 0 | 1 | 2 {
  if (summary.broken > 0 || summary.missing > 0) return 2;
  if (summary.drift > 0 || summary.ripple > 0) return 1;
  return 0;
}

/**
 * The Missing signal: public exports of the mapped module that no anchor
 * on the page names. An anchor covers its symbol whatever its freshness —
 * staleness is reported separately; internal symbols never count.
 */
function missingSymbols(module: string, cache: CacheData, anchored: Set<string>): string[] {
  const dir = normalizeModuleDir(module);
  return allSymbols(cache)
    .filter(
      (s) => s.visibility === 'public' && dirOf(s.file) === dir && !anchored.has(symbolId(s.file, s.name)),
    )
    .map((s) => symbolId(s.file, s.name))
    .sort();
}

/** True when the mapped module directory has at least one indexed file. */
function moduleIndexed(module: string, cache: CacheData): boolean {
  const dir = normalizeModuleDir(module);
  return Object.keys(cache.files).some((file) => dirOf(file) === dir);
}

function reportPage(
  entry: PageEntry,
  root: string,
  docRoot: string,
  cache: CacheData,
  baseline: Baseline,
): PageReport {
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
      missing: [],
      note: 'page file missing',
    };
  }
  const anchors = parseAnchors(markdown).map((anchor) => {
    const check = checkAnchor(anchor, cache);
    // Ripple only for anchors whose own fingerprint still matches: a
    // stale anchor is reported directly, never through its callees.
    const ripples = check.state === 'fresh' ? baseline.ripplesOf(symbolId(anchor.file, anchor.name)) : [];
    const verdict = anchorVerdict(check, ripples);
    const candidates = check.state === 'broken' && check.reason === 'symbol gone'
      ? renameCandidates(anchor, cache)
      : [];
    return {
      symbol: symbolId(anchor.file, anchor.name),
      state: verdict.state,
      reason: verdict.reason,
      ripples,
      candidates,
      line: anchor.line,
    };
  });
  const links = parseDocLinks(markdown, entry.path, docRoot).map((link) => ({
    target: link.target,
    resolved: link.resolved,
    ...checkDocLink(link, root, docRoot),
    line: link.line,
  }));
  const missing =
    entry.type === 'module' && entry.module
      ? missingSymbols(entry.module, cache, new Set(anchors.map((a) => a.symbol)))
      : [];
  // A mapping that matches no indexed file would silently drop the coverage
  // guarantee — report it as loudly as any other stale claim.
  const note =
    entry.type === 'module' && entry.module && !moduleIndexed(entry.module, cache)
      ? `module directory not indexed: ${normalizeModuleDir(entry.module)}`
      : undefined;
  return {
    path: entry.path,
    type: entry.type,
    // missing is broken-severity: a doc-gap page is as untrustworthy as a stale one
    state:
      missing.length > 0 || note
        ? 'broken'
        : worstState([...anchors, ...links].map((r) => r.state)),
    anchors,
    links,
    missing,
    note,
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
    if (staleAnchors.length === 0 && brokenLinks.length === 0 && page.missing.length === 0 && !page.note) {
      continue;
    }
    lines.push('');
    lines.push(`${path.join(docRoot, page.path)} (${page.type})`);
    for (const anchor of staleAnchors) {
      lines.push(`  ${anchor.state.padEnd(7)} ${anchor.symbol} — ${anchor.reason}`);
      for (const ripple of anchor.ripples) {
        lines.push(`    ${ripple.symbol} ${ripple.state} (via ${ripple.via}, ${ripple.depth} hop${ripple.depth === 1 ? '' : 's'})`);
      }
      for (const candidate of anchor.candidates) {
        lines.push(`    → maybe ${candidate}`);
      }
    }
    for (const link of brokenLinks) {
      lines.push(`  ${link.state.padEnd(7)} ${link.target} — ${link.reason}`);
    }
    for (const symbol of page.missing) {
      lines.push(`  ${'missing'.padEnd(7)} ${symbol} — no anchor on this page`);
    }
    if (page.note) lines.push(`  ${page.note}`);
  }
  return lines;
}

function summaryLine(report: StatusReport): string {
  const { broken, drift, ripple, missing } = report.summary;
  const total = report.pages.length;
  const fresh = total - broken - drift - ripple;
  if (total === 0) {
    return `0 pages, all accurate. Cache in ${CACHE_DIR}/, rebuildable at any time.`;
  }
  if (broken === 0 && drift === 0 && ripple === 0 && missing === 0) {
    return `${total} pages: all accurate.`;
  }
  // missing counts symbols, not pages: a page can be broken and still owe anchors
  let line = `${total} pages: ${broken} broken, ${drift} drift, ${ripple} ripple, ${fresh} fresh.`;
  if (missing > 0) line += ` ${missing} missing symbols.`;
  return line;
}

export async function runStatus(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const config = loadConfig(root);
  if (!config) {
    throw new Error('not initialized: run `code2doc init` first');
  }
  // Always bring the cache to current state: anchors are compared against
  // the code as it stands now, whether or not a cache file exists.
  const previous = loadCache(root);
  const cache = await scan(root, config, previous);
  saveCache(root, cache);

  const baseline = buildBaseline(previous, cache);

  const manifest = validateManifest(loadManifest(root, config.docRoot) ?? emptyManifest());
  const pages = manifest.pages.map((entry) =>
    reportPage(entry, root, config.docRoot, cache, baseline),
  );
  const report: StatusReport = {
    pages,
    summary: {
      broken: pages.filter((p) => p.state === 'broken').length,
      drift: pages.filter((p) => p.state === 'drift').length,
      ripple: pages.filter((p) => p.state === 'ripple').length,
      missing: pages.reduce((count, page) => count + page.missing.length, 0),
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
  return exitTier(report.summary);
}
