import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type PageType = 'overview' | 'module' | 'flow' | 'howto' | 'reference';

/** One entry of the manifest: a page that should exist, and its type. */
export interface PageEntry {
  /** Path relative to docRoot, e.g. "modules/parser.md". */
  path: string;
  type: PageType;
  /** For module pages: the source module (directory) this page documents. */
  module?: string;
}

export interface Manifest {
  pages: PageEntry[];
}

export function manifestPath(root: string, docRoot: string): string {
  return path.join(root, docRoot, 'manifest.json');
}

export function emptyManifest(): Manifest {
  return { pages: [] };
}

export function loadManifest(root: string, docRoot: string): Manifest | undefined {
  const file = manifestPath(root, docRoot);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

export function saveManifest(root: string, docRoot: string, manifest: Manifest): void {
  const file = manifestPath(root, docRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
