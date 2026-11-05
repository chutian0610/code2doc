import { describe, it, expect } from 'vitest';
import { createJavaExtractor } from '../../src/extractor/java.js';
import type { Span } from '../../src/extractor/types.js';

function text(code: string, span: Span): string {
  return code.slice(span.start, span.end);
}

const GREETER = `package demo;

public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }

  String casualGreet(String name) {
    return "hi " + name;
  }

  private String secret() {
    return "shh";
  }
}
`;

describe('Java extractor', () => {
  it('extracts a public class and its methods with spans, visibility and stable ids', async () => {
    const extractor = createJavaExtractor();
    const symbols = await extractor.extract(GREETER, 'src/Greeter.java');

    expect(symbols.map((s) => s.name)).toEqual(['Greeter', 'greet', 'casualGreet', 'secret']);

    const cls = symbols[0];
    expect(cls.kind).toBe('class');
    expect(cls.visibility).toBe('public');
    expect(cls.id).toBe('src/Greeter.java#Greeter@2');
    // class signature = the header, modifiers included, body excluded
    expect(text(GREETER, cls.signature)).toContain('public class Greeter');
    expect(text(GREETER, cls.signature)).not.toContain('return');
    expect(text(GREETER, cls.body)).toContain('"hello " + name');

    const greet = symbols[1];
    expect(greet.kind).toBe('function');
    expect(greet.visibility).toBe('public');
    expect(greet.id).toBe('src/Greeter.java#greet@3');
    // method signature covers modifiers, return type and parameters
    expect(text(GREETER, greet.signature)).toContain('public String greet(String name)');
    expect(text(GREETER, greet.signature)).not.toContain('return');
    expect(text(GREETER, greet.body)).toContain('"hello " + name');

    // fingerprints derive from span content and are stable across runs
    const again = await extractor.extract(GREETER, 'src/Greeter.java');
    expect(again[1].fingerprint.signature).toBe(greet.fingerprint.signature);
    expect(again[1].fingerprint.body).toBe(greet.fingerprint.body);
  });

  it('maps visibility by Java rules: only public is public, package-private/protected/private are internal', async () => {
    const code = `class Helper {
  int helperValue() { return 1; }
  protected void warn() { }
  public int visible() { return 2; }
  static final int CONST = 3;
}
`;
    const symbols = await createJavaExtractor().extract(code, 'src/Helper.java');
    const find = (n: string) => symbols.find((s) => s.name === n)!;

    // no access modifier = package-private = internal (the Java-specific rule)
    expect(find('Helper').visibility).toBe('internal');
    expect(find('helperValue').visibility).toBe('internal');
    expect(find('warn').visibility).toBe('internal');
    expect(find('visible').visibility).toBe('public');
    // fields are part of the class body, never symbols of their own
    expect(symbols.some((s) => s.name === 'CONST')).toBe(false);
  });

  it('extracts interfaces, enums and records; interface members are implicitly public', async () => {
    const code = `public interface Speaker {
  String speak();
  default String loud() { return speak() + "!"; }
  private String quiet() { return speak(); }
}

public enum Color {
  RED, GREEN;
  public String label() { return name().toLowerCase(); }
  String raw() { return name(); }
}

public record Point(int x, int y) {
  public int sum() { return x + y; }
}
`;
    const symbols = await createJavaExtractor().extract(code, 'src/Shapes.java');
    const find = (n: string) => symbols.find((s) => s.name === n)!;

    // interface members carry no modifier yet are public per the language
    expect(find('Speaker').kind).toBe('interface');
    expect(find('speak').visibility).toBe('public');
    // a body-less method: signature is the whole declaration
    expect(text(code, find('speak').signature)).toBe('String speak();');
    expect(find('loud').visibility).toBe('public');
    expect(find('quiet').visibility).toBe('internal');

    // enum members follow modifier rules (no implicit public)
    expect(find('Color').kind).toBe('enum');
    expect(text(code, find('Color').signature)).toContain('enum Color');
    expect(find('label').visibility).toBe('public');
    expect(find('raw').visibility).toBe('internal');

    // records have no kind of their own — they are classes (no core change)
    expect(find('Point').kind).toBe('class');
    expect(text(code, find('Point').signature).trim()).toBe('public record Point(int x, int y)');
    expect(find('sum').visibility).toBe('public');
  });

  it('skips constructors, nested and local declarations; only top-level types and their direct methods count', async () => {
    const code = `public class Outer {
  public Outer(int seed) { }

  public static class Nested {
    public void nestedWork() { }
  }

  public void work() {
    class Local {
      void localWork() { }
    }
  }
}

@interface Marker {
  String value() default "";
}
`;
    const symbols = await createJavaExtractor().extract(code, 'src/Outer.java');
    expect(symbols.map((s) => s.name)).toEqual(['Outer', 'work']);
    // the constructor would collide with the class name in file#name anchor lookup
    expect(symbols.some((s) => s.name === 'Nested')).toBe(false);
    expect(symbols.some((s) => s.name === 'nestedWork')).toBe(false);
    expect(symbols.some((s) => s.name === 'Local')).toBe(false);
  });
});

describe('Java fingerprint invariance (T2 parity: no false signals)', () => {
  const extractGreet = async (code: string) => {
    const symbols = await createJavaExtractor().extract(code, 'src/Greeter.java');
    return symbols.find((s) => s.name === 'greet')!;
  };

  it('ignores comments inside the body', async () => {
    const commented = `public class Greeter {
  public String greet(String name) {
    // enthusiastic greeting
    return /* inline */ "hello " + name;
  }
}
`;
    const [a, b] = await Promise.all([extractGreet(`public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }
}
`), extractGreet(commented)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).toBe(a.fingerprint.body);
  });

  it('ignores comments inside the signature', async () => {
    const commented = `public class Greeter {
  public String greet(String /* the person */ name) {
    return "hello " + name;
  }
}
`;
    const [a, b] = await Promise.all([extractGreet(`public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }
}
`), extractGreet(commented)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
  });

  it('ignores whitespace-only reflow (indentation, line breaks, space runs)', async () => {
    const reformatted = `public class Greeter {
      public String greet(String name) {
            return
                "hello "   +   name;
      }
}
`;
    const [a, b] = await Promise.all([extractGreet(`public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }
}
`), extractGreet(reformatted)]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).toBe(a.fingerprint.body);
  });

  it('keeps single-space differences significant, including inside strings', async () => {
    const edited = `public class Greeter {
  public String greet(String name) {
    return "hello" + name;
  }
}
`;
    const [a, b] = await Promise.all([extractGreet(`public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }
}
`), extractGreet(edited)]);
    expect(b.fingerprint.body).not.toBe(a.fingerprint.body);
  });

  it('still signals drift when the body changes and broken when the signature changes', async () => {
    const base = `public class Greeter {
  public String greet(String name) {
    return "hello " + name;
  }
}
`;
    const bodyEdit = `public class Greeter {
  public String greet(String name) {
    return "hi " + name;
  }
}
`;
    const signatureEdit = `public class Greeter {
  public String greet(String name, String prefix) {
    return "hello " + name;
  }
}
`;
    const [a, b, c] = await Promise.all([
      extractGreet(base),
      extractGreet(bodyEdit),
      extractGreet(signatureEdit),
    ]);
    expect(b.fingerprint.signature).toBe(a.fingerprint.signature);
    expect(b.fingerprint.body).not.toBe(a.fingerprint.body);
    expect(c.fingerprint.signature).not.toBe(a.fingerprint.signature);
    expect(c.fingerprint.body).toBe(a.fingerprint.body);
  });
});
