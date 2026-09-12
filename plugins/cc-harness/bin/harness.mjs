#!/usr/bin/env node
import { run } from '../lib/cli.mjs';

const code = await run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.exitCode = code;
