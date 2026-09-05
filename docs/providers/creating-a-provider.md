# Creating a Provider

Agent Space providers are TypeScript adapters compiled into the extension. A
provider is added by a normal pull request; project configuration selects its
stable ID and never loads npm packages or extension code dynamically.

## Contract

Implement `CodingAgentProvider` from
`src/agents/providers/types.ts`. Declare every capability explicitly:

- `launch` is the minimum required capability.
- `resume` means the adapter can resume the same session, not merely start a
  new process.
- `sessionDiscovery` and `sessionNaming` require parser tests against real
  provider data.
- `attention.working`, `attention.waitingForUser`, `attention.idle`, and
  `attention.failed` may
  only be enabled when the provider exposes structured, reliable signals.

Expose session behavior through `sessionAdapter` rather than wiring a watcher
or parser in `extension.ts`. Its `readName()` method implements naming;
`scanSessions()` enumerates provider sessions. An optional
`discoverSessionCandidates(cwd, knownSessionIds)` may provide best-effort
candidates, but it is never ownership proof and must not reserve or assign a
session. An optional `correlateOwnedSession(cwd, knownSessionIds)` may return a
new session ID only when provider-specific data proves that this exact
Agent Space launch owns it. CWD, timing, ordering, uniqueness, and an internal
reservation do not satisfy that contract. If the provider cannot provide this
correlation, new sessions remain fail-closed until explicit user attachment.

The explicit recovery path is exposed as `Agent Space: Attach Provider Session`.
It lists only sessions in the selected agent's worktree that are not already
owned by another agent. The user must select the provider conversation; the
selection is revalidated before `sessionId` and `binding=bound` are persisted.
The runtime-only command is intentionally named
`Agent Space: Reconnect Existing Agent Runtime` and does not attach a provider
conversation.

Current provider identity findings:

- Claude remains preassigned: Agent Space creates the UUID and passes it to
  `--session-id`.
- Codex 0.151.0 exposes `thread/start` and `thread/resume` through its
  experimental JSON-RPC app-server protocol, but `thread/start` alone is not
  a resumable identity: verified against a real app-server process, its
  rollout file does not exist on disk until a turn actually runs, and
  `codex resume <id>` against that id fails with "No saved session found"
  (see `docs/providers/codex-app-server.md`, corrected after the #125
  regression). Agent Space does not acquire a pre-launch identity for Codex;
  a fresh agent launches plain `codex` and its rollout is discovered through
  the same file-backed scan the Claude family uses, but Codex has no
  `correlateOwnedSession` proof, so `SessionBinder` leaves even a single
  freshly-appeared rollout `ambiguous` — like OpenCode, it stays fail-closed
  until explicit `Attach Provider Session`, not auto-bound like Claude. A
  previously bound resume stays strict: `resumeConversation`
  checks the rollout exists on disk before confirming it with
  `thread/resume`. `turn/started`, `turn/completed`, approval requests, and
  `item/tool/requestUserInput` are consumed only when they carry an exact
  thread id, but only fire for threads the app-server itself drives, not the
  native TUI Agent Space spawns. Existing agents without a verifiable id
  remain unresolved and are never adopted from a recent rollout.
- OpenCode 1.18.17 exposes `--session` for resume and a session database, but
  no launch option or provider-native ownership receipt was found in the CLI
  contract. Directory and creation time remain insufficient, so OpenCode also
  remains fail-closed until explicit attachment.
- Copilot CLI exposes `--resume <sessionId>` for resume. Its store is
  `~/.copilot/session-state/<sessionId>/` with `events.jsonl`
  (`{id, parentId, timestamp, type, data}`; `session.start` carries
  `data.sessionId`/`data.startTime`, `user.message` carries `content`) and a
  flat `workspace.yaml` (`{id, cwd, summary, created_at, updated_at}`) that
  provides both the session cwd and its display title. Resume, discovery and
  naming read this durable on-disk state. Attention stays unsupported:
  `assistant.turn_start/turn_end` and `tool.execution_*` events exist on disk,
  but deriving a live phase from the last event would be recency inference.

Session naming exposes a provider session title separately from the stable Agent
Space agent name; it is not a rename of the native terminal prompt. Working means
the provider proves that it is processing. Waiting means the provider proves
that it has completed its turn and needs user input. Neither state may be
inferred from the absence of terminal output.

Launch and resume arguments belong to the adapter. Do not add provider family
branches to `CodingToolRegistry` or scrape terminal output to infer state.

## Degradation Rules

Missing capabilities are visible as `unsupported`, not `unknown`. `unknown` is
reserved for a supported capability whose current observation cannot be read.
In particular, absence of a structured attention signal must never be rendered
as `Idle`.
Unknown project IDs are reported diagnostically and never replaced with a
different executable. An unavailable configured default does not trigger a
silent fallback.

## Tests

Add unit tests for:

1. capability declarations and launch/resume commands;
2. session parsing using realistic files or CLI output;
3. malformed and incomplete data;
4. the unsupported-capability path returning `unsupported`.

Document any provider behavior that was observed but not implemented. Hermes
session binding and resume use its terminal breadcrumbs; attention remains
unsupported. Codex's app-server event shapes are parsed, but Codex attention
must remain unsupported until a real cross-process TUI event path is proven or
Agent Space directly controls turns through app-server.

## Project Curation

Projects may commit this policy in `.agentspace/config.json`:

```json
{
  "agents": {
    "enabled": ["codex", "opencode"],
    "default": "opencode"
  }
}
```

The allowlist contains provider IDs only. Machine-local command overrides,
profiles, environment variables, and session directories remain in
`agentSpace.codingTools` user/workspace settings.

For a second Claude profile on the same machine, keep the project ID stable and
declare the local launcher privately:

```json
{
  "agentSpace.codingTools": [
    {
      "id": "claude-perso",
      "name": "Claude perso",
      "command": "claude-perso",
      "family": "claude",
      "sessionsDir": "~/.claude-perso"
    }
  ]
}
```

The built-in Claude adapter is reused with that separate `sessionsDir`; the
project config does not contain the wrapper command or personal paths.
`sessionsDir` accepts either the profile root (`~/.claude-perso`) or the
transcripts directory itself (`~/.claude-perso/projects`) — both resolve to the
same store.

Enabling that private launcher on a curated project is what
`.agentspace/config.local.json` is for. Add `.agentspace/config.local.json` to
that repository's `.gitignore`; Agent Space does not modify repository ignore
rules. The file is intended to remain untracked, has the same shape as
`config.json`, and unions into `agents.enabled` rather than replacing it:

```json
{
  "agents": {
    "enabled": ["claude-perso"],
    "default": "claude-perso"
  }
}
```

With the committed config above, this machine offers `codex`, `opencode` and
`claude-perso`, and defaults to `claude-perso`; every other checkout is
unaffected. Agent Space only reads this file — `saveProjectConfig` writes to
`config.json` alone, so a base branch changed from the UI never bakes a personal
profile into the committed file.
