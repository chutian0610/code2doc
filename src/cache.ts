import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { CACHE_FILE } from './config.js';
import type { Code2docConfig } from './config.js';
import { extractorForFile } from './extractor/registry.js';
import type { SymbolRecord } from './extractor/types.js';
import { toPosix } from './paths.js';

/** Derived state: file hashes + extracted symbols. Rebuildable at any time. */
export interface CacheData {
  /**
   * Bumped whenever the fingerprint algorithm changes: a cache from a
   * different algorithm would silently poison anchor verification.
   */
  version: 2;
  files: Record<string, { hash: string; symbols: SymbolRecord[] }>;
}

export function fileHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Parse every included file and build the symbol index. File-level
 * change detection (ADR-0002): a file whose content hash matches the
 * previous cache keeps its extracted symbols — only changed, added or
 * removed files are (re-)parsed.
 */
export async function scan(
  root: string,
  config: Code2docConfig,
  previous?: CacheData,
): Promise<CacheData> {
  const files = await glob(config.include, {
    cwd: root,
    ignore: config.exclude,
    dot: false,
  });
  const cache: CacheData = { version: 2, files: {} };
  for (const raw of files.sort()) {
    const rel = toPosix(raw);
    const extractor = extractorForFile(rel);
    if (!extractor) continue;
    const code = readFileSync(path.join(root, rel), 'utf8');
    const hash = fileHash(code);
    const prev = previous?.files[rel];
    const symbols = prev && prev.hash === hash ? prev.symbols : await extractor.extract(code, rel);
    cache.files[rel] = { hash, symbols };
  }
  return cache;
}

export function loadCache(root: string): CacheData | undefined {
  const file = path.join(root, CACHE_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheData;
  if (parsed.version !== 2) return undefined; // foreign algorithm: rebuild
  return parsed;
}

export function saveCache(root: string, cache: CacheData): void {
  const file = path.join(root, CACHE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache), 'utf8');
}

/** All symbols across files. */
export function allSymbols(cache: CacheData): SymbolRecord[] {
  return Object.values(cache.files).flatMap((f) => f.symbols);
}
