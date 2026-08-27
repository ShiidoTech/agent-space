---
name: agent-space-local-delivery
description: "Deploy the agent-space extension to WSL Insiders: typecheck/test/compile/biome/package/install + verify."
version: 1.0.0
author: ShiidoTech
metadata:
  hermes:
    tags: [agent-space, vscode, wsl, insiders, vsix, delivery]
    related_skills: [vscode-extension-local-delivery]
---

# Agent Space — Local Delivery

Build and locally install a validated Agent Space VSIX into **VS Code Insiders**
(WSL remote host). Use this before handing back any extension change.

Canonical source of truth: `.agentspace/runbooks/local-extension-test.md` in this
worktree. If the two ever disagree, the runbook wins — this skill is a fast
entry point, not a second spec. For WSL-remote install nuances, see the general
`vscode-extension-local-delivery` skill.

## Sequence

1. Inspect state: `git status --short`, `git log --oneline -5`,
   `gh pr view <N> --repo ShiidoTech/agent-space` (if a PR is the source).
2. Install locked deps (frozen, deterministic — drift fails loudly):
   `bun install --frozen-lockfile`.
3. Validate the extension:
   `npm run typecheck`, `npm test -- --run`, `npm run compile`,
   `npm run biome`, `npm run package`.
4. `npm run package` is self-verifying: it compiles, packages with the
   repo-pinned local `@vscode/vsce`, then runs `scripts/verify-package.mjs`
   (fails on missing/stale VSIX, development data leaking into the archive, or a
   packaged `dist/extension.js` hash mismatch with the local build).
5. Install in Insiders:
   `code-insiders --install-extension <worktree>/agent-space-<version>.vsix --force`.
6. Verify the installed identity, never the exit code:
   `code-insiders --list-extensions --show-versions` must contain
   `shiidotech.agent-space@<version>`.
7. Reload the Insiders window (`Developer: Reload Window`) and confirm
   activation (`Agent Space` activity-bar icon, or `Agent Space: Doctor`).

Record branch, commit SHA, extension version, VSIX path and VSIX SHA-256 in the
handoff. For a release candidate, compare the packaged and installed
`extension/dist/extension.js` hashes (`unzip -Z1 <vsix>`).

## Pitfalls

- WSL-remote: pass the **WSL-native** path to `--install-extension`; a Windows
  (`C:\...`) or UNC path fails with `code: 'Extract'`.
- Do not unzip into `~/.vscode-server-insiders/extensions/` — a stale
  `.obsolete` entry makes the host ignore/purge it. Verify via
  `code-insiders --list-extensions --remote wsl+Ubuntu` and `.obsolete`.
- Building from local `main` when the requested work is based on a newer PR.
- Packaging without checking `.vscodeignore`: worktrees (`.claude/**`,
  `.worktrees/**`) inflate the archive and can smuggle a second
  `dist/extension.js` that breaks activation. Probe:
  `unzip -l <vsix> | grep -c 'dist/extension.js'` must be exactly 1.
- Fallbacks (VSCODE_IPC_HOOK_CLI, `npx --yes @vscode/vsce@3.9.2`) are emergency
  only and are documented in the runbook; record the failure and the fallback,
  never present a fallback as canonical success.