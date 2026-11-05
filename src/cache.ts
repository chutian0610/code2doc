import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { CACHE_FILE } from './config.js';
import type { Code2docConfig } from './config.js';
import { extractorForFile } from './extractor/registry.js';
import type { SymbolRecord } from './extractor/types.js';

/** Derived state: file hashes + extracted symbols. Rebuildable at any time. */
export interface CacheData {
  version: 1;
  files: Record<string, { hash: string; symbols: SymbolRecord[] }>;
}

export function fileHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Parse every included file and build the symbol index. */
export async function scan(root: string, config: Code2docConfig): Promise<CacheData> {
  const files = await glob(config.include, {
    cwd: root,
    ignore: config.exclude,
    dot: false,
  });
  const cache: CacheData = { version: 1, files: {} };
  for (const raw of files.sort()) {
    const rel = toPosix(raw);
    const extractor = extractorForFile(rel);
    if (!extractor) continue;
    const code = readFileSync(path.join(root, rel), 'utf8');
    const symbols = await extractor.extract(code, rel);
    cache.files[rel] = { hash: fileHash(code), symbols };
  }
  return cache;
}

export function loadCache(root: string): CacheData | undefined {
  const file = path.join(root, CACHE_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as CacheData;
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
