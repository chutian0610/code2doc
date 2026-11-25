/**
 * Language-agnostic symbol extraction contract.
 *
 * Every language is one Extractor implementation; the core never branches
 * on language. Adding a language = adding an implementation + tests.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

/**
 * A region of source text. Offsets are string indices into the source —
 * web-tree-sitter reports node offsets in string units, and hashing
 * slices the source string with them (never bytes: the two diverge on
 * any multibyte character). row/col describe the start position.
 */
export interface Span {
  start: number;
  end: number;
  row: number;
  col: number;
}

export type Visibility = 'public' | 'internal';

/** Truncated hex length of each fingerprint hash (anchor payloads embed it). */
export const FINGERPRINT_HEX = 16;

/** The identity of a symbol as an anchor target: a pair of hashes. */
export interface Fingerprint {
  /** sha1 over the signature text (comments cut, whitespace stripped). */
  signature: string;
  /** sha1 over the body text (comments cut, whitespace stripped). */
  body: string;
}

/** The identity key of a symbol: `<file>#<name>` — the one spelling, used by anchors, edges and reports alike. Unambiguous because names are identifiers (`[\w$]+`, never `#`) and paths never contain one. */
export function symbolId(file: string, name: string): string {
  return `${file}#${name}`;
}

/** Parse a symbol-identity key; the last `#` separates (paths never contain one). */
export function parseSymbolId(key: string): { file: string; name: string } {
  const at = key.lastIndexOf('#');
  return { file: key.slice(0, at), name: key.slice(at + 1) };
}

/** One extracted symbol, the unit the cache stores and anchors target. */
export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** Repo-relative path. */
  file: string;
  signature: Span;
  body: Span;
  visibility: Visibility;
  fingerprint: Fingerprint;
}

/**
 * One import binding as the language layer extracted it. `named` carries
 * the imported name; `default` is the module's default export — claimed
 * but unresolvable by name, so the cascade must not fall through.
 */
export type ImportBinding =
  | { kind: 'named'; imported: string; source: string }
  | { kind: 'default'; source: string };

/**
 * The index probe the core hands a language's `resolveImport`: lookup by
 * path, and suffix enumeration for package-path forms. The language
 * constructs its own candidate paths; the core owns the index.
 */
export interface ImportIndex {
  /** Symbol names of one indexed file, or undefined when it is not indexed. */
  at(file: string): readonly string[] | undefined;
  /** Indexed files whose path equals `suffix` or ends with `/${suffix}`. */
  matching(suffix: string): readonly string[];
}

/**
 * Call references made from one file, the raw material of call edges
 * (ADR-0004). The query layer only captures *what is called and by whom*;
 * which caller–callee pairs become edges is the language-agnostic
 * disambiguation steps' job.
 */
export interface FileRefs {
  /**
   * Local import bindings: local name → what it imports and from where.
   * A namespace import itself is not a binding; a member call through
   * one (`ns.fn()`) is reported as a named claim on the module's source
   * (#26) — the only member-call shape a language may report when its
   * methods are not symbols.
   */
  imports: Record<string, ImportBinding>;
  /**
   * Caller (top-level function/variable symbol name, or the class for
   * heritage) → final identifiers it references, deduped.
   */
  callers: Record<string, string[]>;
}

/** The empty ref table: no imports, no calls. */
export function noRefs(): FileRefs {
  return { imports: {}, callers: {} };
}

/**
 * Collapse accumulated per-caller callee sets into a deterministic
 * `callers` map. Takes a Map — accumulator keys are arbitrary
 * identifiers, and a plain object would collide with
 * `Object.prototype` (`toString` reads through, `__proto__` writes
 * vanish, #21) — and returns a prototype-less record, so the same names
 * survive the round trip into the cache.
 */
export function collapseCallers(called: Map<string, Set<string>>): FileRefs['callers'] {
  const callers: FileRefs['callers'] = Object.create(null);
  for (const caller of [...called.keys()].sort()) {
    callers[caller] = [...called.get(caller)!].sort();
  }
  return callers;
}

/**
 * The ref accumulator every extractor feeds: `note(caller, name)`
 * during the walk, `finish()` for the deterministic `callers` record.
 * One home for the Map-in/prototype-less-out policy (#21) so adapters
 * cannot drift apart on it again — the third language inherits this
 * instead of copying a third spelling.
 */
export function refCollector(): {
  note(caller: string | undefined, name: string): void;
  finish(): FileRefs['callers'];
} {
  const called = new Map<string, Set<string>>();
  return {
    note(caller, name) {
      if (!caller) return;
      const callees = called.get(caller);
      if (callees) callees.add(name);
      else called.set(caller, new Set([name]));
    },
    finish: () => collapseCallers(called),
  };
}

/**
 * The claims accumulator every extractor feeds: import bindings plus
 * the namespace probe member calls resolve through (#26) — one home
 * for the Map-in/prototype-less and never-overwrite policies so
 * adapters cannot drift apart on them. A member-call claim never
 * overwrites an explicit from-import of the same name: the overwrite
 * would point the bare call at the wrong module's symbol, which is
 * exactly the false edge ADR-0004 forbids — the member call yields
 * instead (a missing edge, never a false one).
 */
export function claimCollector(): {
  imports: FileRefs['imports'];
  /** Namespace bindings: dotted local name → the module's source. */
  namespaces: Map<string, string>;
  /** Claim `prop` to the module `base` names; undefined when base names no binding or `prop` is already claimed. */
  claimViaNamespace(base: string | undefined, prop: string): string | undefined;
} {
  // prototype-less from the start: local names are arbitrary
  // identifiers, and `toString`/`__proto__` must be plain keys (#21)
  const imports: FileRefs['imports'] = Object.create(null);
  const namespaces = new Map<string, string>();
  return {
    imports,
    namespaces,
    claimViaNamespace(base, prop) {
      const source = base === undefined ? undefined : namespaces.get(base);
      if (!source || prop in imports) return undefined;
      imports[prop] = { kind: 'named', imported: prop, source };
      return source;
    },
  };
}

export interface Extractor {
  languageId: string;
  /** File extensions this extractor claims (with dot, lowercase). */
  extensions: string[];
  extract(code: string, file: string): Promise<SymbolRecord[]>;
  /**
   * Call refs per ADR-0004. Absent = the language has no edge extraction
   * yet: no edges, and no ripple, for its files.
   */
  extractRefs?(code: string, file: string): Promise<FileRefs>;
  /**
   * Resolve one import binding of this language to an indexed
   * `file#name`, or undefined. Where import resolution lives (ADR-0005):
   * the language knows its specifier forms, the core only hands the
   * index probe. Absent behaves like unresolved: no edge, no fall-through.
   */
  resolveImport?(file: string, binding: ImportBinding, index: ImportIndex): string | undefined;
}
