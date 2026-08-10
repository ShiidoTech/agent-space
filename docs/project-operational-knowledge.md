# Project operational knowledge

Agent Space gives every newly launched agent the same, explicit view of how the
project is built, tested, packaged, previewed and operated — without depending
on the previous agent's conversation history.

The source of truth lives **in the repository**, not in a provider's private
memory. Whatever coding CLI runs inside a worktree can read the same files a
human or agent can. The extension only discovers, validates and surfaces them.

## Where project knowledge lives

Two kinds of files, both git-tracked so every worktree and every teammate sees
them:

- **Canonical agent instructions** — conventionally `AGENTS.md` at the repo
  root. Keep it concise: project invariants that are true for every agent
  (WSL, canonical base branch, package manager, mandatory checks, no-push
  rules). Recurring procedures do **not** belong here — they belong in runbooks.
- **Runbooks** — `.agentspace/runbooks/*.md`. One file per recurring workflow
  (validate, package, install, preview…). Each runbook is a deterministic
  procedure with canonical commands first, troubleshooting notes clearly
  separated.

A project can declare them explicitly in `.agentspace/config.json`:

```json
{
  "knowledge": {
    "instructions": ["AGENTS.md", "docs/CONTRIBUTING.md"],
    "runbooks": {
      "local-extension-test": ".agentspace/runbooks/local-extension-test.md"
    }
  }
}
```

Declaring a reference is a contract: a declared path that is missing or invalid
**fails visibly** (Doctor error + a line in the agent's launch context) instead
of being silently ignored. Runbooks that are simply dropped under
`.agentspace/runbooks/` are discovered even without a declaration — the
declaration only adds validation and an explicit id.

## How the launch context works

When a new agent starts, Agent Space prints a short note as the first lines of
the agent's terminal before the coding CLI begins:

```text
Agent Space — project operational knowledge for this session:
  instructions: AGENTS.md
  runbooks: .agentspace/runbooks/local-extension-test.md (Local extension test)
Prefer these canonical project procedures over reconstructed commands.
```

- The note lists exactly which instructions/runbooks were made available.
- It points at files the agent can open and read; it never injects
  provider-specific context, so it works identically for Claude, Codex,
  OpenCode, Copilot, Hermes and custom CLIs.
- Problems surface inline, e.g.
  `PROBLEM .agentspace/runbooks/gone.md: declared runbook ... is missing`.
- Resume/attach launches stay quiet: the note appears only on fresh launches.

Because the files are committed, a brand-new agent in a fresh worktree discovers
them by simply reading the repository, with no previous session history.

## Canonical procedures vs troubleshooting

The product principle is: *if the same operational mistake has to be corrected
twice, the third occurrence is a project knowledge/capitalization bug.*

Runbooks therefore separate **proven, canonical steps** from **diagnostic
hypotheses**. A runbook can declare its status in its front matter:

```markdown
---
title: Local extension test
canonical: true
commands:
  - npm run typecheck
  - npm test -- --run
  - npm run compile
  - npm run package
---
```

- `commands` are deterministic repository commands the workflow can point to.
- `canonical: true` means this is the known-good, validated path. A fresh agent
  uses it before experimenting with alternatives.
- `canonical: false` marks troubleshooting-only material — an unverified
  workaround that must be re-validated before it can be promoted to the
  canonical procedure. A runbook with no `canonical` key is treated as
  unverified.

## Deterministic commands and scripts

Recurring workflows should point to repository commands/scripts instead of
asking agents to reconstruct shell commands. Prefer `npm run <script>` /
`scripts/*.sh` abstractions in the canonical steps; keep direct low-level
invocations in troubleshooting notes.

## Discoverability surfaces

- **Launch context** — every fresh agent's terminal lists the available
  instructions and runbooks (see above).
- **Doctor** — `Agent Space: Doctor` reports, per project, the instruction and
  runbook counts and flags every invalid or missing declared reference as an
  error.
- **Command palette** — `Agent Space: Open Project Runbook` lists the project's
  runbooks and opens the selected one.

## What belongs where

| Concern | Where |
|---|---|
| Permanent project invariants | `AGENTS.md` |
| Recurring deterministic procedures | `.agentspace/runbooks/*.md` |
| Environment-specific failure modes | runbook body, `canonical: false` |
| Machine-local personal config | `.agentspace/config.local.json` (never committed) |
| User-global/provider memory | never — stays out of the repository |
