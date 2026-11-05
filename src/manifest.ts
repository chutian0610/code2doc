import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The five page types, in spec order. The type decides the checking policy. */
export const PAGE_TYPES = ['overview', 'module', 'flow', 'howto', 'reference'] as const;

export type PageType = (typeof PAGE_TYPES)[number];

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

function isPageType(value: unknown): value is PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value);
}

/**
 * A manifest is repo content written by the Operator; a shape violation
 * is a tool failure, not a staleness report. Throws naming the offender.
 */
export function validateManifest(manifest: Manifest): Manifest {
  if (!manifest || !Array.isArray(manifest.pages)) {
    throw new Error('manifest: "pages" must be an array of page entries');
  }
  for (const page of manifest.pages) {
    if (typeof page?.path !== 'string' || page.path === '') {
      throw new Error('manifest: every page needs a non-empty "path"');
    }
    if (!isPageType(page.type)) {
      throw new Error(
        `manifest: unknown type ${JSON.stringify(page.type)} for ${page.path} (expected one of ${PAGE_TYPES.join(', ')})`,
      );
    }
  }
  return manifest;
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
