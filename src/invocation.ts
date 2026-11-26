// The short launchers and what each one runs. The launcher is told apart by the
// name of the file Node was started with. On macOS and Linux npm links the bin
// name itself (`tax` -> dist/src/bin/tax.js), so argv[1] ends in `tax`. npm's
// Windows shims start every bin as `node <file>`, so there argv[1] is the file:
// when every launcher pointed at cli.js, `tax` arrived as `cli.js` and ran as
// plain `teamai`. Each launcher therefore has a file of its own (src/bin/), and
// both shapes resolve here.
const LAUNCHERS = new Map<string, readonly string[]>([
  ['tai', ['start']],
  ['taic', ['run', 'claude']],
  ['tax', ['run', 'codex']],
  ['tag', ['run', 'grok']],
]);

export function launcherName(argv1: string | undefined): string {
  const file = (argv1 || 'teamai').split(/[\\/]/).pop() || 'teamai';
  // Windows file names are case-insensitive, so the launcher name is too.
  return file.replace(/\.(?:c?js|mjs|ts)$/i, '').toLowerCase();
}

export function resolveInvocation(argv1: string | undefined, inputArgs: string[]): string[] {
  return [...(LAUNCHERS.get(launcherName(argv1)) ?? []), ...inputArgs];
}
