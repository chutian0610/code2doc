import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staleBuildNote } from '../src/commands/common.js';

/**
 * Unit seams for the build-staleness advisory: the pure comparison over a
 * shaped pkg root, with the dev-checkout gate (no src/, no dist/) as its
 * negative space. The CLI suites cover composition — status carrying the
 * note, refresh and init refusing (stale-dist.test.ts).
 */

/** A fake checkout: src/ and dist/ trees whose mtimes the test sets directly. */
function fakeCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'code2doc-staleness-'));
  mkdirSync(path.join(root, 'src/nested'), { recursive: true });
  mkdirSync(path.join(root, 'dist/commands'), { recursive: true });
  writeFileSync(path.join(root, 'src/nested/a.ts'), 'export {};\n', 'utf8');
  writeFileSync(path.join(root, 'dist/commands/a.js'), 'export {};\n', 'utf8');
  return root;
}

const touch = (file: string, ms: number): void =>
  utimesSync(file, new Date(ms), new Date(ms));

describe('staleBuildNote', () => {
  it('a src file newer than every dist file → the advisory', () => {
    const root = fakeCheckout();
    touch(path.join(root, 'dist/commands/a.js'), 1_000);
    touch(path.join(root, 'src/nested/a.ts'), 2_000);
    expect(staleBuildNote(root)).toBe(
      'dist is older than src — rebuild (npm run build) before trusting this report',
    );
  });

  it('a fresh build (dist newer) → no advisory', () => {
    const root = fakeCheckout();
    touch(path.join(root, 'src/nested/a.ts'), 1_000);
    touch(path.join(root, 'dist/commands/a.js'), 2_000);
    expect(staleBuildNote(root)).toBeUndefined();
  });

  it('the newest file on each side decides — deep subdirs count', () => {
    const root = fakeCheckout();
    touch(path.join(root, 'src/nested/a.ts'), 1_000);
    writeFileSync(path.join(root, 'src/shallow.ts'), 'export {};\n', 'utf8');
    touch(path.join(root, 'src/shallow.ts'), 500);
    touch(path.join(root, 'dist/commands/a.js'), 2_000);
    expect(staleBuildNote(root)).toBeUndefined();
  });

  it('no src/ → the check cannot apply (published package ships dist alone)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code2doc-staleness-pkg-'));
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'dist/cli.js'), 'export {};\n', 'utf8');
    touch(path.join(root, 'dist/cli.js'), 1_000);
    expect(staleBuildNote(root)).toBeUndefined();
  });

  it('no dist/ at all → no advisory (a separate failure, not this one)', () => {
    const root = fakeCheckout();
    touch(path.join(root, 'src/nested/a.ts'), 2_000);
    expect(staleBuildNote(root)).toBeUndefined();
  });
});
