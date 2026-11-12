import { describe, it, expect } from 'vitest';
import { renameCandidates } from '../src/anchors.js';
import type { CacheData } from '../src/cache.js';
import type { SymbolRecord } from '../src/extractor/types.js';

/**
 * V2-4: rename candidates for vanished anchors — advisory guesses only.
 * Three tiers, ranked: an exact signature fingerprint (a pure move),
 * the same name elsewhere, then an unchanged body (a pure rename, whose
 * signature necessarily moved when the name did).
 */

const SIG = 'a'.repeat(16);
const SIG2 = 'b'.repeat(16);
const BODY = 'c'.repeat(16);
const BODY2 = 'd'.repeat(16);

function sym(file: string, name: string, signature = SIG, body = BODY): SymbolRecord {
  return {
    id: `${file}#${name}@0`,
    name,
    kind: 'function',
    file,
    signature: { start: 0, end: 1, row: 0, col: 0 },
    body: { start: 1, end: 2, row: 1, col: 0 },
    visibility: 'public',
    fingerprint: { signature, body },
  };
}

function cacheOf(symbols: SymbolRecord[]): CacheData {
  return { version: 4, files: { 'src/x.ts': { hash: 'h', symbols, refs: { imports: {}, callers: {} } } } };
}

/** The anchor a page wrote for `src/x.ts#fn` before it vanished. */
const anchorOf = (signature: string, body: string) => ({
  text: 'fn',
  target: '../src/x.ts',
  file: 'src/x.ts',
  name: 'fn',
  fingerprint: { signature, body },
  line: 1,
});

describe('renameCandidates (V2-4)', () => {
  it('a pure move (same signature elsewhere) ranks first', () => {
    const cache = cacheOf([
      sym('src/other.ts', 'unrelated', SIG2, BODY2),
      sym('src/hello.ts', 'fn', SIG, BODY),
    ]);
    expect(renameCandidates(anchorOf(SIG, BODY), cache)).toEqual(['src/hello.ts#fn']);
  });

  it('a pure rename (new name, same body) is suggested via the body tier', () => {
    // the signature carries the name, so a rename changes it — an
    // unchanged body is the fingerprint of a rename
    const cache = cacheOf([sym('src/x.ts', 'fn2', SIG2, BODY)]);
    expect(renameCandidates(anchorOf(SIG, BODY), cache)).toEqual(['src/x.ts#fn2']);
  });

  it('ranks signature-exact before same-name before body-exact, capped at three', () => {
    const cache = cacheOf([
      sym('src/body-only.ts', 'zz', SIG2, BODY), // body tier
      sym('src/same-name.ts', 'fn', SIG2, BODY2), // same-name tier
      sym('src/exact.ts', 'moved', SIG, BODY), // signature-exact tier
    ]);
    expect(renameCandidates(anchorOf(SIG, BODY), cache)).toEqual([
      'src/exact.ts#moved',
      'src/same-name.ts#fn',
      'src/body-only.ts#zz',
    ]);
  });

  it('within the signature tier, an unchanged body ranks before a changed one', () => {
    const cache = cacheOf([
      sym('src/b-moved-edited.ts', 'b', SIG, BODY2), // moved, then edited
      sym('src/a-moved-pure.ts', 'a', SIG, BODY), // pure move
    ]);
    expect(renameCandidates(anchorOf(SIG, BODY), cache)).toEqual([
      'src/a-moved-pure.ts#a',
      'src/b-moved-edited.ts#b',
    ]);
  });

  it('yields nothing when nothing plausibly matches', () => {
    const cache = cacheOf([sym('src/x.ts', 'other', SIG2, BODY2)]);
    expect(renameCandidates(anchorOf(SIG, BODY), cache)).toEqual([]);
  });
});
