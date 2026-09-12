const USAGE = `usage: harness <command>

  hook <PreToolUse|PostToolUse|Stop|SessionStart>   run guards for a hook event (stdin: hook JSON)
  init [--preset ts|custom] [--types a,b] [--scopes a,b] [--marketplace owner/repo|path] [--force] [--dry-run] [--target dir]
  doctor [--target dir]
  sync-rules [--target dir]
  version
`;

export async function run(argv, io) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook':
      return runHook(rest[0], io);
    case 'init':
      return runInit(rest, io);
    case 'doctor':
      return runDoctor(rest, io);
    case 'sync-rules':
      return runSyncRules(rest, io);
    case 'version':
      io.stdout.write('0.1.0\n');
      return 0;
    case undefined:
    case '--help':
    case '-h':
      io.stdout.write(USAGE);
      return 0;
    default:
      io.stderr.write(`harness: unknown command "${cmd}"\n${USAGE}`);
      return 1;
  }
}

async function runHook(event, io) {
  // T2–T5 replace this. Until then: drain stdin, stay silent.
  for await (const _ of io.stdin) { /* drain */ }
  return 0;
}
async function runInit(args, io) { return 0; }        // T6
async function runDoctor(args, io) { return 0; }      // T5
async function runSyncRules(args, io) { return 0; }   // T6
