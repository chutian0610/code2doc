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
 * A region of source text. Offsets are UTF-8 byte offsets into the file
 * (as produced by tree-sitter); row/col describe the start position.
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

/** One extracted symbol, the unit the cache stores and anchors target. */
export interface SymbolRecord {
  /** Stable identity: `<file>#<name>@<signature start row>` */
  id: string;
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
 * Call references made from one file, the raw material of call edges
 * (ADR-0004). The query layer only captures *what is called and by whom*;
 * which caller–callee pairs become edges is the language-agnostic
 * disambiguation cascade's job.
 */
export interface FileRefs {
  /**
   * Local import bindings: local name → what it imports and from where.
   * `imported: ''` marks a default import (unresolvable by name);
   * namespace imports are not listed (member calls resolve by their
   * final identifier through the cascade instead).
   */
  imports: Record<string, { imported: string; source: string }>;
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

/** Collapse accumulated per-caller callee sets into a deterministic `callers` map. */
export function collapseCallers(called: Record<string, Set<string>>): FileRefs['callers'] {
  const callers: FileRefs['callers'] = {};
  for (const caller of Object.keys(called).sort()) {
    callers[caller] = [...called[caller]].sort();
  }
  return callers;
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
}
