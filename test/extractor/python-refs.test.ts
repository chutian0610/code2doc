import { describe, it, expect } from 'vitest';
import { createPythonExtractor } from '../../src/extractor/python.js';
import type { FileRefs, ImportBinding, ImportIndex } from '../../src/extractor/types.js';

/**
 * Python call-ref extraction at parity with TS/Java (ADR-0004) — bare
 * calls attributed to the enclosing module-level def or constant,
 * namespace member calls claimed on the module's source (the one
 * member-call shape a language without method symbols may report),
 * and the import bindings the disambiguation cascade consumes. Star
 * imports and dynamic imports stay silent: no edges, no false edges.
 */

const CODE = `import pkg.mod
import pkg.mod as pm
import solo
from pkg.mod import fn
from pkg.mod import fn as g, other
from pkg import mod
from pkg import *

RATIO = compute()

def caller():
    fn()
    g()
    pkg.mod.tool()
    pm.tool()
    mod.helper()
    super().init()
    print("builtin")

def other_caller():
    fn()
    fn()

def caller_passing_values(fn):
    return fn

class Widget:
    attr = factory()
    def method(self):
        fn()
        self.pack()

def nested_home():
    def inner():
        return fn()
    return inner
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

describe('Python extractor — call refs (ADR-0004)', () => {
  const refs = async () => view(await createPythonExtractor().extractRefs!(CODE, 'src/greet.py'));

  it('attributes bare calls to the enclosing module-level def', async () => {
    const { callers } = await refs();
    // super() and print() are bare calls like any other — the extractor
    // records them; the cascade drops names no symbol carries
    expect(callers.caller).toEqual(['fn', 'g', 'helper', 'print', 'super', 'tool']);
    expect(callers.other_caller).toEqual(['fn']); // deduped
  });

  it('attributes calls inside a constant initializer to the constant', async () => {
    const { callers } = await refs();
    expect(callers.RATIO).toEqual(['compute']);
  });

  it('class bodies, methods and nested defs have no caller symbol — nothing is reported', async () => {
    const { callers } = await refs();
    // method body (fn, self.pack) and class attribute (factory) are a
    // blind spot; nested def attribution would cross its enclosing def
    expect(callers.Widget).toBeUndefined();
    expect(callers.method).toBeUndefined();
    expect(callers.nested_home).toBeUndefined();
    expect(callers.inner).toBeUndefined();
    expect(Object.keys(callers).sort()).toEqual(['RATIO', 'caller', 'other_caller']);
  });

  it('namespace member calls become named claims on the module source', async () => {
    const { callers, imports } = await refs();
    // dotted import: the full dotted local name is the binding
    expect(imports.tool).toEqual({ kind: 'named', imported: 'tool', source: 'pkg/mod' });
    // aliased dotted import and from-import module binding alike
    expect(callers.caller).toContain('tool');
    expect(callers.caller).toContain('helper');
    expect(imports.helper).toEqual({ kind: 'named', imported: 'helper', source: 'pkg/mod' });
  });

  it('member calls on anything but a namespace binding yield nothing (#26)', async () => {
    const { callers, imports } = await refs();
    // super().init() — the receiver is a call result; print — a builtin;
    // self.pack() — a method on a parameter. None of these names is ours
    // to guess about, and none is reported.
    expect(callers.caller).not.toContain('init');
    expect(callers.caller).not.toContain('pack');
    expect(imports.init).toBeUndefined();
    expect(imports.pack).toBeUndefined();
  });

  it('a star import claims no name at all', async () => {
    const { imports } = await refs();
    expect(Object.keys(imports).every((k) => k !== '*')).toBe(true);
  });

  it('captures the from-import bindings the cascade consumes', async () => {
    const { imports } = await refs();
    expect(imports.fn).toEqual({ kind: 'named', imported: 'fn', source: 'pkg/mod' });
    expect(imports.g).toEqual({ kind: 'named', imported: 'fn', source: 'pkg/mod' }); // alias resolves to the original
    expect(imports.other).toEqual({ kind: 'named', imported: 'other', source: 'pkg/mod' });
    // from pkg import mod: claimed symbol-first against the package,
    // with the module path held for member calls (mod.helper() above)
    expect(imports.mod).toEqual({ kind: 'named', imported: 'mod', source: 'pkg' });
  });

  it('relative and parenthesized import forms decode like any other', async () => {
    const code = `from . import x
from .helpers import y
from ..deep.pkg import (z, w as ww)
import importlib

def caller():
    y()
    ww()
`;
    const { imports } = view(await createPythonExtractor().extractRefs!(code, 'src/pkg/mod.py'));
    expect(imports.x).toEqual({ kind: 'named', imported: 'x', source: './__init__' });
    expect(imports.y).toEqual({ kind: 'named', imported: 'y', source: './helpers' });
    expect(imports.z).toEqual({ kind: 'named', imported: 'z', source: '../deep/pkg' });
    expect(imports.ww).toEqual({ kind: 'named', imported: 'w', source: '../deep/pkg' });
    // importlib is a plain namespace binding: no import-table entry
    expect(imports.importlib).toBeUndefined();
  });

  it('a caller named like an Object.prototype member keeps its edges (#21)', async () => {
    const code = `def toString():
    return helper()
`;
    const { callers } = view(await createPythonExtractor().extractRefs!(code, 'src/greet.py'));
    expect(callers.toString).toEqual(['helper']);
  });

  it('a caller literally named __proto__ is kept, not dropped (#21)', async () => {
    const code = `def __proto__():
    return helper()
