import { describe, it, expect } from 'vitest';
import { createJavaExtractor } from '../../src/extractor/java.js';
import type { ImportBinding, ImportIndex } from '../../src/extractor/types.js';

/**
 * V2-3: Java call-ref extraction at parity with TS/JS (ADR-0004) —
 * method invocation by its name field (bare, member and chained calls
 * alike), construction, extends/implements; references without a call
 * are ignored; attribution lands on the enclosing top-level method
 * (methods are symbols here) or, for heritage, the class itself.
 */

const CODE = `package demo;

import demo.other.Base;
import demo.other.Ifc;
import demo.deep.Thing;
import static demo.other.K.tool;
import demo.wide.*;
import java.util.List;

class Local {}

public class Greeter extends Base implements Ifc {
  private String prefix = make();         // field initializer: no caller symbol
  public Greeter() {
    helper();                             // constructor body: no caller symbol
  }
  public String greet(String name) {
    helper();
    this.helper(name);
    Greeter.other.tool();
    new Local();
    new demo.deep.Thing();
    tool();
    Runnable r = this::helper;            // method reference: no call
    Object f = this.helper;               // field access, no invocation
    return prefix + name;
  }
  void helper(String n) {
    List.of(n);
  }
}
`;

function view(refs: { callers: Record<string, string[]>; imports: Record<string, unknown> }) {
  // prototype-less: caller names colliding with Object.prototype must not warp the view
  const callers: Record<string, string[]> = Object.create(null);
  for (const [caller, callees] of Object.entries(refs.callers)) {
    callers[caller] = [...callees].sort();
  }
  return { callers, imports: refs.imports };
}

describe('Java extractor — call refs (ADR-0004, V2-3)', () => {
  it('captures method invocations by name field: bare, this-, chained and static-import calls', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs!(CODE, 'src/Greeter.java'));
    expect(callers.greet).toContain('helper'); // bare call
    expect(callers.greet).toContain('tool'); // static-import call and Greeter.other.tool()
    expect(callers.greet).toContain('Local'); // new of a same-file class
    expect(callers.greet).toContain('Thing'); // new with a fully-qualified name — final segment
    expect(callers.helper).toEqual(['of']); // List.of — member call by name field
  });

  it('captures construction and extends/implements, attributing heritage to the class', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs!(CODE, 'src/Greeter.java'));
    expect(callers.Greeter).toEqual(['Base', 'Ifc']); // heritage: the class is the caller
  });

  it('a toString override is a caller like any other — no Object.prototype collision (#21)', async () => {
    // methods are symbols here, so every Java class overriding toString()
    // makes it a caller; the accumulator must not reach the prototype
    // chain (this shape crashed init outright on real repos)
    const code = `package demo;
public class Json {
  public String toString() { return String.valueOf(helperValue()); }
  int helperValue() { return 1; }
}
`;
    const { callers } = view(await createJavaExtractor().extractRefs!(code, 'src/Json.java'));
    expect(callers.toString).toEqual(['helperValue', 'valueOf']);
  });

  it('drops calls with no enclosing top-level method: constructor bodies and field initializers', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs!(CODE, 'src/Greeter.java'));
    expect(Object.keys(callers).sort()).toEqual(['Greeter', 'greet', 'helper']);
  });

  it('ignores method references and field accesses — no invocation, no callee', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs!(CODE, 'src/Greeter.java'));
    // this::helper and this.helper appear as values, never as calls
    expect(callers.greet.filter((c) => c === 'helper').length).toBe(1); // just the bare helper() call
  });

  it('normalizes imports to package-path form; wildcards claim nothing', async () => {
    const { imports } = view(await createJavaExtractor().extractRefs!(CODE, 'src/Greeter.java'));
    expect(imports.Base).toEqual({ kind: 'named', imported: 'Base', source: 'demo/other/Base.java' });
    expect(imports.Thing).toEqual({ kind: 'named', imported: 'Thing', source: 'demo/deep/Thing.java' });
    expect(imports.tool).toEqual({ kind: 'named', imported: 'tool', source: 'demo/other/K.java' }); // static import: path is the class
    // external libraries claim their name too — resolution finds no indexed file, so no edge
    expect(imports.List).toEqual({ kind: 'named', imported: 'List', source: 'java/util/List.java' });
    // the wildcard import (demo.wide.*) binds nothing at all
    expect(Object.values(imports).some((b) => JSON.stringify(b).includes('demo/wide'))).toBe(false);
  });
});

