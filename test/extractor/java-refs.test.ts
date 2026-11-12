import { describe, it, expect } from 'vitest';
import { createJavaExtractor } from '../../src/extractor/java.js';

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
  const callers: Record<string, string[]> = {};
  for (const [caller, callees] of Object.entries(refs.callers)) {
    callers[caller] = [...callees].sort();
  }
  return { callers, imports: refs.imports };
}

describe('Java extractor — call refs (ADR-0004, V2-3)', () => {
  it('captures method invocations by name field: bare, this-, chained and static-import calls', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs(CODE, 'src/Greeter.java'));
    expect(callers.greet).toContain('helper'); // bare call
    expect(callers.greet).toContain('tool'); // static-import call and Greeter.other.tool()
    expect(callers.greet).toContain('Local'); // new of a same-file class
    expect(callers.greet).toContain('Thing'); // new with a fully-qualified name — final segment
    expect(callers.helper).toEqual(['of']); // List.of — member call by name field
  });

  it('captures construction and extends/implements, attributing heritage to the class', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs(CODE, 'src/Greeter.java'));
    expect(callers.Greeter).toEqual(['Base', 'Ifc']); // heritage: the class is the caller
  });

  it('drops calls with no enclosing top-level method: constructor bodies and field initializers', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs(CODE, 'src/Greeter.java'));
    expect(Object.keys(callers).sort()).toEqual(['Greeter', 'greet', 'helper']);
  });

  it('ignores method references and field accesses — no invocation, no callee', async () => {
    const { callers } = view(await createJavaExtractor().extractRefs(CODE, 'src/Greeter.java'));
    // this::helper and this.helper appear as values, never as calls
    expect(callers.greet.filter((c) => c === 'helper').length).toBe(1); // just the bare helper() call
  });

  it('normalizes imports to package-path form; wildcards claim nothing', async () => {
    const { imports } = view(await createJavaExtractor().extractRefs(CODE, 'src/Greeter.java'));
    expect(imports.Base).toEqual({ imported: 'Base', source: 'demo/other/Base.java' });
    expect(imports.Thing).toEqual({ imported: 'Thing', source: 'demo/deep/Thing.java' });
    expect(imports.tool).toEqual({ imported: 'tool', source: 'demo/other/K.java' }); // static import: path is the class
    // external libraries claim their name too — the core's suffix match finds no indexed file, so no edge
    expect(imports.List).toEqual({ imported: 'List', source: 'java/util/List.java' });
    // the wildcard import (demo.wide.*) binds nothing at all
    expect(Object.values(imports).some((b) => JSON.stringify(b).includes('demo/wide'))).toBe(false);
  });
});
