import path from 'node:path';

/** Repo-internal paths are stored with forward slashes everywhere. */
export const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Directory part of a repo-relative posix path ('.' for root-level files). */
export const dirOf = (file: string): string => {
  const idx = file.lastIndexOf('/');
  return idx === -1 ? '.' : file.slice(0, idx);
};

/** Canonical form of a manifest "module" directory: no './' prefix, no trailing '/'. */
export const normalizeModuleDir = (module: string): string =>
  module.replace(/^\.?\//, '').replace(/\/+$/, '') || '.';
