import type { CacheData } from './cache.js';
import { extractorForFile } from './extractor/registry.js';
import type { ImportIndex } from './extractor/types.js';

/**
 * Ripple's engine room (ADR-0004). Two language-agnostic halves:
 * the disambiguation cascade that turns raw call refs into edges, and
 * the cache-baseline diff that decides which symbols moved since the
 * previous `status`. Both are deliberately name-level — a missing edge
 * is tolerated, a false edge never is.
 */

/** Resolved call edges: caller `file#name` → callee `file#name`s. */
export type EdgeMap = Map<string, string[]>;

/** How a symbol went stale since the previous status cache. */
export type ChangeState = 'broken' | 'drift';

/** Symbols whose fingerprints moved since the previous status, keyed `file#name`. */
export type ChangeMap = Map<string, ChangeState>;

/** One stale callee under an anchored symbol, with its propagation path. */
export interface Ripple {
  /** `file#name` of the callee that went stale. */
  symbol: string;
  state: ChangeState;
  /** First hop from the anchored symbol on the propagation path. */
  via: string;
  /** Hops from the anchored symbol to the stale callee. */
  depth: number;
}

/** The index probe handed to a language's resolveImport (ADR-0005). */
function importIndex(cache: CacheData): ImportIndex {
  const namesOf = new Map<string, readonly string[]>();
  return {
    at(file) {
      if (!(file in cache.files)) return undefined;
      let names = namesOf.get(file);
      if (names === undefined) {
        names = cache.files[file].symbols.map((s) => s.name);
        namesOf.set(file, names);
      }
      return names;
    },
    matching(suffix) {
      return Object.keys(cache.files).filter((p) => p === suffix || p.endsWith(`/${suffix}`));
    },
  };
}

/**
 * The disambiguation steps, per callee name in a file: import resolution → same-file
 * uniqueness → global-name uniqueness → no edge. Import resolution is
 * the language's own job behind the Extractor interface (ADR-0005) —
 * the core knows no specifier forms. An ambiguous name at any
 * uniqueness step yields nothing; a name claimed by an import never
 * falls through, whatever the import resolved to.
 */
export function resolveEdges(cache: CacheData): EdgeMap {
  const byName = new Map<string, string[]>(); // global name → `file#name`s, for the uniqueness counts
  const inFile = new Map<string, Map<string, number>>(); // file → name → count
  for (const [file, entry] of Object.entries(cache.files)) {
    const names = inFile.get(file) ?? new Map<string, number>();
    for (const symbol of entry.symbols) {
      names.set(symbol.name, (names.get(symbol.name) ?? 0) + 1);
      const key = `${file}#${symbol.name}`;
      byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), key]);
    }
    inFile.set(file, names);
  }

  // A bare name never crosses languages: a same-named symbol behind a
  // different extractor is not this call's callee, and "resolving" to it
  // would be exactly the false edge ADR-0004 forbids.
  const langs = new Map<string, string>();
  const langOf = (file: string): string => {
    let lang = langs.get(file);
    if (lang === undefined) {
      lang = extractorForFile(file)?.languageId ?? '';
      langs.set(file, lang);
    }
    return lang;
  };

  const index = importIndex(cache);
  const edges: EdgeMap = new Map();
  for (const [file, entry] of Object.entries(cache.files)) {
    const resolveImport = extractorForFile(file)?.resolveImport;
    for (const [caller, callees] of Object.entries(entry.refs.callers)) {
      const resolved = new Set<string>();
      for (const name of callees) {
        const binding = entry.refs.imports[name];
        if (binding) {
          const target = resolveImport?.(file, binding, index);
          if (target) resolved.add(target);
          continue; // the import claims the name: no same-file/global fallback
        }
        const sameFile = inFile.get(file)?.get(name) ?? 0;
        if (sameFile === 1) {
          resolved.add(`${file}#${name}`);
        } else if (sameFile === 0) {
          const inLanguage = (byName.get(name) ?? []).filter(
            (key) => langOf(key.slice(0, key.lastIndexOf('#'))) === langOf(file),
          );
          if (inLanguage.length === 1) resolved.add(inLanguage[0]);
        } // 0 candidates or in-language ambiguity → no edge, per the never-false rule
      }
      if (resolved.size > 0) edges.set(`${file}#${caller}`, [...resolved].sort());
    }
  }
  return edges;
}

/**
 * The cache baseline: symbols of the previous status that are gone now
 * (broken), whose signature hash moved (broken), or whose body hash
 * moved (drift). Newly added symbols are deliberately absent — Ripple
 * reports what moved under an unchanged anchor, and a symbol the
 * previous run never saw cannot have been claimed by one.
 */
export function changedSince(prev: CacheData | undefined, curr: CacheData): ChangeMap {
  const changed: ChangeMap = new Map();
  if (!prev) return changed; // fresh-clone first run: no baseline, ripple-silent
  for (const [file, entry] of Object.entries(prev.files)) {
    const current = new Map((curr.files[file]?.symbols ?? []).map((s) => [s.name, s]));
    for (const symbol of entry.symbols) {
      const key = `${file}#${symbol.name}`;
      const now = current.get(symbol.name);
      if (!now) changed.set(key, 'broken');
      else if (now.fingerprint.signature !== symbol.fingerprint.signature) changed.set(key, 'broken');
      else if (now.fingerprint.body !== symbol.fingerprint.body) changed.set(key, 'drift');
    }
  }
  return changed;
}

/**
 * Ripple propagation as reverse single-source reachability: from each
 * changed symbol, walk caller edges backwards and record every symbol
 * reached, with the shortest path — `via` is the reached symbol's own
 * callee on that path, `depth` the path's length (one hop at depth 1
 * means the changed symbol itself). Cost scales with the ancestry of
 * the change set, not with the anchor count; a changed symbol is never
 * rippled by its own change.
 */
export function ripplesUnder(edges: EdgeMap, changed: ChangeMap): Map<string, Ripple[]> {
  const callersOf = new Map<string, string[]>();
  for (const [caller, callees] of edges) {
    for (const callee of callees) {
      callersOf.set(callee, [...(callersOf.get(callee) ?? []), caller]);
    }
  }
  const under = new Map<string, Ripple[]>();
  for (const [symbol, state] of changed) {
    // BFS backwards: the walk's parent yields via, its length yields depth
    const walk = new Map<string, { via: string; depth: number }>([[symbol, { via: symbol, depth: 0 }]]);
    const queue = [symbol];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const caller of callersOf.get(current) ?? []) {
        if (walk.has(caller)) continue; // seen — BFS keeps the shortest path
        walk.set(caller, { via: current, depth: walk.get(current)!.depth + 1 });
        queue.push(caller);
      }
    }
    for (const [reached, { via, depth }] of walk) {
      if (reached === symbol) continue; // never rippled by its own change
      const list = under.get(reached) ?? [];
      list.push({ symbol, state, via, depth });
      under.set(reached, list);
    }
  }
  for (const list of under.values()) list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return under;
}
