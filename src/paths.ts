import path from 'node:path';

/** Repo-internal paths are stored with forward slashes everywhere. */
export const toPosix = (p: string): string => p.split(path.sep).join('/');
