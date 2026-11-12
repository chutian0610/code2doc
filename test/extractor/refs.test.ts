import { describe, it, expect } from 'vitest';
import { createTsExtractor } from '../../src/extractor/ts.js';
import type { FileRefs } from '../../src/extractor/types.js';

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
  const callers: Record<string, string[]> = {};
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

    expect(imports.helper).toEqual({ imported: 'helper', source: './helper' });
    expect(imports.aliased).toEqual({ imported: 'a', source: './x' }); // alias resolves to the original
    expect(imports.def).toEqual({ imported: '', source: './other' }); // '' = default import, unresolvable by name
    expect(imports.ns).toBeUndefined(); // namespace import: member calls resolve by identifier instead
    expect(imports.unresolvable).toEqual({ imported: 'unresolvable', source: 'some-package' });
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
});
