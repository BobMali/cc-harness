# Follow-ups

Open items found during review that were deliberately not fixed in the branch that found them. Each names where it came from and what closing it takes.

## Guards

- **Shell-wrapped git commands bypass the git guard.** `bash -c "git reset --hard"` (also `sh -c`, `zsh -c`) hides the `git` word from `resolveTool`, so the destructive-git list never applies. Found by the harness final review; kept in scope by the eval plan (adversarial vector `bash -c "git reset --hard"`, `known_gap`). Fix: when the tool word is a shell with `-c`, re-run segment analysis on the quoted argument.
- **`git push origin :branch` deletes a remote branch unprompted.** Found while building the eval runner fixture. Fix: in the push rule, ask on any refspec starting with `:` and on `--delete`/`-d`.
- **Commit guard crashes on `-F <directory>`.** `fs.readFileSync` throws EISDIR; the dispatcher turns it into an `ask`, so it fails safe. Found by the eval runner's crash detection. Fix: wrap the read in try/catch and return `null`.
- **Test guard's Bash arm ignores `ignoreGlobs`.** `rm node_modules/pkg/a.test.js` prompts. Over-asking only. Fix needs token-level path matching instead of `mentionsAny` on the segment text.
- **Wrapper flags and nested wrappers.** `yarn workspace app vitest …`, `pnpm -C dir exec …`, `npm --prefix x run …` resolve to the wrong tool word and over-ask.
- **Paths outside the project.** `relTo` yields `../…`, which still matches `**/*.ts`; the quality gate arms and the test guard asks for out-of-tree files. Fix: treat a `..` prefix as out of scope in both guards.

## Bootstrap and CI

- **`init` renders CI check steps and the allow list from the preset only.** A hand-written `custom` config needs its CI steps added by hand (this repo did). Fix: render from `harness.json` when it exists, or add a `sync-ci` subcommand.
- **Native Windows.** Checks run through `/bin/sh`; on Windows every check aborts and the quality gate blocks every edit. Documented as unsupported; use WSL. Fix: `process.platform === 'win32' ? process.env.ComSpec : '/bin/sh'` plus quoting rules.
- **Marketplace install path untested end to end.** The README's `claude plugin marketplace add <owner>/cc-harness` needs the repo pushed; verify the recorded source shape in `~/.claude/plugins/known_marketplaces.json` matches what `init` writes into `extraKnownMarketplaces` before tagging 0.1.0.
- **`deepMergeSettings` never removes entries.** A plugin upgrade that changes a harness-owned hook command would leave both entries. Needs an ownership marker before it matters.

## Eval suite

- **`smbclient -U me%pw` and bare `mysql -p` are not redacted.** Low frequency; add when seen.
- **The cwd substitution is boundary-anchored**, so `PATH=/cwd:/bin` forms keep the literal cwd (no username, since home directories are scrubbed separately).
- **Windows-style paths inside Bash commands are not scrubbed.** Transcripts here are macOS.
- **"Missing `file_path`" on an edit tool is unrepresentable as a vector** (`validateVector` requires a string); the guard's `!fp` branch is covered by unit tests only.
