#!/usr/bin/env node
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';

// Exit codes: 0 clean, 1 Drift-only, 2 any Broken/Missing (report codes);
// 3 reserved for tool failure, so report semantics stay unpolluted.
const EXIT_FAILURE = 3;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      return runInit(process.cwd());
    case 'status':
      return runStatus(process.cwd(), rest);
    default:
      console.error('usage: code2doc <init|status> [--json]');
      return EXIT_FAILURE;
  }
}

// exitCode (never process.exit): piped stdout on macOS writes
// asynchronously, and process.exit would truncate large reports at the
// 64KiB kernel pipe buffer before libuv flushes them.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_FAILURE;
  });
