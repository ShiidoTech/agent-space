---
title: Local extension test
canonical: true
commands:
  - npm run typecheck
  - npm test -- --run
  - npm run compile
  - npm run package
---

# Local extension test

Deterministic, known-good procedure for preparing the current branch as a
locally installable extension in **VS Code Insiders**. Use this canonical path
before experimenting with any alternative launch or install route.

## Canonical steps

1. Inspect the current state and PR:
   `git status --short`, `git log --oneline -5`,
   `gh pr view <N> --repo ShiidoTech/agent-space`.
2. Validate the extension:
   `npm run typecheck`, `npm test -- --run`, `npm run compile`,
   `npm run package`.
3. Install the generated VSIX in VS Code Insiders:
   `code-insiders --install-extension <worktree>/agent-space-<version>.vsix --force`
4. Reload the Insiders window (`Developer: Reload Window`) and verify the
   extension activates (`Agent Space` activity-bar icon, or
   `Agent Space: Doctor`).

## Diagnostic notes — not canonical

Troubleshooting hypotheses only. They must be re-validated before being promoted
to a canonical step.

- `Unable to connect to VS Code server: Error in request` /
  `connect ECONNREFUSED /run/user/.../vscode-ipc-....sock`: an intermediate
  theory was that a stale `VSCODE_IPC_HOOK_CLI` needed to be unset. The
  validated canonical sequence above does **not** include it. Only try this if
  the canonical path fails, and record whether it independently validates.
- A packaging attempt that hits read-only pnpm/Bun caches once fell back to
  `npx @vscode/vsce package`. Prefer `npm run package`; this workaround is not
  part of the default agent path.