`;
    const { callers } = view(await createPythonExtractor().extractRefs!(code, 'src/greet.py'));
    expect(callers['__proto__']).toEqual(['helper']);
  });

  it('a call shadowed by a parameter reports nothing — the argument is called, not the name', async () => {
    // resolving fn() to helper.py#fn would be a false edge: at runtime
    // the call goes to whatever the caller passed in
    const code = `from helper import fn

def caller(fn):
    return fn()

def callee():
    return fn()
`;
    const { callers } = view(await createPythonExtractor().extractRefs!(code, 'src/greet.py'));
    expect(callers.caller).toBeUndefined();
    expect(callers.callee).toEqual(['fn']); // the unshadowed caller keeps its claim
  });

  it('a member-call claim never overwrites an explicit import of the same name', async () => {
    // overwriting would point the bare tool() call at ns's module —
    // a false edge; the member call yields instead
    const code = `import ns
from pkg import tool

def caller():
    tool()
    ns.tool()
`;
    const { imports, callers } = view(await createPythonExtractor().extractRefs!(code, 'src/greet.py'));
    expect(imports.tool).toEqual({ kind: 'named', imported: 'tool', source: 'pkg' });
    expect(callers.caller).toEqual(['tool']);
  });

  it('a lowercase module variable is no symbol and claims nothing', async () => {
    const code = `memo = build()

def fn():
    return helper()
`;
    const { callers } = view(await createPythonExtractor().extractRefs!(code, 'src/greet.py'));
    expect(callers.memo).toBeUndefined();
    expect(Object.keys(callers).sort()).toEqual(['fn']);
  });
});

describe('Python extractor — resolveImport (ADR-0005)', () => {
  /**
   * A fake index with both package shapes: `pkg` as a regular package
   * (`pkg/__init__.py`) that also has a shadowing `pkg.py` nearby, and
   * `app/box` as a package reachable only through the relative form.
   */
  const files = [
    'src/pkg/mod.py',
    'src/pkg/__init__.py',
    'src/pkg.py',
    'src/app/util.py',
    'src/app/box/__init__.py',
    'src/lone.py',
  ];
  const index: ImportIndex = {
    at: (file) =>
      ({
        'src/pkg/mod.py': ['tool'],
        'src/pkg/__init__.py': ['helper'],
        'src/pkg.py': ['helper'],
        'src/app/util.py': ['y'],
        'src/app/box/__init__.py': ['z'],
        'src/lone.py': ['solo'],
      })[file],
    matching: (suffix) => files.filter((p) => p === suffix || p.endsWith(`/${suffix}`)),
  };
  const extractor = createPythonExtractor();
  const resolveFrom = (file: string) => (binding: ImportBinding) =>
    extractor.resolveImport!(file, binding, index);
  const resolve = resolveFrom('src/main.py');

  it('resolves an absolute dotted path by unique suffix, whatever the package root', () => {
    expect(resolve({ kind: 'named', imported: 'tool', source: 'pkg/mod' })).toBe(
      'src/pkg/mod.py#tool',
    );
    expect(resolve({ kind: 'named', imported: 'solo', source: 'lone' })).toBe('src/lone.py#solo');
  });

  it('a regular package owns the name when it exists — pkg.py never wins', () => {
    // Python import rules: the package directory shadows a same-named
    // module file. Resolving to pkg.py#helper would be a false edge.
    expect(resolve({ kind: 'named', imported: 'helper', source: 'pkg' })).toBe(
      'src/pkg/__init__.py#helper',
    );
    // a module-as-attribute name (mod lives in pkg/, not in __init__)
    // is claimed but resolves nothing — the module itself is no edge target
    expect(resolve({ kind: 'named', imported: 'mod', source: 'pkg' })).toBeUndefined();
  });

  it('relative dot forms resolve exactly against the file directory', () => {
    const resolve = resolveFrom('src/app/mod.py');
    expect(resolve({ kind: 'named', imported: 'y', source: './util' })).toBe('src/app/util.py#y');
    expect(resolve({ kind: 'named', imported: 'z', source: './box' })).toBe(
      'src/app/box/__init__.py#z',
    );
    expect(resolve({ kind: 'named', imported: 'tool', source: '../pkg/mod' })).toBe(
      'src/pkg/mod.py#tool',
    );
    // `from . import x` claims against the current package's __init__
    expect(resolve({ kind: 'named', imported: 'y', source: './__init__' })).toBeUndefined();
  });

  it('a relative claim resolves by exact path only — never a suffix guess', () => {
    // 'app/util.py' is an indexed suffix, but a relative claim from a
    // different directory must not reach it
    const resolve = resolveFrom('src/other/mod.py');
    expect(resolve({ kind: 'named', imported: 'y', source: './util' })).toBeUndefined();
  });

  it('ambiguous suffixes and absent names resolve nothing', () => {
    const twoRoots: ImportIndex = {
      ...index,
      matching: (suffix) =>
        ['src/pkg/mod.py', 'lib/pkg/mod.py'].filter((p) => p === suffix || p.endsWith(`/${suffix}`)),
    };
    expect(
      extractor.resolveImport!('src/main.py', { kind: 'named', imported: 'tool', source: 'pkg/mod' }, twoRoots),
    ).toBeUndefined();
    expect(resolve({ kind: 'named', imported: 'nope', source: 'pkg/mod' })).toBeUndefined();
    // a bare absolute path no indexed file carries → external, unresolved
    expect(resolve({ kind: 'named', imported: 'x', source: 'external/lib' })).toBeUndefined();
  });
});
