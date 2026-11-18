import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyManifest, loadManifest, saveManifest, validateManifest } from '../src/manifest.js';
import type { Manifest } from '../src/manifest.js';

/**
 * Unit seams for the declared tree (#31): validateManifest's error
 * shapes name their offender; the persistence trio round-trips. The
 * CLI suites keep covering composition (init's idempotence over a
 * hand-shaped manifest lives there).
 */

describe('validateManifest — shape violations name the offender', () => {
  const ok = (m: unknown) => () => expect(() => validateManifest(m as never)).not.toThrow();

  it('accepts a well-formed tree, including an empty one', () => {
    expect(ok({ pages: [] })).not.toThrow();
    expect(
      ok([
        { pages: [{ path: 'overview.md', type: 'overview' }] },
        { pages: [{ path: 'm/core.md', type: 'module', module: 'src' }] },
        { pages: [{ path: 'f/x.md', type: 'flow' }] },
      ][1]),
    ).not.toThrow();
  });

  it('pages must be an array', () => {
    expect(() => validateManifest({ pages: 'nope' } as never)).toThrow(
      'manifest: "pages" must be an array of page entries',
    );
  });

  it('every page needs a non-empty path', () => {
    expect(() => validateManifest({ pages: [{ path: '', type: 'overview' }] } as never)).toThrow(
      'manifest: every page needs a non-empty "path"',
    );
  });

  it('unknown types are named with the expected list', () => {
    expect(() =>
      validateManifest({ pages: [{ path: 'a.md', type: 'chapter' }] } as never),
    ).toThrow(/unknown type "chapter" for a\.md.*overview, module, flow, howto, reference/);
  });

  it('module pages need their source directory; other types must not carry one', () => {
    expect(() =>
      validateManifest({ pages: [{ path: 'm.md', type: 'module' }] } as never),
    ).toThrow('manifest: module page m.md needs a non-empty "module"');
    expect(() =>
      validateManifest({ pages: [{ path: 'f.md', type: 'flow', module: 'src' }] } as never),
    ).toThrow('manifest: "module" is only for module pages — f.md is a flow page');
  });
});

describe('manifest persistence', () => {
  it('emptyManifest is a valid tree; save + load round-trips a declared one', () => {
    expect(() => validateManifest(emptyManifest())).not.toThrow();

    const root = mkdtempSync(path.join(tmpdir(), 'code2doc-manifest-'));
    const manifest: Manifest = {
      pages: [
        { path: 'overview.md', type: 'overview' },
        { path: 'modules/core.md', type: 'module', module: 'src' },
      ],
    };
    saveManifest(root, 'code2doc', manifest);
    expect(loadManifest(root, 'code2doc')).toEqual(manifest);

    // a missing manifest is undefined, not an error — init's empty-start path
    expect(loadManifest(root, 'other-docs')).toBeUndefined();
  });

  it('a manifest with invalid JSON fails loudly at load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'code2doc-manifest-'));
    writeFileSync(path.join(root, 'broken.json'), '{ nope', 'utf8');
    expect(() => JSON.parse(readFileSync(path.join(root, 'broken.json'), 'utf8'))).toThrow();
  });
});
