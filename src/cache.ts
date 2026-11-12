import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { CACHE_FILE } from './config.js';
import type { Code2docConfig } from './config.js';
import { extractorForFile } from './extractor/registry.js';
import type { FileRefs, SymbolRecord } from './extractor/types.js';
import { noRefs } from './extractor/types.js';
import { toPosix } from './paths.js';

/** Derived state: file hashes + extracted symbols + call refs. Rebuildable at any time. */
export interface CacheData {
  /**
   * Bumped whenever the fingerprint algorithm or the cached shape
   * changes: a cache from a different algorithm would silently poison
   * anchor verification (v3 added call refs; v4 retagged import
   * bindings, ADR-0004/0005).
   */
  version: 4;
  files: Record<string, { hash: string; symbols: SymbolRecord[]; refs: FileRefs }>;
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
  const cache: CacheData = { version: 4, files: {} };
  for (const raw of files.sort()) {
    const rel = toPosix(raw);
    const extractor = extractorForFile(rel);
    if (!extractor) continue;
    const code = readFileSync(path.join(root, rel), 'utf8');
    const hash = fileHash(code);
    const prev = previous?.files[rel];
    const reuse = prev && prev.hash === hash;
    const symbols = reuse ? prev.symbols : await extractor.extract(code, rel);
    const refs = reuse ? prev.refs : ((await extractor.extractRefs?.(code, rel)) ?? noRefs());
    cache.files[rel] = { hash, symbols, refs };
  }
  return cache;
}

export function loadCache(root: string): CacheData | undefined {
  const file = path.join(root, CACHE_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as CacheData;
  if (parsed.version !== 4) return undefined; // foreign algorithm: rebuild
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