describe('Java extractor — resolveImport (ADR-0005)', () => {
  const files = ['src/main/java/demo/other/Base.java', 'src/main/demo/other/Ifc.java'];
  const index: ImportIndex = {
    at: (file) => ({ 'src/main/java/demo/other/Base.java': ['Base'], 'src/main/demo/other/Ifc.java': ['Unrelated'] })[file],
    matching: (suffix) => files.filter((p) => p === suffix || p.endsWith(`/${suffix}`)),
  };
  const extractor = createJavaExtractor();
  const resolve = (binding: ImportBinding) => extractor.resolveImport!('src/Greeter.java', binding, index);

  it('resolves a package path by unique indexed-file suffix, whatever the package root', () => {
    expect(resolve({ kind: 'named', imported: 'Base', source: 'demo/other/Base.java' })).toBe(
      'src/main/java/demo/other/Base.java#Base',
    );
  });

  it('external libraries, ambiguous suffixes and absent names resolve nothing', () => {
    expect(resolve({ kind: 'named', imported: 'List', source: 'java/util/List.java' })).toBeUndefined();
    // two roots carrying the same package path → ambiguous → no edge
    const twoRoots: ImportIndex = {
      ...index,
      matching: (suffix) => [
        'src/main/java/demo/other/Base.java',
        'src/test/demo/other/Base.java',
      ].filter((p) => p === suffix || p.endsWith(`/${suffix}`)),
    };
    expect(extractor.resolveImport!('src/Greeter.java', { kind: 'named', imported: 'Base', source: 'demo/other/Base.java' }, twoRoots)).toBeUndefined();
    // matched file lacks the name → no edge
    expect(resolve({ kind: 'named', imported: 'Ifc', source: 'demo/other/Ifc.java' })).toBeUndefined();
  });

  it('a same-package claim resolves by package path, then by bare file name (#41)', () => {
    const files = ['src/main/java/demo/Peer.java', 'src/other/Arrays.java'];
    const index: ImportIndex = {
      at: (file) =>
        ({ 'src/main/java/demo/Peer.java': ['peerMethod'], 'src/other/Arrays.java': ['asList'] })[file],
      matching: (suffix) => files.filter((p) => p === suffix || p.endsWith(`/${suffix}`)),
    };
    const extractor = createJavaExtractor();
    // the package-path suffix settles it first
    expect(
      extractor.resolveImport!(
        'src/main/java/demo/Greeter.java',
        { kind: 'same-package', imported: 'peerMethod', source: 'demo/Peer.java' },
        index,
      ),
    ).toBe('src/main/java/demo/Peer.java#peerMethod');
    // one package laid across source roots: the package path misses, the
    // bare file name (unique) still finds it
    expect(
      extractor.resolveImport!(
        'src/main/java/demo/Greeter.java',
        { kind: 'same-package', imported: 'asList', source: 'demo/Arrays.java' },
        index,
      ),
    ).toBe('src/other/Arrays.java#asList');
    // ambiguity anywhere resolves nothing
    const twoPeers: ImportIndex = {
      ...index,
      matching: (suffix) =>
        ['src/main/java/demo/Peer.java', 'src/test/java/demo/Peer.java'].filter(
          (p) => p === suffix || p.endsWith(`/${suffix}`),
        ),
    };
    expect(
      extractor.resolveImport!(
        'src/main/java/demo/Greeter.java',
        { kind: 'same-package', imported: 'peerMethod', source: 'demo/Peer.java' },
        twoPeers,
      ),
    ).toBeUndefined();
  });
});

