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
| `waiting_for_user` | Structured provider evidence says the current turn completed or explicitly requested user input/approval. |
| `idle` | The tmux session is alive, but Agent Space has no strong evidence that a turn is currently running or needs attention. |
| `failed` | The persisted lifecycle recorded a failure, the pane exited non-zero, or the provider emitted a terminal error event. |
| `done` | The human explicitly marked the agent done. |
| `unknown` | There is insufficient current evidence, for example the agent never started or its previously-running tmux session disappeared. |

## Evidence precedence

The resolver uses the strongest facts first:

1. Explicit lifecycle `done` / recorded failure.
2. Whether the agent has ever started.
3. Current tmux session and pane state.
4. Structured provider events for the exact session.
5. Conservative `idle` fallback for a live unsupported/ambiguous CLI.

A persisted `running` value by itself is **not** evidence that an agent is still working.

## Provider evidence

### Claude-family tools

Agent Space reads only the tail of the session JSONL and, where an event carries a session id, ignores rows for another session.

Strong signals:

- assistant `stop_reason: end_turn` → `waiting_for_user`;
- `AskUserQuestion` tool call → `waiting_for_user`;
- assistant `stop_reason: tool_use` → `working`;
- new user/tool-result input or assistant activity before completion → `working`.

A generic permission prompt is not guessed from terminal text. If Claude does not expose enough structured evidence, Agent Space falls back conservatively.

### Codex

Agent Space reads the rollout JSONL for the known session id.

Strong signals include:

- `task_started` / `turn_started` → `working`;
- `request_user_input` or an `*_approval_request` event → `waiting_for_user`;
- `task_complete` / `turn_complete` → `waiting_for_user`;
- terminal error event → `failed`.

### Other tools

For OpenCode, Hermes, Copilot, and generic/custom tools, Agent Space does not invent a provider-specific parser unless a stable structured signal is available. A live tmux session therefore reports `idle` rather than a false `working` or `waiting_for_user` state.

## Non-goals

Attention status does not:

- parse prompts to control an agent;
- inject prompts or acknowledgements;
- route tasks between tools/models;
- decide that a quiet terminal means the user is needed;
- automatically mark work complete;
- replace the native CLI terminal.
