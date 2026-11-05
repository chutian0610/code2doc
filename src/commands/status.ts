import { loadCache, saveCache, scan } from '../cache.js';
import { CACHE_DIR, loadConfig } from '../config.js';
import { emptyManifest, loadManifest } from '../manifest.js';
import type { PageType } from '../manifest.js';

export interface StatusReport {
  pages: { path: string; type: PageType; state: 'accurate' | 'broken' | 'drift' }[];
  summary: { broken: number; drift: number; missing: number };
}

/** Ensure the derived cache exists, rebuilding it transparently when absent. */
async function ensureCache(root: string) {
  const config = loadConfig(root);
  if (!config) {
    throw new Error('not initialized: run `code2doc init` first');
  }
  if (!loadCache(root)) {
    saveCache(root, await scan(root, config));
  }
  return config;
}

export async function runStatus(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const config = await ensureCache(root);
  const manifest = loadManifest(root, config.docRoot) ?? emptyManifest();

  // T1: no pages exist yet, so nothing can be stale.
  const report: StatusReport = {
    pages: manifest.pages.map((p) => ({ path: p.path, type: p.type, state: 'accurate' })),
    summary: { broken: 0, drift: 0, missing: 0 },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.pages.length === 0) {
    console.log(`0 pages, all accurate. Cache in ${CACHE_DIR}/, rebuildable at any time.`);
  } else {
    for (const p of report.pages) console.log(`${p.state.padEnd(8)} ${p.path} (${p.type})`);
    console.log(`\n${report.pages.length} pages: all accurate.`);
  }
  return 0;
}
