import path from 'node:path';
import { createTsExtractor } from './ts.js';
import type { Extractor } from './types.js';

/**
 * The language registry. Adding a language = appending one extractor here;
 * the rest of the core only ever talks to the Extractor interface.
 * One shared instance per language (stateless; wasm loading is cached internally).
 */
const EXTRACTORS: Extractor[] = [createTsExtractor()];

export function extractorForFile(file: string, list: Extractor[] = EXTRACTORS): Extractor | undefined {
  const ext = path.extname(file).toLowerCase();
  return list.find((e) => e.extensions.includes(ext));
}
