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

/** The identity of a symbol as an anchor target: a pair of hashes. */
export interface Fingerprint {
  /** sha1 over the signature bytes (whitespace-collapsed, truncated hex). */
  signature: string;
  /** sha1 over the body bytes (whitespace-collapsed, truncated hex). */
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

export interface Extractor {
  languageId: string;
  /** File extensions this extractor claims (with dot, lowercase). */
  extensions: string[];
  extract(code: string, file: string): Promise<SymbolRecord[]>;
}
