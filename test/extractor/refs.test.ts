import { describe, it, expect } from 'vitest';
import { createTsExtractor } from '../../src/extractor/ts.js';
import type { FileRefs, ImportBinding, ImportIndex } from '../../src/extractor/types.js';

/**
 * V2-1: TS/JS call-ref extraction, pinned per ADR-0004 — captured forms
 * (call/member-call by final identifier, new, extends/implements),
 * function-as-value ignored, attribution to top-level function/variable
 * symbols, and the import bindings the disambiguation cascade consumes.
 */

const CODE = `import { helper } from './helper';
import { a as aliased } from './x';
import def from './other';
import * as ns from './ns';
import { unresolvable } from 'some-package';

class Base {}
interface Ifc {}

export function fn(): void {
  helper();
  ns.deep.greet();
  new Base();
  new ns.Thing();
  fn();
}

export class Sub extends Base implements Ifc {}

export const arrow = (): void => {
  helper();
  passThrough(fn);
};

[1].map(helper);

export class Wrapper {
  method(): void {
    helper();
  }
}
`;

/** callers view with deterministic ordering, imports as a plain object. */
function view(refs: FileRefs): { callers: Record<string, string[]>; imports: Record<string, unknown> } {
  // prototype-less: a caller literally named __proto__ must survive the view too
  const callers: Record<string, string[]> = Object.create(null);
  for (const [caller, callees] of Object.entries(refs.callers)) {
    callers[caller] = [...callees].sort();
  }
  return { callers, imports: refs.imports as unknown as Record<string, unknown> };
}

describe('TS extractor — call refs (ADR-0004)', () => {
  it('captures bare calls, member calls by final identifier, new, extends and implements', async () => {
    const { callers } = view(await createTsExtractor().extractRefs!(CODE, 'src/greet.ts'));

    expect(callers.fn).toContain('helper'); // bare call
    expect(callers.fn).toContain('greet'); // member call — final identifier only
    expect(callers.fn).toContain('Base'); // new
    expect(callers.fn).toContain('Thing'); // new with member path
    expect(callers.fn).toContain('fn'); // self-call
    // heritage: the class itself is the caller
    expect(callers.Sub).toEqual(['Base', 'Ifc']);
  });

  it('ignores function-as-value references', async () => {
    const { callers } = view(await createTsExtractor().extractRefs!(CODE, 'src/greet.ts'));
    // helper() is called; passThrough(fn) is a real call to passThrough —
    // but fn itself, passed as a value, is no callee
    expect(callers.arrow).toEqual(['helper', 'passThrough']);
    expect(callers.arrow).not.toContain('fn');
  });

  it('drops calls with no top-level function/variable caller', async () => {
    const { callers } = view(await createTsExtractor().extractRefs!(CODE, 'src/greet.ts'));
    // method bodies are a blind spot (class methods are not symbols);
    // top-level statements have no caller symbol at all
    expect(callers.Wrapper).toBeUndefined();
    expect(callers.method).toBeUndefined();
    expect(Object.keys(callers).sort()).toEqual(['Sub', 'arrow', 'fn']);
  });

  it('captures the import bindings the disambiguation cascade consumes', async () => {
    const { imports } = view(await createTsExtractor().extractRefs!(CODE, 'src/greet.ts'));

    expect(imports.helper).toEqual({ kind: 'named', imported: 'helper', source: './helper' });
    expect(imports.aliased).toEqual({ kind: 'named', imported: 'a', source: './x' }); // alias resolves to the original
    expect(imports.def).toEqual({ kind: 'default', source: './other' }); // the sentinel is data now
    expect(imports.ns).toBeUndefined(); // namespace import: member calls resolve by identifier instead
    expect(imports.unresolvable).toEqual({ kind: 'named', imported: 'unresolvable', source: 'some-package' });
  });

  it('dedupes repeated callee names within a caller', async () => {
    const code = `export function fn(): void {
  helper();
  helper();
  other.helper();
}
`;
    const refs = await createTsExtractor().extractRefs(code, 'src/greet.ts');
    expect(refs.callers.fn).toEqual(['helper']);
  });

  it('a caller named like an Object.prototype member (toString) keeps its edges (#21)', async () => {
    // the accumulator must not resolve `toString` through the prototype
    // chain — a legal top-level export of that name is a caller like any
    // other (field-tested against repos full of such names)
    const code = `import { helper } from './helper';
export function toString(): string {
  return helper();
}
`;
    const { callers } = view(await createTsExtractor().extractRefs(code, 'src/greet.ts'));
    expect(callers.toString).toEqual(['helper']);
  });

  it('a caller literally named __proto__ is kept, not dropped by the accumulator (#21)', async () => {
    // a legal identifier; direct assignment on a plain object would go to
    // the prototype setter and silently lose the key
    const code = `import { helper } from './helper';
export function __proto__(): string {
  return helper();
}
`;
    const { callers } = view(await createTsExtractor().extractRefs(code, 'src/greet.ts'));
    expect(callers['__proto__']).toEqual(['helper']);
  });
});

