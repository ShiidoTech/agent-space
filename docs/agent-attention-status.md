# Agent attention status

Agent Space exposes a provider-neutral **attention status** alongside the persisted agent lifecycle state.

The two concepts are intentionally separate:

- lifecycle state (`running`, `stopped`, `done`, `errored`) is persisted and drives actions such as close/reopen;
- attention state (`working`, `waiting_for_user`, `idle`, `failed`, `done`, `unknown`) is derived from current evidence and is never persisted.

This separation prevents a VS Code restart, a stale tmux session, or a provider-log parser from corrupting the agent lifecycle.

## Status semantics

| Status | Meaning |
|---|---|
| `working` | Structured provider evidence says the current turn is in progress. |
| `waiting_for_user` | Structured provider evidence says the agent has an explicit open request for human input or approval. |
| `idle` | The current turn is complete, or the tmux session is alive without evidence of active work or an open human-attention request. |
| `failed` | The persisted lifecycle recorded a failure, the pane exited non-zero, or the provider emitted a terminal error event. |
| `done` | The human explicitly marked the agent done. |
| `unknown` | There is insufficient current evidence, for example the agent never started or its previously-running tmux session disappeared. |

A completed model turn is **not** the same thing as needing the user. `waiting_for_user` is reserved for explicit questions, approvals, permissions, or equivalent provider-native gates.

## Evidence precedence

The resolver uses the strongest facts first:

1. Explicit lifecycle `done` / recorded failure.
2. Whether the agent has ever started.
3. Current tmux session and pane state.
4. Structured provider evidence for the exact session.
5. Conservative `idle` fallback for a live unsupported/ambiguous CLI.

A persisted `running` value by itself is **not** evidence that an agent is still working.

## Provider evidence

### Claude-family tools

Agent Space reads only the tail of the session JSONL and, where an event carries a session id, ignores rows for another session.

Strong signals:

- assistant `stop_reason: end_turn` → `idle`;
- `AskUserQuestion` tool call → `waiting_for_user`;
- assistant `stop_reason: tool_use` → `working`;
- new user/tool-result input or assistant activity before completion → `working`.

A generic permission prompt is not guessed from terminal text. If Claude does not expose enough structured evidence, Agent Space falls back conservatively.

### Codex

The primary source is the controlled `codex app-server --stdio` connection,
keyed by thread id, but it only observes threads the app-server itself
drives. The interactive agent Agent Space launches is a separate native TUI
process spawned in tmux, not driven through this connection, so it produces
none of these events. Codex attention is therefore advertised as
`unsupported` for now. Rollout JSONL remains a diagnostic fallback and never
establishes ownership. (See `docs/providers/codex-app-server.md` for why
Agent Space no longer acquires a pre-launch thread id for Codex either —
`thread/start` returns an id before its rollout exists, and #125 treated that
as a false ownership guarantee.)

Strong signals include:

- `turn/started` → `working`;
- thread-scoped `item/*/requestApproval` or
  `item/tool/requestUserInput` → `waiting_for_user`;
- thread-scoped `turn/completed` with a non-error status → `idle`;
- thread-scoped `turn/completed` with failed status or `error` → `failed`.

When the app-server process or connection is lost, the live signal is cleared
to fail closed. Agent Space does not infer a completion from a closed terminal,
exit code, silence, cwd, or a recent rollout.

### OpenCode

Agent Space reads the OpenCode SQLite store through `opencode db`; it does not scrape the TUI text.

The latest persisted message provides the turn boundary:

- latest assistant message without `time.completed` → `working`;
- latest assistant message with `time.completed` → `idle`;
- latest user message before an assistant response settles → `working`;
- assistant message with an error → `failed`.

A live `question` or `plan_exit` tool in `pending`/`running` state is treated as an explicit human-attention gate and therefore maps to `waiting_for_user`.

### Other tools

Hermes, Copilot, and generic/custom tools remain conservative unless a stable structured signal is available. A live tmux session therefore reports `idle` rather than a false `working` or `waiting_for_user` state.

New provider adapters can be added without changing the provider-neutral UI contract.

## UI refresh

Portfolio, Project, Feature and Sidebar consume the same Fleet rollup. Its order is `Needs you`, failed/runtime-lost/binding-degraded, `Ready for review`, `Working`, then unknown/unsupported. Ordinary runtime, rename and acknowledgement changes are DOM patches; document replacement is reserved for initial mount or structural changes. Clicking an item still opens/focuses the native terminal where the actual interaction happens.

## Non-goals

Attention status does not:

- parse prompts to control an agent;
- inject prompts or acknowledgements;
- route tasks between tools/models;
- decide that a quiet terminal means the user is needed;
- automatically mark work complete;
- replace the native CLI terminal.
