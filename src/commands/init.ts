import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, CONFIG_FILE, defaultConfig, loadConfig, saveConfig } from '../config.js';
import { allSymbols, saveCache, scan } from '../cache.js';
import { emptyManifest, loadManifest, manifestPath, saveManifest } from '../manifest.js';
import type { SymbolRecord } from '../extractor/types.js';

export interface ModuleReport {
  dir: string;
  files: number;
  publicSymbols: string[];
  internalCount: number;
}

export interface InitReport {
  configPath: string;
  manifestPath: string;
  docRoot: string;
  filesScanned: number;
  modules: ModuleReport[];
  publicCount: number;
  internalCount: number;
  symbols: SymbolRecord[];
}

const SKELETON_README = `# Documentation

This doc tree is driven by \`manifest.json\` — a page exists when the
manifest declares it, not because a file happens to live here.

Each page has a type that decides how it is checked:

- **overview** — architecture and domain, static structure
- **module** — a module's responsibilities and public interface (coverage enforced)
- **flow** — a core execution path or piece of critical logic
- **howto** — a task guide distilled from a user question
- **reference** — tabular reference material

## Anchors

Factual claims link to the code they describe; the link title carries the
symbol's fingerprint (from the \`symbols\` array \`code2doc init\` prints):

\`[greet](../src/greet.ts "c2d:src/greet.ts#greet:<signature>.<body>")\`

The URL stays a normal, clickable markdown link for Readers.
\`code2doc status\` reads the title and verifies the fingerprint against the
current code: signature changed or symbol gone → **broken**; body changed →
**drift**; still matching → fresh.

Run \`code2doc status\` to see the freshness of every declared page.
`;

function ensureGitignore(root: string): void {
  const file = path.join(root, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === `${CACHE_DIR}/`)) return;
  const next = current.endsWith('\n') || current === ''
    ? `${current}${CACHE_DIR}/\n`
    : `${current}\n${CACHE_DIR}/\n`;
  writeFileSync(file, next, 'utf8');
}

function moduleReports(symbols: SymbolRecord[], files: string[]): ModuleReport[] {
  const byDir = new Map<string, ModuleReport>();
  const dirOf = (file: string): string => {
    const idx = file.lastIndexOf('/');
    return idx === -1 ? '.' : file.slice(0, idx);
  };
  for (const file of files) {
    const dir = dirOf(file);
    const mod = byDir.get(dir) ?? { dir, files: 0, publicSymbols: [], internalCount: 0 };
    mod.files += 1;
    byDir.set(dir, mod);
  }
  for (const s of symbols) {
    const mod = byDir.get(dirOf(s.file));
    if (!mod) continue;
    if (s.visibility === 'public') mod.publicSymbols.push(s.name);
    else mod.internalCount += 1;
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export async function runInit(root: string): Promise<number> {
  const existing = loadConfig(root);
  const config = existing ?? defaultConfig();
  if (!existing) saveConfig(root, config);

  const manifest = loadManifest(root, config.docRoot) ?? emptyManifest();
  saveManifest(root, config.docRoot, manifest);

  const docReadme = path.join(root, config.docRoot, 'README.md');
  if (!existsSync(docReadme)) writeFileSync(docReadme, SKELETON_README, 'utf8');

  const cache = await scan(root, config);
  saveCache(root, cache);

  ensureGitignore(root);

  const symbols = allSymbols(cache);
  const publicSymbols = symbols.filter((s) => s.visibility === 'public');
  const report: InitReport = {
    configPath: CONFIG_FILE,
    manifestPath: path.join(config.docRoot, 'manifest.json'),
    docRoot: config.docRoot,
    filesScanned: Object.keys(cache.files).length,
    modules: moduleReports(symbols, Object.keys(cache.files)),
    publicCount: publicSymbols.length,
    internalCount: symbols.length - publicSymbols.length,
    symbols: publicSymbols,
  };
  console.log(JSON.stringify(report, null, 2));
  return 0;
}