describe('Java extractor — receiver-type rule (ADR-0004 amendment, #41)', () => {
  const CODE = `package demo;

import java.util.List;
import java.util.concurrent.TimeUnit;

class Helper {
  void acquire() {}
}

public class Greeter {
  private Helper helper = new Helper();
  private List<String> names = List.of();

  void callsField() {
    helper.acquire();               // declared Helper, same-file top-level → claimed
  }

  void callsParam(Helper param) {
    param.acquire();                // declared param type → claimed
  }

  void callsSet(List<String> set) {
    set.add("x");                   // List is a JDK import — claimed against the FQCN, resolves nothing
  }

  void callsThis() {
    this.callsField();              // this receiver → claimed
  }

  void callsJdkStatic() {
    TimeUnit.SECONDS.toMillis(1);   // TimeUnit is an import — resolves nothing
  }

  void callsChain() {
    helper.acquire().toString();    // the chained tail's receiver is a call → not reported
  }

  class Impl {
    void createAdapter() {}
  }

  void callsInner(Impl impl) {
    impl.createAdapter();           // Impl is an inner class, not a top-level type → not reported
  }
}
`;

  /** callers view with deterministic ordering, imports as a plain object. */
  function view(refs: { callers: Record<string, string[]> }): Record<string, string[]> {
    const callers: Record<string, string[]> = Object.create(null);
    for (const [caller, callees] of Object.entries(refs.callers)) callers[caller] = [...callees].sort();
    return callers;
  }

  it('claims member calls whose receiver type is a same-file top-level symbol', async () => {
    const callers = view(await createJavaExtractor().extractRefs!(CODE, 'src/main/java/demo/Greeter.java'));
    expect(callers.callsField).toEqual(['acquire']);
    expect(callers.callsParam).toEqual(['acquire']);
    expect(callers.callsThis).toEqual(['callsField']);
  });

  it('claims same-package explicit-class statics through the package form (#41)', async () => {
    // Peer has no import (same package) and lives outside this file: the
    // claim lands on the caller's package path, so resolveImport settles
    // it by unique suffix across source roots
    const code = `package demo;

public class Greeter {
  void callsPeer() {
    Peer.peerMethod();
  }
}
`;
    const refs = await createJavaExtractor().extractRefs!(code, 'src/main/java/demo/Greeter.java');
    expect(view(refs).callsPeer).toEqual(['peerMethod']);
    expect(refs.imports.peerMethod).toEqual({
      kind: 'same-package',
      imported: 'peerMethod',
      source: 'demo/Peer.java',
    });
  });

  it('does not claim JDK-typed, inner-classed or chained receivers — missing edges, never false ones', async () => {
    const refs = await createJavaExtractor().extractRefs!(CODE, 'src/main/java/demo/Greeter.java');
    const callers = view(refs);
    // set.add: List is a JDK import — the claim lands on the FQCN and resolves nothing
    expect(callers.callsSet).toEqual(['add']);
    expect((refs.imports.add as { source: string }).source).toBe('java/util/List.java');
    // Impl is an inner class — not a top-level type, not an import: no claim at all
    expect(callers.callsInner).toBeUndefined();
    // the chained tail's receiver is a call result — no claim
    expect(callers.callsChain).toEqual(['acquire']);
    expect(callers.callsChain).not.toContain('toString');
    // TimeUnit.SECONDS: the claim lands on the JDK FQCN and resolves nothing
    expect(callers.callsJdkStatic).toEqual(['toMillis']);
    expect((refs.imports.toMillis as { source: string }).source).toBe('java/util/concurrent/TimeUnit.java');
  });
});
