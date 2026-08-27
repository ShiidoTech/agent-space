# Hermes global setup for Agent Space

How to configure **Hermes** so it behaves correctly in every project Agent Space
manages. The key idea: **Agent Space, not Hermes, decides which directory an
agent runs in and which profile it uses.** Hermes must stay path-agnostic and
let Agent Space drive the runtime.

## The one rule that matters: `terminal.cwd`

Set, in the Hermes profile that Agent Space targets:

```yaml
terminal:
  backend: local
  cwd: "."
```

`cwd: "."` is relative to the directory Hermes is launched from — and Agent
Space launches Hermes from the **feature worktree**. Consequences:

- The same profile works for every feature: feature A → worktree A, feature B →
  worktree B, no reconfiguration.
- **Never** put an absolute repository or worktree path in a profile. A
  hardcoded `cwd` sends Hermes back to the main checkout (or any other fixed
  path) regardless of the feature, breaking per-feature isolation.
- `HERMES_HOME`, the profile home, and the repository path must stay distinct.
  The current working directory of a Hermes session is the worktree; the profile
  home only stores profile-local state.

## Which profile is used (and who decides)

Agent Space resolves the Hermes profile once, at **agent creation**, and freezes
it on the agent record. Resolution priority:

1. project declaration: `providers.hermes.profile` in `.agentspace/config.json`
   (or `.agentspace/config.local.json`);
2. an implicit profile carried by `HERMES_HOME`;
3. Hermes' active profile (`hermes profile use`);
4. `default`.

Because the profile is frozen at creation, a later config change never silently
moves an existing session.

**Deterministic naming rule:** a repository `foo-bar` maps to a Hermes profile
named `foo-bar`. Declare that mapping so every checkout resolves the same
profile:

```json
{
  "providers": {
    "hermes": {
      "profile": "agent-space"
    }
  }
}
```

Commit the mapping in the shared `.agentspace/config.json` when it is a team
convention (deterministic name, expected everywhere). Put machine-only choices
in `.agentspace/config.local.json` (same shape, always gitignored) — e.g. a
personal `agents.default` preference.

## What belongs where

Keep the three responsibilities separate:

| Layer | Owns |
|---|---|
| Agent Space | the Hermes profile, the worktree/cwd, the runtime session identity |
| Hermes profile (machine-local, `~/.hermes/profiles/<name>/`) | model, toolsets, MCP, SOUL, memory, sessions |
| Repository | architecture, conventions, commands, runbooks, project skills |

- Repository instructions go in `AGENTS.md`; procedures in
  `.agentspace/runbooks/*.md`; reusable project skills in `.agents/skills/`.
- Do not copy repository conventions into a profile's `SOUL.md`, and do not
  store machine/personal configuration in the repository.

## Secrets

Keep API keys and credentials in the profile's `.env` / `auth.json` (many
setups symlink these to the shared `~/.hermes` home). Never commit them; a
project's `.gitignore` must exclude `.env` and `.agentspace/config.local.json`.

## Sessions and store

Each profile has its own session store under its profile home
(`~/.hermes/profiles/<name>/`), so sessions never mix between projects or with
`default`. Agent Space reads an agent's sessions from the store of the frozen
profile only. New session, discovery and resume go through `-p <profile>` —
there is no mixing with `default` or another project's profile.

## Validation

After configuring, launch Hermes from a feature worktree and confirm:
`pwd` equals the worktree, the active profile is the expected one, and the
created session lives in that profile's store (isolated from `default`).