import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
  buildCli,
  copyFixture,
  declarePages,
  docsFixture,
  run,
  tsFixture,
  writePage,
} from './helpers';

interface Page {
  path: string;
  type: string;
  state: string;
  anchors?: { symbol: string; state: string }[];
  links: { target: string; resolved: string; state: string; reason: string }[];
}

function pages(stdout: string): Page[] {
  return JSON.parse(stdout).pages as Page[];
}

/** init the plain TS fixture, then declare pages as the Operator would. */
function initAndDeclare(dir: string, entries: unknown[]): void {
  run(['init'], dir);
  declarePages(dir, entries);
}

/** A working anchor for `greet`, lifted from the init report. */
function greetAnchor(dir: string): string {
  const report = JSON.parse(run(['init'], dir).stdout);
  const greet = report.symbols.find((s: { name: string }) => s.name === 'greet');
  const { signature, body } = greet.fingerprint;
  return `[greet](../src/greet.ts "c2d:src/greet.ts#greet:${signature}.${body}")`;
}

describe('code2doc manifest-driven doc tree (T3)', () => {
  beforeAll(buildCli);

  it('the multi-type fixture demos a fresh tree with all five page types', () => {
    const dir = copyFixture(docsFixture, 'code2doc-tree-');
    run(['init'], dir);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.pages.map((p: Page) => p.type)).toEqual([
      'overview',
      'module',
      'flow',
      'howto',
      'reference',
    ]);
    expect(report.pages.every((p: Page) => p.state === 'fresh')).toBe(true);
    expect(report.summary).toEqual({ broken: 0, drift: 0, ripple: 0, missing: 0 });
  });

  it('default output is a per-page freshness table of the whole tree', () => {
    const dir = copyFixture(docsFixture, 'code2doc-tree-');
    run(['init'], dir);

    const { code, stdout } = run(['status'], dir);
    expect(code).toBe(0);
    expect(stdout).toContain('STATE');
    expect(stdout).toContain('TYPE');
    expect(stdout).toContain('PAGE');
    for (const page of ['overview.md', 'modules/greet.md', 'flows/greeting.md', 'howtos/greet-a-user.md', 'reference/symbols.md']) {
      expect(stdout).toContain(path.join('docs', page));
    }
    expect(stdout).toContain('5 pages: all accurate.');
  });

  it('undeclared files in the doc tree are ignored', () => {
    const dir = copyFixture(docsFixture, 'code2doc-tree-');
    run(['init'], dir);

    const { stdout } = run(['status', '--json'], dir);
    expect(pages(stdout).map((p) => p.path)).not.toContain('wip-notes.md');
    const human = run(['status'], dir).stdout;
    expect(human).not.toContain('wip-notes');
  });

  it('a doc-to-doc link to a missing target is reported broken, exit 2', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    const anchor = greetAnchor(dir);
    initAndDeclare(dir, [
      { path: 'overview.md', type: 'overview' },
      { path: 'old-name.md', type: 'howto' },
    ]);
    writePage(
      dir,
      'overview.md',
      `# Overview\n\n${anchor} still holds.\n\nSee the [greeting how-to](old-name.md).\n`,
    );
    // old-name.md is declared but never written: the page is missing, and
    // overview.md's link to it targets nothing — two independent signals.
    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const overview = pages(stdout).find((p) => p.path === 'overview.md')!;
    expect(overview.state).toBe('broken');
    // the broken link breaks the page; its anchor is independently fresh
    expect(overview.anchors.find((a: { symbol: string }) => a.symbol === 'src/greet.ts#greet')!.state).toBe('fresh');
    const brokenLink = overview.links.find((l) => l.target === 'old-name.md')!;
    expect(brokenLink.state).toBe('broken');
    expect(brokenLink.reason).toBe('doc link target missing');
    expect(brokenLink.resolved).toBe('old-name.md');
    const human = run(['status'], dir).stdout;
    expect(human).toContain('doc link target missing');
  });

  it('a doc link to an existing page is fresh; subdirectory targets resolve', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    const anchor = greetAnchor(dir);
    initAndDeclare(dir, [
      { path: 'overview.md', type: 'overview' },
      { path: 'howtos/greet.md', type: 'howto' },
    ]);
    writePage(dir, 'overview.md', `# Overview\n\n${anchor}\n\nSee [the how-to](howtos/greet.md).\n`);
    writePage(dir, 'howtos/greet.md', `# How to greet\n\nUse ${anchor} — back to [overview](../overview.md).\n`);

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    const overview = pages(stdout).find((p) => p.path === 'overview.md')!;
    expect(overview.state).toBe('fresh');
    expect(overview.links.find((l) => l.target === 'howtos/greet.md')!.state).toBe('fresh');
    const howto = pages(stdout).find((p) => p.path === 'howtos/greet.md')!;
    expect(howto.links.find((l) => l.target === '../overview.md')!.resolved).toBe('overview.md');
  });

  it('links outside the doc tree, external URLs, fragments and images are not checked', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    const anchor = greetAnchor(dir);
    initAndDeclare(dir, [{ path: 'overview.md', type: 'overview' }]);
    writePage(
      dir,
      'overview.md',
      `# Overview\n\n${anchor}\n\n- [gone code](../src/nope.ts)\n- [site](https://example.com/x.md)\n- [top](#top)\n- ![shot](screens/missing.png)\n`,
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].links).toEqual([]);
  });

  it('a link that leaves and re-enters the doc tree resolves like a renderer would', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    const anchor = greetAnchor(dir);
    initAndDeclare(dir, [
      { path: 'overview.md', type: 'overview' },
      { path: 'modules/greet.md', type: 'module', module: 'src' },
    ]);
    writePage(dir, 'overview.md', `# Overview\n\n${anchor}\n`);
    // from docs/modules/, ../../docs/overview.md exits the tree to the repo
    // root and re-enters: it renders to the existing docs/overview.md, so it
    // must resolve and stay fresh. ../docs/overview.md, in contrast, renders
    // to the missing docs/docs/overview.md — a genuinely wrong link.
    writePage(
      dir,
      'modules/greet.md',
      `# src module\n\n${anchor}\n\n[round trip](../../docs/overview.md) and [typo](../docs/overview.md)\n`,
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(2);
    const module_ = pages(stdout).find((p) => p.path === 'modules/greet.md')!;
    expect(module_.state).toBe('broken');
    const roundTrip = module_.links.find((l) => l.target === '../../docs/overview.md')!;
    expect(roundTrip.state).toBe('fresh');
    expect(roundTrip.resolved).toBe('overview.md');
    const typo = module_.links.find((l) => l.target === '../docs/overview.md')!;
    expect(typo.state).toBe('broken');
    expect(typo.resolved).toBe('docs/overview.md');
  });

  it('an anchor whose URL points nowhere is still fresh — the URL is never parsed', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    run(['init'], dir);
    const report = JSON.parse(run(['init'], dir).stdout);
    const greet = report.symbols.find((s: { name: string }) => s.name === 'greet');
    const { signature, body } = greet.fingerprint;
    initAndDeclare(dir, [{ path: 'overview.md', type: 'overview' }]);
    writePage(
      dir,
      'overview.md',
      `# Overview\n\n[greet](../src/moved-anywhere.ts "c2d:src/greet.ts#greet:${signature}.${body}")\n`,
    );

    const { code, stdout } = run(['status', '--json'], dir);
    expect(code).toBe(0);
    expect(pages(stdout)[0].state).toBe('fresh');
  });

  it('an unknown page type in the manifest fails the tool (exit 3), pointing at the page', () => {
    const dir = copyFixture(tsFixture, 'code2doc-tree-');
    initAndDeclare(dir, [{ path: 'overview.md', type: 'tutorial' }]);

    const { code, stdout, stderr } = run(['status', '--json'], dir);
    expect(code).toBe(3);
    expect(() => JSON.parse(stdout)).toThrow();
    expect(stderr).toContain('tutorial');
    expect(stderr).toContain('overview.md');
  });
});
