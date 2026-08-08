# Agent Space roadmap

Agent Space is the local workspace and control layer for native coding agents: real CLIs, real terminals, real Git worktrees, persistent sessions and VS Code-native handoff.

The roadmap is a direction for contribution and review, not a release calendar. Issues may be reordered when user impact or implementation dependencies change.

## Now: make the product dependable

- Keep the native GitHub Pull Requests handoff safe and predictable — #28.
- Make runtime, Git and tmux prerequisites observable, especially across Linux, WSL and native Windows — #27.
- Clarify the public value proposition around multiple agents, cross-model review and provider choice — #34.
- Make Home, Project and Feature navigation coherent without duplicating dashboards — #35.

## Next: durable feature workspaces

- Bootstrap new worktrees with explicit, visible and retryable project setup commands.
- Reconcile worktrees, branches, persisted metadata and tmux sessions after restarts.
- Detect stale or orphaned state and offer conservative cleanup without deleting user work — #12.

## Then: provider-neutral multi-agent ergonomics

- Describe provider integration through explicit capabilities rather than family-specific branches.
- Let each project curate the agent IDs it exposes while preserving machine-local tool configuration.
- Document and test how new providers can be contributed without hiding their native CLI behavior — #24.

## Distribution

- Keep the fork's identity, licensing and upstream attribution clear.
- Publish to the VS Code Marketplace only when the publisher credentials, package and clean-install verification are available — #32/#33.

## Non-goals

Agent Space deliberately does not:

- provide its own language model or coding intelligence;
- inject hidden prompts or abstract away a native CLI;
- automatically select or route models;
- decompose coding tasks and orchestrate agents autonomously;
- replace Claude Code, Codex, OpenCode, Hermes or their native interfaces;
- hide branches, worktrees or Git operations behind a custom abstraction;
- merge pull requests automatically;
- promise that using several providers is cheaper than using one provider.

The product boundary is simple: Agent Space organizes the durable local environments in which developers use their coding agents, and keeps the handoff to native Git and VS Code explicit.
