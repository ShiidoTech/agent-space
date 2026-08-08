# Changelog

## [Unreleased]

### Fixes
- Retry provider-backed names for still-unnamed agents during long-running sessions instead of requiring a terminal focus change.
- Include agents attached to the repository base feature in session-name synchronization.
- Accept Claude-family session configuration that points either to a profile root or directly to its `projects` directory.


## [0.5.3] - 2026-08-08

### Features
- Add provider-neutral agent attention states (`working`, `waiting_for_user`, `idle`, `failed`, `done`, `unknown`) to the sidebar and Home view, while keeping persisted lifecycle state separate.
- Add **Agent Space: Doctor** for read-only diagnostics of Git, tmux, coding tools, session directories, project configuration, base branches and worktrees.
- Add generic coding-tool profiles with `env`, `family`, `sessionsDir`, `resumeCommand`, and `enabled: false`, while keeping Claude, Codex, Copilot, OpenCode and Hermes as built-in presets.
- Add project-scoped `.agentspace/config.json` conventions for non-standard base branches, branch kinds and worktree locations.
- Add VSIX-first independent distribution under the `ShiidoTech.agent-space` extension identity, including migration from legacy `paql4711.agent-space` global storage.

### Fixes
- Sync real Claude `ai-title` metadata, with session-index fallbacks, and synchronize supported Codex/OpenCode session names while preserving user-owned names.
- Use the project-configured GitHub compare base explicitly when handing a feature to the GitHub Pull Requests flow.
- Push feature branches for PR creation without mutating `branch.<feature>.remote` / `branch.<feature>.merge` or changing the branch's existing upstream.
- Keep stale tmux/session evidence from producing affirmative agent attention states; ambiguous evidence falls back conservatively.

### Documentation
- Reposition the ShiidoTech fork as a VS Code-native local control plane for real coding CLIs, Git worktrees, native terminals and durable tmux sessions.
- Add distribution/release documentation, attention-status evidence rules, screenshots and fork-specific onboarding.


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
