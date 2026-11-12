import { describe, it, expect } from 'vitest';
import { createTsExtractor } from '../../src/extractor/ts.js';
import type { Span } from '../../src/extractor/types.js';

function text(code: string, span: Span): string {
  return code.slice(span.start, span.end);
}

const CODE = `export function greet(name: string): string {
  return 'hello ' + name;
}
`;

describe('TS extractor', () => {
  it('extracts an exported function with spans, visibility and stable fingerprints', async () => {
    const extractor = createTsExtractor();
    const symbols = await extractor.extract(CODE, 'src/greet.ts');

    expect(symbols).toHaveLength(1);
    const fn = symbols[0];
    expect(fn.name).toBe('greet');
    expect(fn.kind).toBe('function');
    expect(fn.visibility).toBe('public');

    // signature span covers the parameter list
    expect(text(CODE, fn.signature)).toContain('name: string');
    // body span covers the return statement
    expect(text(CODE, fn.body)).toContain("'hello ' + name");

    // fingerprints derive from span content and are stable across runs
    const again = await extractor.extract(CODE, 'src/greet.ts');
    expect(again[0].fingerprint.signature).toBe(fn.fingerprint.signature);
    expect(again[0].fingerprint.body).toBe(fn.fingerprint.body);
  });

  it('marks non-exported top-level symbols internal and skips function-local declarations', async () => {
    const code = `function helper(): void {}
const internalAnswer = 42;
export function outer() {
  const inner = 1;
}
`;
    const symbols = await createTsExtractor().extract(code, 'src/helper.ts');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('helper');
    expect(names).toContain('internalAnswer');
    expect(names).not.toContain('inner');
    expect(symbols.find((s) => s.name === 'helper')?.visibility).toBe('internal');
    expect(symbols.find((s) => s.name === 'internalAnswer')?.visibility).toBe('internal');
  });

  it('extracts classes, interfaces, types, enums and exported variables with correct span semantics', async () => {
    const code = `export interface User { id: number; name: string; }
export type Id = string;
export enum Color { Red, Green }
export class Greeter {
  greeting: string;
  greet(): string { return this.greeting; }
}
export const answer = 42;
`;
    const symbols = await createTsExtractor().extract(code, 'src/shapes.ts');
    const find = (n: string) => symbols.find((s) => s.name === n)!;

    // interface: the whole node is the shape
    const iface = find('User');
    expect(iface.kind).toBe('interface');
    expect(text(code, iface.signature)).toContain('id: number');
    expect(text(code, iface.body)).toContain('name: string');

    // class: signature = header before the body; body = the class body
    const cls = find('Greeter');
    expect(cls.kind).toBe('class');
    const sigText = text(code, cls.signature);
    expect(sigText).toContain('Greeter');
    expect(sigText).not.toContain('return');
    expect(text(code, cls.body)).toContain('return');

    // type alias: whole node
    const alias = find('Id');
    expect(alias.kind).toBe('type');
    expect(text(code, alias.signature)).toContain('string');

    // enum: whole node
    expect(find('Color').kind).toBe('enum');

    // exported variable: signature = declarator head, body = the value
    const v = find('answer');
    expect(v.kind).toBe('variable');
    expect(v.visibility).toBe('public');
    expect(text(code, v.signature)).toContain('answer');
    expect(text(code, v.signature)).not.toContain('42');
    expect(text(code, v.body)).toBe('42');
  });

  it('parses plain JavaScript files with the same extractor', async () => {
    const code = `export function add(a, b) { return a + b; }\n`;
    const symbols = await createTsExtractor().extract(code, 'lib/add.js');
    const fn = symbols.find((s) => s.name === 'add');
    expect(fn).toBeTruthy();
    expect(fn!.visibility).toBe('public');
    expect(text(code, fn!.signature)).toContain('a, b');
    expect(text(code, fn!.body)).toContain('a + b');
  });
});

describe('fingerprint invariance (T2: no false signals)', () => {
  const BASE = `export function greet(name: string): string {
  return 'hello ' + name;
}
`;
  const extractOne = async (code: string) => {
    const symbols = await createTsExtractor().extract(code, 'src/greet.ts');
    return symbols.find((s) => s.name === 'greet')!;
  };

  it('ignores comments inside the body', async () => {
    const commented = `export function greet(name: string): string {
  // enthusiastic greeting
  return /* inline */ 'hello ' + name;
}
`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(commented)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).toBe(a.fingerprint.body);
  });

  it('ignores comments inside the signature', async () => {
    const commented = `export function greet(name: /* the person */ string): string {
  return 'hello ' + name;
}
`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(commented)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
  });

  it('ignores whitespace-only reflow (indentation, line breaks, space runs)', async () => {
    const reformatted = `export function greet(name: string): string {
      return
          'hello '   +   name;
}\n`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(reformatted)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).toBe(a.fingerprint.body);
  });

  it('keeps single-space differences significant, including inside strings', async () => {
    const edited = `export function greet(name: string): string {
  return 'hello' + name;
}
`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(edited)]);
    expect(b.fingerprint.body).not.toBe(a.fingerprint.body);
  });

  it('still changes when the body actually changes', async () => {
    const edited = `export function greet(name: string): string {
  return 'hi ' + name;
}
`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(edited)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).not.toBe(a.fingerprint.body);
  });

  it('still changes the signature fingerprint when the signature changes', async () => {
    const edited = `export function greet(name: string, prefix: string): string {
  return 'hello ' + name;
}
`;
    const [a, b] = await Promise.all([extractOne(BASE), extractOne(edited)]);
    expect(b.fingerprint.signature).not.toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).toBe(a.fingerprint.body);
  });
});

describe('SymbolId — the one spelling (architecture review #4)', () => {
  it('builds and parses file#name keys as a round trip', async () => {
    const { symbolId, parseSymbolId } = await import('../../src/extractor/types.js');
    expect(symbolId('src/helper.ts', 'greet')).toBe('src/helper.ts#greet');
    expect(parseSymbolId('src/helper.ts#greet')).toEqual({ file: 'src/helper.ts', name: 'greet' });
    // names are identifiers ([\w$]+): they never contain '#', so the
    // single separator is unambiguous by construction
  });
});
