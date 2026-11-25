import { describe, it, expect } from 'vitest';
import { createPythonExtractor } from '../../src/extractor/python.js';
import type { Span } from '../../src/extractor/types.js';

function text(code: string, span: Span): string {
  return code.slice(span.start, span.end);
}

const MODULE = `PI = 3.14

def area(radius):
    return PI * radius ** 2

class Circle:
    def __init__(self, r):
        self.r = r
`;

describe('Python extractor', () => {
  it('extracts module-level functions, classes and UPPER_CASE constants with spans', async () => {
    const extractor = createPythonExtractor();
    // the claim the registry dispatches on — without it the default
    // include would silently stop covering the language (#34)
    expect(extractor.extensions).toEqual(['.py']);
    const symbols = await extractor.extract(MODULE, 'src/geometry.py');

    expect(symbols.map((s) => s.name)).toEqual(['PI', 'area', 'Circle']);

    const constant = symbols[0];
    expect(constant.kind).toBe('variable');
    expect(constant.visibility).toBe('public');
    // a constant splits the TS way: name on the signature, value in the body
    expect(text(MODULE, constant.signature)).toBe('PI = ');
    expect(text(MODULE, constant.body)).toBe('3.14');

    const area = symbols[1];
    expect(area.kind).toBe('function');
    expect(area.visibility).toBe('public');
    // signature = the def header, body excluded
    expect(text(MODULE, area.signature)).toBe('def area(radius):');
    expect(text(MODULE, area.body)).toContain('return PI * radius ** 2');

    const cls = symbols[2];
    expect(cls.kind).toBe('class');
    expect(cls.visibility).toBe('public');
    expect(text(MODULE, cls.signature)).toBe('class Circle:');
    expect(text(MODULE, cls.body)).toContain('__init__');
  });

  it('a typed assignment is a symbol too; aug-assignments and tuple unpacking are not', async () => {
    const code = `LIMIT: int = 10
count += 1
a, b = 1, 2
`;
    const symbols = await createPythonExtractor().extract(code, 'src/limits.py');
    expect(symbols.map((s) => s.name)).toEqual(['LIMIT']);
  });

  it('a constant value edit drifts; an annotation edit breaks — signals at TS parity', async () => {
    const extractor = createPythonExtractor();
    const base = `RATE: float = 0.5
`;
    const before = await extractor.extract(base, 'src/rate.py');
    expect(before.map((s) => s.name)).toEqual(['RATE']);

    // value change: the claim may still hold — body moves, signature holds
    const revalued = (await extractor.extract(base.replace('0.5', '0.6'), 'src/rate.py'))[0];
    expect(revalued.fingerprint.signature).toBe(before[0].fingerprint.signature);
    expect(revalued.fingerprint.body).not.toBe(before[0].fingerprint.body);

    // annotation change: the interface changed — signature moves (Broken)
    const retyped = (await extractor.extract(base.replace('float', 'Decimal'), 'src/rate.py'))[0];
    expect(retyped.fingerprint.signature).not.toBe(before[0].fingerprint.signature);
  });

  it('dunder names never surface as symbols — defs and classes included', async () => {
    const code = `def __getattr__(name):
    return None

class __Forbidden__:
    pass

class __Mangled:
    pass

__FOO = 1
___ = 2
`;
    const symbols = await createPythonExtractor().extract(code, 'src/dunder.py');
    // true dunders (double underscores on both sides — PEP 562's module
    // __getattr__, a magic class name) are bookkeeping, never API. A
    // double-leading name without the trailing pair is the strong-private
    // convention: internal, still a symbol. ___ has no letters and is no
    // name anyone documents.
    expect(symbols.map((s) => `${s.name}:${s.visibility}`)).toEqual([
      '__Mangled:internal',
      '__FOO:internal',
    ]);
  });

  it('ignores multibyte characters ABOVE the symbol — offsets are string units, not bytes', async () => {
    const extractor = createPythonExtractor();
    const base = `def greet(name):
    return 'hello ' + name
`;
    const commented = `# notes — with an em dash
${base}`;
    const before = (await extractor.extract(commented, 'src/greet.py')).find(
      (s) => s.name === 'greet',
    )!;
    const more = (
      await extractor.extract(commented.replace('an em dash', 'an em dash, more words'), 'src/greet.py')
    ).find((s) => s.name === 'greet')!;
    expect(more.fingerprint).toEqual(before.fingerprint);
    // a bigger, wider shift (3-byte and CJK chars) must not move it either
    const muchMore = (
      await extractor.extract(commented.replace('—', '——（中文注释）'), 'src/greet.py')
    ).find((s) => s.name === 'greet')!;
    expect(muchMore.fingerprint).toEqual(before.fingerprint);
    // while an edit to the symbol itself still registers
    const edited = (
      await extractor.extract(commented.replace("'hello '", "'hi '"), 'src/greet.py')
    ).find((s) => s.name === 'greet')!;
    expect(edited.fingerprint).not.toEqual(before.fingerprint);
  });

  it('visibility by Python convention: leading underscore internal; methods, nested defs and dunders absent', async () => {
    const code = `def public_fn():
    def inner():
        pass

    INNER_STATE = 1
    return inner

def _private_fn():
    pass

class _Helper:
    def method(self):
        CLASS_CONST = 1
        return 1

__all__ = ['public_fn']
__version__ = '1.0.0'
_HIDDEN = 2
CONST_OK = 3

if __name__ == '__main__':
    RUNNER = 1
`;
    const symbols = await createPythonExtractor().extract(code, 'src/mixed.py');
    expect(symbols.map((s) => `${s.name}:${s.visibility}`)).toEqual([
      'public_fn:public',
      '_private_fn:internal',
      '_Helper:internal',
      '_HIDDEN:internal',
      'CONST_OK:public',
    ]);
  });

  it('cuts # comments from fingerprints, but a docstring is body — editing it drifts the claim', async () => {
    const extractor = createPythonExtractor();
    const before = `# rate constant, per the spec
RATE = 0.5  # tuning knob

def compute(x):
    """Compute the thing, carefully."""
    return x * RATE
`;
    const base = await extractor.extract(before, 'src/rate.py');
    const rate = base.find((s) => s.name === 'RATE')!;
    const compute = base.find((s) => s.name === 'compute')!;

    // a comment change — inline or standalone — moves no hash
    const commented = await extractor.extract(
      before.replace('# tuning knob', '# tuning knob, v2').replace('# rate constant', '# the rate'),
      'src/rate.py',
    );
    expect(commented.find((s) => s.name === 'RATE')!.fingerprint).toEqual(rate.fingerprint);

    // a docstring edit: the signature still holds, the body moved
    const docEdited = await extractor.extract(
      before.replace('carefully', 'twice'),
      'src/rate.py',
    );
    const computeAfter = docEdited.find((s) => s.name === 'compute')!;
    expect(computeAfter.fingerprint.signature).toBe(compute.fingerprint.signature);
    expect(computeAfter.fingerprint.body).not.toBe(compute.fingerprint.body);

    // a real body edit moves the body hash
    const bodyEdited = await extractor.extract(
      before.replace('x * RATE', 'x * RATE + 1'),
      'src/rate.py',
    );
    expect(bodyEdited.find((s) => s.name === 'compute')!.fingerprint.body).not.toBe(
      compute.fingerprint.body,
    );
  });

  it('a decorated function keeps its decorators in the signature span', async () => {
    const extractor = createPythonExtractor();
    const code = `@app.route('/x')
@cached
def handler(req):
    return 'ok'
`;
    const symbols = await extractor.extract(code, 'src/api.py');
    expect(symbols.map((s) => s.name)).toEqual(['handler']);

    const handler = symbols[0];
    expect(text(code, handler.signature)).toContain("@app.route('/x')");
    expect(text(code, handler.signature)).toContain('@cached');
    expect(text(code, handler.signature)).toContain('def handler(req):');
    expect(text(code, handler.body)).toContain("return 'ok'");
    expect(text(code, handler.body)).not.toContain('@cached');

    // a decorator edit is an interface change: signature moves, body holds
    const reDecorated = await extractor.extract(code.replace('@cached\n', ''), 'src/api.py');
    const after = reDecorated[0];
    expect(after.fingerprint.signature).not.toBe(handler.fingerprint.signature);
    expect(after.fingerprint.body).toBe(handler.fingerprint.body);
  });

  it('emits one record per redefinition — same name, own fingerprint (the ADR-0006 set)', async () => {
    const code = `def value(x):
    return x

def value(y):
    return y + 1
`;
    const symbols = await createPythonExtractor().extract(code, 'src/shadow.py');
    const overloads = symbols.filter((s) => s.name === 'value');
    // both declarations are extracted, each with its own fingerprint;
    // downstream they share one file#name key and compare as a set
    expect(overloads).toHaveLength(2);
    expect(overloads[0].fingerprint.signature).not.toBe(overloads[1].fingerprint.signature);
  });

  it('fingerprints are stable across runs', async () => {
    const extractor = createPythonExtractor();
    const first = await extractor.extract(MODULE, 'src/geometry.py');
    const second = await extractor.extract(MODULE, 'src/geometry.py');
    expect(second.map((s) => s.fingerprint)).toEqual(first.map((s) => s.fingerprint));
  });
});
