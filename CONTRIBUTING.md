# Contributing

Changes to `app-remote-terminal` should preserve the Agent, Relay and APP role
boundaries and keep credentials outside the repository.

## Incremental change policy

- Work on one logical objective at a time. Keep each patch and commit small enough to review in one sitting; do not generate a large batch of source files, UI content or documentation in one step.
- Inspect the target files and `git status` before editing. After editing, run `git diff --check` and review the complete staged diff before committing.
- Keep protocol changes, client changes, deployment changes and documentation in separate commits. Never add unrelated or merely present untracked files to a task commit.
- Run the narrowest relevant test after each change, then expand validation only when the accumulated change requires it.
- Before publishing, scan tracked files and the full Git history for Agent/browser tokens, private keys, passwords, pairing exports, logs and private server paths.
- Keep `config.json`, `.env`, `pairing/`, backups, logs, certificates, private keys and generated build output out of Git. Examples must use obvious placeholders and must never be accepted as runtime credentials.
- Prefer a follow-up commit for the next logical change. Do not replace a reviewable incremental patch with a one-shot generated rewrite.

## Validation

```bash
npm test
npm run test:security
```

When a change affects a native client, Relay protocol or deployment unit, run the
corresponding focused test and document the command in the change description.
