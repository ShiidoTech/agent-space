# Agent Space — project instructions for coding agents

Agent Space is a VS Code extension that manages per-feature git worktrees,
persistent tmux sessions and native coding CLI sessions. Before working in this
repository, read the operational knowledge below: it is canonical for this
project.

## Project invariants

- **Keep `AGENTS.md` concise.** Only permanent invariants belong here. Recurring
  procedures live in `.agentspace/runbooks/*.md` and are discoverable by every
  agent.
- **The test target is VS Code Insiders**, not stable VS Code. Use
  `code-insiders` for local installs.
- **The expected deliverable for local testing is an installable VSIX.**
- **Canonical base branch is `main`** for the ShiidoTech fork. Feature branches
  are created from it.
- **Package manager:** `bun` for the lockfile, `npm` scripts from `package.json`
  for the workflow. Do not introduce a competing lockfile.
- **Mandatory checks before opening a PR:** `npm run typecheck`,
  `npm test -- --run`, `npm run compile`.
- **Canonical packaging command is `npm run package`** (wraps `vsce package`).
  Do not invoke `vsce` directly in the default path.
- **Commit on a feature branch after the mandatory checks pass; never push directly to `main` or
  `develop`. Submit a pull request to `ShiidoTech/agent-space`.

## Operational knowledge

- Local install/verify workflow: `.agentspace/runbooks/local-extension-test.md`.
- Prefer the repository's runbooks over reconstructing shell commands from
  memory; a workflow already exercised by the project is not something a fresh
  agent should rediscover.
