import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anchorLink, buildCli, declarePages, run, writePage } from './helpers';
import type { Sym } from './helpers';

/**
 * V2-4: rename candidates — the Operator's one-glance fix for a vanished
 * symbol. Advisory only: suggestions render under a broken anchor and
 * never touch a page state or an exit code.
 */

const GREET = `export function greet(name: string): string {
  return 'hello ' + name;
}
`;
/** greet moved wholesale to another file */
const GREET_MOVED_AWAY = `export const placeholder = 1;
`;
const HELLO = `export function greet(name: string): string {
  return 'hello ' + name;
}
`;
/** greet renamed in place, parameters untouched */
const GREET_RENAMED = `export function greet2(name: string): string {
  return 'hello ' + name;
}
`;

interface Repo {
  dir: string;
  greet: Sym;
}

/** One exported function, anchored on a module page. */
function setup(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-candidates-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src/greet.ts'), GREET, 'utf8');
  const report = JSON.parse(run(['init'], dir).stdout);
  const greet = (report.symbols as Sym[]).find((s) => s.name === 'greet')!;
  writePage(dir, 'module.md', `# src module\n\n- ${anchorLink(greet)} greets.\n`);
  declarePages(dir, [{ path: 'module.md', type: 'module', module: 'src' }]);
  expect(run(['status'], dir).code).toBe(0);
  return { dir, greet };
}

interface AnchorShape {
  symbol: string;
  state: string;
  reason: string;
  candidates: string[];
}

const firstAnchor = (stdout: string): AnchorShape =>
  (JSON.parse(stdout).pages[0].anchors as AnchorShape[])[0];

describe('code2doc rename candidates (V2-4)', () => {
  beforeAll(buildCli);

  it('a symbol moved file-intact: the new location is the first candidate', () => {
    const { dir } = setup();
    writeFileSync(path.join(dir, 'src/greet.ts'), GREET_MOVED_AWAY, 'utf8');
    writeFileSync(path.join(dir, 'src/hello.ts'), HELLO, 'utf8');

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2); // still any-broken: advisory never changes gates
    const anchor = firstAnchor(stdout);
    expect(anchor.state).toBe('broken');
    expect(anchor.reason).toBe('symbol gone');
    expect(anchor.candidates[0]).toBe('src/hello.ts#greet');
  });

  it('a pure rename in place: the new name is suggested via the unchanged body', () => {
    const { dir } = setup();
    writeFileSync(path.join(dir, 'src/greet.ts'), GREET_RENAMED, 'utf8');

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const anchor = firstAnchor(stdout);
    expect(anchor.state).toBe('broken');
    expect(anchor.candidates[0]).toBe('src/greet.ts#greet2');
  });

  it('the human output renders the suggestion under the broken anchor', () => {
    const { dir } = setup();
    writeFileSync(path.join(dir, 'src/greet.ts'), GREET_MOVED_AWAY, 'utf8');
    writeFileSync(path.join(dir, 'src/hello.ts'), HELLO, 'utf8');

    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(2);
    expect(stdout).toContain('src/greet.ts#greet — symbol gone');
    expect(stdout).toContain('→ maybe src/hello.ts#greet');
  });

  it('fresh anchors carry the field empty; suggestions never pad a healthy report', () => {
    const { dir } = setup();
    const { stdout } = run(['status', '--json'], dir);
    expect(firstAnchor(stdout).candidates).toEqual([]);
  });
});
