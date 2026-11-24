import { loadCache, saveCache, scan } from '../cache.js';
import type { CacheData } from '../cache.js';
import { loadConfig } from '../config.js';
import type { Code2docConfig } from '../config.js';

export interface CurrentCache {
  config: Code2docConfig;
  /** The cache as of the last status, if one exists — the ripple baseline is built from it. */
  previous: CacheData | undefined;
  cache: CacheData;
}

/**
 * The shared preamble of the reporting commands: no config file is a tool
 * failure, and the cache is always brought to current state before anything
 * is compared — fingerprint checks, ripple baselines and re-signs all
 * measure the code as it stands now.
 */
export async function currentCache(root: string): Promise<CurrentCache> {
  const config = loadConfig(root);
  if (!config) {
    throw new Error('not initialized: run `code2doc init` first');
  }
  const previous = loadCache(root);
  const cache = await scan(root, config, previous);
  saveCache(root, cache);
  return { config, previous, cache };
}
