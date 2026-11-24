import path from 'node:path';
import { createJavaExtractor } from './java.js';
import { createPythonExtractor } from './python.js';
import { createTsExtractor } from './ts.js';
import type { Extractor } from './types.js';

/**
 * The language registry. Adding a language = appending one extractor here;
 * the rest of the core only ever talks to the Extractor interface.
 * One shared instance per language (stateless; wasm loading is cached internally).
 */
const EXTRACTORS: Extractor[] = [
  createTsExtractor(),
  createJavaExtractor(),
  createPythonExtractor(),
];

export function extractorForFile(file: string, list: Extractor[] = EXTRACTORS): Extractor | undefined {
  const ext = path.extname(file).toLowerCase();
  return list.find((e) => e.extensions.includes(ext));
}

/**
 * Every extension the registered languages claim — the one source of
 * "what counts as source" for the core (the default include derives
 * from it, config.ts:21). Adding a language here is the whole story.
 */
export function claimedExtensions(list: Extractor[] = EXTRACTORS): string[] {
  return list.flatMap((e) => e.extensions);
}
