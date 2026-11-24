import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchorLink, buildCli, copyFixture, declarePages, run, tsFixture, writePage } from './helpers.js';
import type { Sym } from './helpers.js';

/** init the fixture, then declare a reference page anchoring `greet` — the authoring flow. */
function setupWithAnchor(dir: string): Sym {
  const report = JSON.parse(run(['init'], dir).stdout);
  const greet = report.symbols.find((s: Sym) => s.name === 'greet');
  if (!greet) throw new Error('greet not in init report');
  writePage(dir, 'module.md', `# claims\n\n- ${anchorLink(greet)} does its thing.\n`);
  declarePages(dir, [{ path: 'module.md', type: 'reference' }]);
  return greet;
}

const GREETER = `export class Greeter {
  greeting: string;
  constructor(g: string) {
    this.greeting = g;
  }
  greet(): string {
    return this.greeting;
  }
}`;

const GREET_DRIFTED = `export function greet(name: string): string {
  return 'hi ' + name;
}
${GREETER}`;

/** `a` imports and calls `helper`: the one-hop chain whose drift ripples `a`. */
const CHAIN_TS = `import { helper } from './helper';
export function a(): string {
  return helper();
}
`;
const HELPER_FRESH = `export function helper(): string {
  return 'hi';
}
`;
const HELPER_DRIFT = `export function helper(): string {
  return 'hello';
}
`;

describe('status --fail-on gate', () => {
  beforeAll(buildCli);

  it('a broken repo still passes when broken is not in the gate', () => {
    const dir = copyFixture(tsFixture, 'code2doc-gate-');
    setupWithAnchor(dir);
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREETER}\n`, 'utf8'); // greet gone

    expect(run(['status', '--json'], dir).code).toBe(2); // default gate: broken tiers at 2

    const { code, stdout } = run(['status', '--json', '--fail-on', 'drift'], dir);
    expect(code).toBe(0); // contraction: unselected classes never tier the run
    // the report itself is unchanged — the gate shapes the exit code, never the findings
    expect(JSON.parse(stdout).summary.broken).toBe(1);
  });

  it('a drift repo tiers at 1 only when drift is in the gate', () => {
    const dir = copyFixture(tsFixture, 'code2doc-gate-');
    setupWithAnchor(dir);
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREET_DRIFTED}\n`, 'utf8'); // body-only change

    expect(run(['status', '--json'], dir).code).toBe(1); // default gate
    expect(run(['status', '--json', '--fail-on', 'drift'], dir).code).toBe(1);
    expect(run(['status', '--json', '--fail-on', 'broken'], dir).code).toBe(0);
    expect(run(['status', '--json', '--fail-on', 'broken,drift'], dir).code).toBe(1);
    expect(run(['status', '--json', '--fail-on', 'all'], dir).code).toBe(1); // all ≡ default
  });

  it('ripple tiers at 1 only when ripple is in the gate', () => {
    // Ripple is a since-last-status signal: it fires on the *first* status
    // after the edit, so each gate variant gets its own fresh repo.
    function rippledRepo(): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-gate-'));
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'chain.ts'), CHAIN_TS, 'utf8');
      writeFileSync(path.join(dir, 'src', 'helper.ts'), HELPER_FRESH, 'utf8');
      const report = JSON.parse(run(['init'], dir).stdout);
      const a = report.symbols.find((s: Sym) => s.name === 'a');
      writePage(dir, 'flows/chain.md', `# the chain\n\n- ${anchorLink(a)} is the entry\n`);
      declarePages(dir, [{ path: 'flows/chain.md', type: 'flow' }]);
      writeFileSync(path.join(dir, 'src', 'helper.ts'), HELPER_DRIFT, 'utf8'); // body edit under a fresh anchor
      return dir;
    }

    const first = run(['status', '--json'], rippledRepo());
    expect(first.code).toBe(1); // ripple tiers by default
    expect(JSON.parse(first.stdout).summary.ripple).toBe(1);
    expect(run(['status', '--json', '--fail-on', 'drift'], rippledRepo()).code).toBe(0);
    expect(run(['status', '--json', '--fail-on', 'ripple'], rippledRepo()).code).toBe(1);
  });

  it('missing gates at 2 and contracts away cleanly', () => {
    const dir = copyFixture(tsFixture, 'code2doc-gate-');
    run(['init'], dir);
    // a module page that anchors nothing: every public export of src is missing
    writePage(dir, 'module.md', '# src module\n');
    declarePages(dir, [{ path: 'module.md', type: 'module', module: 'src' }]);

    expect(run(['status', '--json'], dir).code).toBe(2); // missing is broken-severity
    expect(run(['status', '--json', '--fail-on', 'drift'], dir).code).toBe(0);
    expect(run(['status', '--json', '--fail-on', 'missing'], dir).code).toBe(2);
  });

  it('accepts the equals form (--fail-on=classes)', () => {
    const dir = copyFixture(tsFixture, 'code2doc-gate-');
    setupWithAnchor(dir);
    writeFileSync(path.join(dir, 'src', 'greet.ts'), `${GREETER}\n`, 'utf8'); // greet gone

    expect(run(['status', '--json', '--fail-on=drift'], dir).code).toBe(0);
    expect(run(['status', '--json', '--fail-on=all'], dir).code).toBe(2);
  });

  it('a malformed flag is a tool failure, never a silent no-gate', () => {
    const dir = copyFixture(tsFixture, 'code2doc-gate-');
    run(['init'], dir);

    // unknown class
    const unknown = run(['status', '--json', '--fail-on', 'stale'], dir);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toMatch(/unknown --fail-on class "stale"/);
    // empty list: contraction to nothing would gate nothing while claiming to
    expect(run(['status', '--json', '--fail-on', ','], dir).code).toBe(3);
    // repeated flag: the silently-dropped one would mislead the CI author
    const repeated = run(['status', '--json', '--fail-on', 'drift', '--fail-on', 'broken'], dir);
    expect(repeated.code).toBe(3);
    expect(repeated.stderr).toMatch(/more than once/);
  });
});
