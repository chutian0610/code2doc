#!/usr/bin/env node
/**
 * Dogfood helper: rewrite every resolvable anchor's fingerprint in the
 * manifest-declared pages to the current one — the "claim still holds"
 * half of Drift/Ripple maintenance, without hand-editing hex strings.
 *
 * Only the payload hashes change: text, target, file and name stay as
 * written, so a moved or renamed symbol (a genuine rewrite, not a
 * refresh) stays reported by `status`. Anchors that no longer resolve
 * are listed and fail the run; already-current fingerprints make it a
 * no-op, so it is safe to run at any time.
 *
 * Usage: npm run refresh-anchors   (from the root of the documented repo)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAnchorTitle, parseMarkdownLinks } from '../dist/anchors.js';
import { loadCache, saveCache, scan } from '../dist/cache.js';
import { loadConfig } from '../dist/config.js';
import { emptyManifest, loadManifest, validateManifest } from '../dist/manifest.js';

const root = process.cwd();
const config = loadConfig(root);
if (!config) {
  console.error('not initialized: run `code2doc init` first');
  process.exit(2);
}

// Same stance as `status`: always bring the cache to current state first,
// so the hashes written below are the code as it stands now.
const cache = await scan(root, config, loadCache(root));
saveCache(root, cache);

const manifest = validateManifest(loadManifest(root, config.docRoot) ?? emptyManifest());
let refreshed = 0;
const touched = [];
const unresolved = [];
for (const entry of manifest.pages) {
  const abs = path.join(root, config.docRoot, entry.path);
  let markdown;
  try {
    markdown = readFileSync(abs, 'utf8');
  } catch {
    unresolved.push(`${entry.path} — page file missing`);
    continue;
  }
  let pageRefreshed = 0;
  for (const link of parseMarkdownLinks(markdown)) {
    if (!link.title) continue;
    const payload = parseAnchorTitle(link.title);
    if (!payload) continue; // an ordinary link, not an anchor
    const symbol = cache.files[payload.file]?.symbols.find((s) => s.name === payload.name);
    if (!symbol) {
      unresolved.push(`${entry.path}:${link.line} ${payload.file}#${payload.name} — symbol gone`);
      continue;
    }
    const { signature, body } = symbol.fingerprint;
    if (signature === payload.fingerprint.signature && body === payload.fingerprint.body) continue;
    const title = `c2d:${payload.file}#${payload.name}:${signature}.${body}`;
    // the quoted title is exact and unique enough; replaceAll also fixes a
    // payload the page repeats verbatim
    markdown = markdown.replaceAll(`"${link.title}"`, `"${title}"`);
    pageRefreshed++;
  }
  if (pageRefreshed > 0) {
    writeFileSync(abs, markdown, 'utf8');
    touched.push(`${entry.path}: ${pageRefreshed} anchor(s) refreshed`);
    refreshed += pageRefreshed;
  }
}

for (const line of touched) console.log(line);
if (refreshed === 0 && unresolved.length === 0) console.log('all anchors already current');
for (const line of unresolved) console.error(line);
if (unresolved.length > 0) {
  console.error(`${unresolved.length} anchor(s) unresolved — rewrite those claims by hand`);
  process.exit(1);
}