describe('TS extractor — resolveImport (ADR-0005)', () => {
  /** A fake index: helper.ts, a util/index.ts barrel, and one indexed pkg/sub.js. */
  const index: ImportIndex = {
    at: (file) =>
      ({ 'src/helper.ts': ['helper'], 'src/util/index.ts': ['helper'], 'src/pkg/sub.js': ['x'] })[file],
    matching: () => [],
  };
  const extractor = createTsExtractor();
  const resolve = (binding: ImportBinding) => extractor.resolveImport!('src/greet.ts', binding, index);

  it('resolves relative, extension-stripped and directory-index forms with its own extensions', () => {
    expect(resolve({ kind: 'named', imported: 'helper', source: './helper' })).toBe('src/helper.ts#helper');
    expect(resolve({ kind: 'named', imported: 'helper', source: './helper.js' })).toBe('src/helper.ts#helper');
    expect(resolve({ kind: 'named', imported: 'helper', source: './util' })).toBe('src/util/index.ts#helper');
  });

  it('a bare package specifier is not this language\'s form — unresolved, never a suffix guess', () => {
    // 'pkg/sub.js' is an indexed path; a TS bare specifier still resolves nothing
    expect(resolve({ kind: 'named', imported: 'x', source: 'pkg/sub.js' })).toBeUndefined();
    expect(resolve({ kind: 'named', imported: 'x', source: 'some-package' })).toBeUndefined();
  });

  it('a default binding claims the name but never resolves', () => {
    expect(resolve({ kind: 'default', source: './helper' })).toBeUndefined();
  });
});

describe('TS extractor — CommonJS requires (#25)', () => {
  it('captures destructured requires as named claims, aliased keys included', async () => {
    const code = `const { helper } = require('./helper');
const { a: aliased } = require('../util/x');
function fn(): void {
  helper();
  aliased();
}
module.exports = { fn };
`;
    const { callers, imports } = view(await createTsExtractor().extractRefs(code, 'src/greet.cjs'));
    expect(imports.helper).toEqual({ kind: 'named', imported: 'helper', source: './helper' });
    expect(imports.aliased).toEqual({ kind: 'named', imported: 'a', source: '../util/x' });
    expect(callers.fn).toContain('helper');
    expect(callers.fn).toContain('aliased');
  });

  it('captures a whole-module require as a default claim — claimed, unresolvable by name', async () => {
    const code = `const helper = require('lodash-helper');
function fn(): void {
  helper();
}
module.exports = { fn };
`;
    const { imports } = view(await createTsExtractor().extractRefs(code, 'src/greet.cjs'));
    expect(imports.helper).toEqual({ kind: 'default', source: 'lodash-helper' });
  });

  it('ignores non-require calls that merely take a string first argument', async () => {
    const code = `function fn(): void {
  import('./lazy');
  tag\`template\`;
}
module.exports = { fn };
`;
    const { imports } = view(await createTsExtractor().extractRefs(code, 'src/greet.cjs'));
    expect(Object.keys(imports)).toHaveLength(0);
  });
});
