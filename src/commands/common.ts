import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Flags must be known: a typo'd flag silently changes what the command
 * checks or writes — the one failure mode this tool never tolerates.
 * Flags in `withValues` consume the next argument as their value; anything
 * else positional or unknown is a tool failure. Callers parse their own
 * flags first, so a malformed value fails with its own, sharper message.
 */
export function requireKnownFlags(args: string[], withValues: string[] = [], allowed: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (withValues.includes(arg)) {
      i++; // the value is positional, even when it looks like a flag
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument "${arg}"`);
    }
    const name = `--${arg.slice(2).split('=')[0]}`;
    if (!allowed.includes(name) && !withValues.includes(name)) {
      throw new Error(`unknown flag "${arg}"`);
    }
  }
}

/** Newest mtime under `dir` (recursive) among files ending in `ext`; 0 when there are none. */
function newestMtime(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!rel.endsWith(ext)) continue;
    const mtime = statSync(path.join(dir, rel)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** Package root of the running binary, derived from this module's compiled home (dist/commands/). */
function selfPkgRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** True when some source compiled into dist has been touched since the last build. */
function buildOlderThanSources(pkgRoot: string): boolean {
  const src = newestMtime(path.join(pkgRoot, 'src'), '.ts');
  if (src === 0) return false; // not a dev checkout: the published package ships dist alone
  const dist = newestMtime(path.join(pkgRoot, 'dist'), '.js');
  return dist > 0 && src > dist;
}

/**
 * Advisory when the running build predates its own sources — the extractor
 * behind this report is not the code it reads like. Dev checkouts only; the
 * check cannot apply (and returns undefined) wherever src/ or dist/ is
 * missing. "Stale" is taken: in this tool's vocabulary it names a doc whose
 * anchor no longer matches the code, never a build.
 */
export function staleBuildNote(pkgRoot: string = selfPkgRoot()): string | undefined {
  return buildOlderThanSources(pkgRoot)
    ? 'dist is older than src — rebuild (npm run build) before trusting this report'
    : undefined;
}

/**
 * The write commands' hard version of the same check: init and refresh sign
 * fingerprints into the doc tree, and fingerprints signed by an older build
 * are wrong data, not weak advice — refuse rather than write.
 */
export function requireFreshBuild(): void {
  if (buildOlderThanSources(selfPkgRoot())) {
    throw new Error(
      'dist is older than src — rebuild (npm run build) first: init and refresh sign fingerprints into the doc tree, and an older build signs the wrong ones',
    );
  }
}
