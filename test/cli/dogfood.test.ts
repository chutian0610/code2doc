import { describe, it, expect, beforeAll } from 'vitest';
import { buildCli, repoRoot, run } from './helpers';

interface Page {
  type: string;
  state: string;
}

/**
 * T6 dogfood: code2doc's own repo is its first documented codebase.
 * This test guards the green state — if a code change breaks, drifts or
 * widens a gap in the dogfood tree, the suite says so before the repo
 * ships stale docs about itself.
 */
describe('code2doc dogfood (T6)', () => {
  let code = -1;
  let pages: Page[] = [];
  let summary: Record<string, number> = {};

  beforeAll(() => {
    buildCli();
    const result = run(['status', '--json'], repoRoot);
    code = result.code;
    const report = JSON.parse(result.stdout);
    pages = report.pages;
    summary = report.summary;
  });

  it('status on this repo: exit 0, zero signals', () => {
    expect(code).toBe(0);
    expect(summary).toEqual({ broken: 0, drift: 0, missing: 0 });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((p) => p.state === 'fresh')).toBe(true);
  });

  it('the dogfood tree covers overview, module, flow and howto pages', () => {
    const types = new Set(pages.map((p) => p.type));
    for (const type of ['overview', 'module', 'flow', 'howto']) {
      expect(types.has(type), `no ${type} page declared in docs/manifest.json`).toBe(true);
    }
  });
});
