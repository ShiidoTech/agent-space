# Changelog

## [Unreleased]


## [0.6.0] - 2026-08-08

First consolidated ShiidoTech fork release. This section is cumulative relative to the original upstream `0.5.0` baseline; the intermediate `0.5.2` / `0.5.3` package numbers used while developing the fork are folded into this release rather than treated as separate public releases.

### Fork identity and distribution
- Give the fork its own VS Code extension identity, `ShiidoTech.agent-space`, and point repository, homepage and issue metadata at `ShiidoTech/agent-space`.
- Migrate legacy `paql4711.agent-space` global storage on first launch when the new identity has no data yet, without overwriting or deleting existing state.
- Make VSIX the default independent distribution path and guard Marketplace publishing behind explicit ShiidoTech publisher/repository checks and an opt-in environment gate.
- Add release/distribution documentation explaining that GitHub merges do not update an already installed VSIX and documenting the fork release workflow.

### Project, Git and worktree model
- Add project-scoped `.agentspace/config.json` conventions for an explicit base branch, branch kinds, default branch kind and custom worktree location.
- Create feature branches/worktrees from the configured project base instead of whichever branch happens to be checked out in the main worktree.
- Reconcile persisted feature branch metadata with the symbolic branch actually checked out in its worktree, so external branch renames do not leave status, PR or deletion flows on a stale ref.
- Add fail-closed worktree deletion checks for paths outside the managed base, dirty worktrees and commits not merged into the configured base; force deletion remains an explicit human action.
- Make feature creation optionally start an agent instead of consuming tokens automatically, and keep opening an empty feature from implicitly launching a coding CLI.
- Build GitHub PR handoff from an explicit `baseBranch...feature.branch` compare URL and push the feature without rewriting `branch.<feature>.remote`, `branch.<feature>.merge` or the branch's existing upstream.

### Coding tools and persistent sessions
- Generalize coding-tool profiles with `env`, `family`, `sessionsDir`, `resumeCommand` and `enabled: false`, while keeping Claude, Codex, Copilot, OpenCode and Hermes as built-in presets.
- Remove the hard-coded `claude-perso` builtin in favor of declarative Claude-family profiles that keep their own executable, environment and session location.
- Preserve unresolved tool identity instead of silently substituting the built-in Claude executable.
- Capture the exact OpenCode session created for an agent, reserve session ids across concurrent captures, and resume the exact session when known (with `--continue` only as the directory-scoped fallback).
- Sync real Claude `ai-title` metadata, prefer explicit custom titles, use matching session-index metadata as a fallback, and support provider-backed names for Codex and OpenCode.
- Preserve user-owned agent names while still allowing names previously assigned by the syncer to follow provider title changes.
- Retry naming for still-unnamed agents during long-running sessions, include agents attached to the synthetic base feature, and accept Claude session paths expressed either as a profile root or directly as a `projects` directory.

### Agent state and operator UX
- Add provider-neutral derived attention states (`working`, `waiting_for_user`, `idle`, `failed`, `done`, `unknown`) in the sidebar and Home view without changing or persisting the existing lifecycle state.
- Derive Claude and Codex attention from structured provider events, use current tmux/pane evidence first, and fall back conservatively for stale, ambiguous or unsupported-provider evidence.
- Keep native terminal interaction as the source of truth: attention status is informational and does not inject prompts, route models, orchestrate agents or auto-complete work.
- Add **Agent Space: Doctor**, a read-only diagnostic report for Git, tmux, configured coding tools, session directories, projects, base branches and worktrees, with sensitive CLI/env values intentionally omitted.

### Documentation and positioning
- Reposition Agent Space as a VS Code-native local control plane for real coding CLIs, Git worktrees, native terminals and durable tmux sessions — a layer below agent/orchestrator intelligence rather than a competing orchestrator.
- Document project conventions versus user-local coding-tool configuration, session/attention evidence rules, independent distribution and safe release behavior.
- Add real product screenshots showing the multi-feature cockpit and native coding-tool terminal experience.


## [0.5.0] - 2026-03-12

### Other
- format code for release
- Harden tmux terminal session handling
- Simplify feature UX and add git status surfaces


## [0.4.0] - 2026-03-09

### Fixes
- satisfy biome quality gate

### Other
- Add main workspace and local review helpers
- Remove feature git view actions
- Track Agent Space UI isolation state


## [0.3.0] - 2026-03-07


## [0.2.1] - 2026-03-07

### Features
- isolate agent workspace window
- prompt for a default coding tool on startup

### Fixes
- restore workspace layout on agent space exit

### Other
- exclude workspace artifacts from VSIX
- Merge branch 'feat/git'
- Use native VS Code git view for feature diffs
- Merge branch 'feat/test-something'
- Harden agent startup and failure handling
- Ignore linked worktree directory
- Allow spaces in feature names
- Select default tool first for new agents
- Remove duplicate feature delete confirmation
- Fix sidebar agent context menu positioning
- Merge branch 'feat/tmux-management'
- Allow plain worktree terminals for services
- Refine feature home tmux session display
- Merge branch 'feat/tmux-management'
- Fix tmux session lifecycle management


## [0.2.0] - 2026-03-06

### Features
- fall back to available coding tools

### Fixes
- restart services from the feature worktree

### Other
- format codebase for biome
- prepare marketplace listing


## 0.1.0 - 2026-03-06

- Initial Marketplace release.
