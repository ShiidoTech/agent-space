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
4. Verify the installed identity instead of relying on the installer exit code:
   `code-insiders --list-extensions --show-versions` must contain
   `shiidotech.agent-space@<version>`.
5. Reload the Insiders window (`Developer: Reload Window`) and verify the
   extension activates (`Agent Space` activity-bar icon, or
   `Agent Space: Doctor`).

Record the branch, commit SHA, extension version, VSIX path and VSIX SHA-256 in
the handoff. For a release candidate, also inspect `unzip -Z1 <vsix>` and
compare the packaged `extension/dist/extension.js` hash with the installed
extension's `dist/extension.js`. This proves which build was installed; an exit
code or a matching semantic version alone does not.

## Fallbacks and diagnostic notes — not canonical

Use these only when the canonical path fails. Record the original failure, the
fallback used and its independent verification; a successful fallback does not
turn the failed canonical check green.

- `Unable to connect to VS Code server: Error in request` /
  `connect ECONNREFUSED /run/user/.../vscode-ipc-....sock`: an intermediate
  theory was that a stale `VSCODE_IPC_HOOK_CLI` needed to be unset. Unsetting it
  has also produced a misleading exit code `0` while printing that the command
  was unavailable, so do not treat that workaround or its exit code as proof.
  The validated fallback on 2026-08-12 was to resolve the active remote CLI
  with `readlink -f "$(command -v code-insiders)"`, use the sibling
  `../code-server-insiders` binary to install and list the extension, then
  verify the installed bundle hash. This path is installation-specific: never
  hard-code the Insiders commit directory.
- If `npm run package` fails because Bun cannot create its temporary/cache
  directory on a read-only filesystem, first record the failure. The validated
  fallback on 2026-08-12 was
  `npx --yes @vscode/vsce@3.9.2 package --no-dependencies`. Prefer the canonical
  package script whenever the environment permits it, and report the fallback
  explicitly rather than presenting it as canonical success.
- Some server CLI invocations can print an `EROFS` log-directory warning and
  still return the requested extension path or list. Validate the requested
  output and the installed bundle hash; neither the warning nor the exit code
  alone establishes success or failure.
