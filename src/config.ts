import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Code2docConfig {
  /** Glob patterns of source files to index. */
  include: string[];
  /** Glob patterns to exclude. */
  exclude: string[];
  /** Root directory of the doc tree, relative to repo root. */
  docRoot: string;
  /** Language generated docs are written in. */
  language: string;
}

export const CONFIG_FILE = 'code2doc.config.json';
export const CACHE_DIR = '.code2doc';
export const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');

export function defaultConfig(): Code2docConfig {
  return {
    include: ['**/*.{ts,tsx,js,jsx,mjs,cjs,java}'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'docs/**',
      `${CACHE_DIR}/**`,
      'coverage/**',
      '**/*.d.ts',
    ],
    docRoot: 'docs',
    language: 'en',
  };
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

export function loadConfig(root: string): Code2docConfig | undefined {
  const file = configPath(root);
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Code2docConfig>;
  const defaults = defaultConfig();
  return {
    include: raw.include ?? defaults.include,
    exclude: raw.exclude ?? defaults.exclude,
    docRoot: raw.docRoot ?? defaults.docRoot,
    language: raw.language ?? defaults.language,
  };
}

export function saveConfig(root: string, config: Code2docConfig): void {
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
