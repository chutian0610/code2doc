import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocLink, parseDocLinks } from '../src/links.js';

/**
 * Unit seams for the doc-link machinery (#31): parseDocLinks'
 * normalization rules and checkDocLink's existence verdict, pinned
 * table-driven and fast — the CLI tree suites keep covering the
 * composition, not the path algebra.
 */

/** Targets of a page's parsed doc links, in order. */
function targets(markdown: string, pagePath = 'modules/core.md', docRoot = 'code2doc'): string[] {
  return parseDocLinks(markdown, pagePath, docRoot).map((l) => `${l.target} -> ${l.resolved}`);
}

describe('parseDocLinks — what counts as a doc link', () => {
  it('resolves relative to the page, not naively from the doc root', () => {
    expect(targets('[x](../overview.md)')).toEqual(['../overview.md -> overview.md']);
    expect(targets('[x](sibling.md)', 'modules/core.md')).toEqual(['sibling.md -> modules/sibling.md']);
  });

  it('drops externals, same-page fragments, images and anchors — none of this checker\'s business', () => {
    expect(
      targets(
        '[site](https://example.com) [mail](mailto:a@b.c) [top](#section) ' +
          '![img](pic.png) [a](../src/x.ts "c2d:src/x.ts#a:0123456789abcdef.0123456789abcdef")',
      ),
    ).toEqual([]);
  });

  it('a fragment after a file targets the file: other.md#section resolves to other.md', () => {
    expect(targets('[x](other.md#section)')).toEqual(['other.md#section -> modules/other.md']);
  });

  it('links leaving the tree stay unchecked, however they leave it', () => {
    // code, repo root, an escape that just barely exits
    expect(targets('[code](../../src/anchors.ts)')).toEqual([]);
    expect(targets('[root](../..)')).toEqual([]);
    expect(targets('[out](../../../outside.md)')).toEqual([]);
  });

  it('a link that exits and re-enters resolves like a renderer would', () => {
    expect(targets('[rt](../../code2doc/overview.md)')).toEqual([
      '../../code2doc/overview.md -> overview.md',
    ]);
  });

  it('the doc tree root itself is not a page', () => {
    expect(targets('[root](..)', 'modules/core.md')).toEqual([]);
  });

  it('carries 1-based lines for the drill-down', () => {
    const links = parseDocLinks('first\n\n[x](other.md)', 'modules/core.md', 'code2doc');
    expect(links[0]!.line).toBe(3);
  });
});

describe('checkDocLink — target existence is the whole verdict', () => {
  it('fresh when the resolved target exists, broken with reason otherwise', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code2doc-links-'));
    mkdirSync(path.join(root, 'code2doc', 'modules'), { recursive: true });
    writeFileSync(path.join(root, 'code2doc', 'overview.md'), '# o', 'utf8');

    const [fresh] = parseDocLinks('[o](../overview.md)', 'modules/core.md', 'code2doc');
    const [broken] = parseDocLinks('[x](gone.md)', 'modules/core.md', 'code2doc');
    expect(checkDocLink(fresh!, root, 'code2doc')).toEqual({ state: 'fresh', reason: '' });
    expect(checkDocLink(broken!, root, 'code2doc')).toEqual({
      state: 'broken',
      reason: 'doc link target missing',
    });
  });
});
