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
`scanSessions()` and `discoverSessionId(cwd, knownSessionIds)` implement
provider-owned discovery. `discoverSessionId()` must not return a session from
`knownSessionIds`, and must reserve a returned ID so two agents sharing a cwd
cannot claim the same session.

Session naming is the provider session title used by Agent Space for the agent
display name; it is not a rename of the native terminal prompt. Working means
the provider proves that it is processing. Waiting means the provider proves
that it has completed its turn and needs user input. Neither state may be
inferred from the absence of terminal output.

Launch and resume arguments belong to the adapter. Do not add provider family
branches to `CodingToolRegistry` or scrape terminal output to infer state.

## Degradation Rules

Missing capabilities are visible as unsupported/unknown. In particular,
absence of a structured attention signal must never be rendered as `Idle`.
Unknown project IDs are reported diagnostically and never replaced with a
different executable. An unavailable configured default does not trigger a
silent fallback.

## Tests

Add unit tests for:

1. capability declarations and launch/resume commands;
2. session parsing using realistic files or CLI output;
3. malformed and incomplete data;
4. the unsupported-capability path returning `unknown`.

Document any provider behavior that was observed but not implemented. Hermes,
for example, currently has launch-only support until its session protocol is
backed by evidence. Claude and Codex currently provide structured turn
boundaries for working/waiting/failed attention states.

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
