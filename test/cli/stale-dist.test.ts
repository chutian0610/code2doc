import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { buildCli, copyFixture, repoRoot, run, tsFixture } from './helpers.js';

/**
 * Build-staleness self-check: a build older than its own sources reports
 * from an extractor that is not the code it reads like. Read vs write
 * asymmetry — status advises (never a gate), init and refresh refuse
 * (fingerprints signed by an older build are wrong data, not advice).
 * The fake is an mtime on the real repo's src/cli.ts: nothing in src/
 * consumes mtimes, and afterEach puts it back.
 */

const SOURCE = path.join(repoRoot, 'src/cli.ts');

let saved: { atime: Date; mtime: Date } | undefined;

/** Pretend the sources were touched after the last build. */
function fakeStaleSources(): void {
  const st = statSync(SOURCE);
  saved = { atime: st.atime, mtime: st.mtime };
  const future = new Date(Date.now() + 60_000);
  utimesSync(SOURCE, future, future);
}

describe('build-staleness advisory', () => {
  beforeAll(buildCli);

  afterEach(() => {
    if (saved) utimesSync(SOURCE, saved.atime, saved.mtime);
    saved = undefined;
  });

  it('a current build: no note, status exit untouched', () => {
    const dir = copyFixture(tsFixture, 'code2doc-stale-fresh-');
    run(['init'], dir);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).note).toBeUndefined();
  });

  it('an older build: status carries the note and the exit tier is unchanged', () => {
    const dir = copyFixture(tsFixture, 'code2doc-stale-status-');
    run(['init'], dir);
    fakeStaleSources();

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0); // advisory never changes gates
    expect(JSON.parse(stdout).note).toBe(
      'dist is older than src — rebuild (npm run build) before trusting this report',
    );

    const human = run(['status'], dir);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('→ dist is older than src');
  });

  it('an older build: refresh and init refuse — exit 3, rebuild demanded', () => {
    const dir = copyFixture(tsFixture, 'code2doc-stale-write-');
    run(['init'], dir);
    fakeStaleSources();

    const refresh = run(['refresh'], dir);
    expect(refresh.code).toBe(3);
    expect(refresh.stderr).toContain('rebuild (npm run build)');

    const init = run(['init'], dir);
    expect(init.code).toBe(3);
    expect(init.stderr).toContain('rebuild (npm run build)');
  });
});
