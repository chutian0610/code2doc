import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A language whose extraction always dies — the failure the scan seam
// must report by name (#23). Files other than .boom claim no extractor,
// exactly like the real registry.
vi.mock('../src/extractor/registry.js', () => ({
  claimedExtensions: () => ['.boom'],
  extractorForFile: (file: string) =>
    file.endsWith('.boom')
      ? {
          languageId: 'boom',
          extensions: ['.boom'],
          async extract() {
            throw new Error('parser exploded');
          },
        }
      : undefined,
}));

const { scan } = await import('../src/cache.js');
const { defaultConfig } = await import('../src/config.js');

describe('scan — extractor failures name the file (#23)', () => {
  it('rethrows with the offending file and the original message', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code2doc-scan-'));
    writeFileSync(path.join(dir, 'x.boom'), 'boom', 'utf8');
    const config = { ...defaultConfig(), include: ['**/*.boom'] };

    await expect(scan(dir, config)).rejects.toThrow(
      'extraction failed for x.boom: parser exploded',
    );
  });
});
