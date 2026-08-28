# Codex app-server integration

PR4 uses the experimental JSON-RPC protocol exposed by the locally installed
Codex CLI. Agent Space owns one long-lived `codex app-server --stdio`
connection per Codex session adapter. The built-in adapter is shared by all
Codex agents, so the server multiplexes threads; the persisted Codex thread id
is the only routing key. A custom Codex profile gets its own adapter and
connection.

## Identity lifecycle

For a new Codex agent, Agent Space sends `initialize`, then
`thread/start {"cwd": "...", "ephemeral": false}`. It accepts an identity
only from the response's `result.thread.id`, persists it immediately in the
existing `Agent Space agentId -> sessionId` binding, and starts the native UI
with `codex resume <thread.id>`. No scan, cwd match, timestamp, prompt order,
or terminal text participates in ownership.

For an existing agent, `thread/resume {"threadId": "<persisted id>"}` must return
the same id. Reload and runtime restoration use that exact request. If it fails,
the agent remains unresolved/blocked; a recent thread is never adopted.

## Events and process failure

The adapter consumes only thread-scoped structured messages:

- `turn/started` → provider `working`;
- `item/*/requestApproval` and `item/tool/requestUserInput` → provider
  `waiting_for_user`;
- `turn/completed` → provider `idle`, or `failed` when its turn status is an
  error;
- `error` → provider `failed`.

These observations enter the existing provider-neutral resolver and PR2
transition detector. The provider does not maintain a second state machine or
persist `finished`; PR2 owns `turn_completed` and the review receipt.

If the app-server exits, pending requests fail and live app-server observations
are cleared. The next exact `thread/resume` lazily starts a fresh connection.
No terminal close, exit code, silence, or JSONL recency creates a completion.
Rollout JSONL remains a same-thread diagnostic fallback, never an ownership
source.

## Capability smoke

On 2026-08-28, local `codex-cli 0.150.1` was queried with a real stdio
connection. `initialize` returned successfully, `thread/start` returned a
UUIDv7 `thread.id`, and `thread/started` carried the same id. No model turn was
started, so working/approval/completion/failure were validated with the fake
transport contract tests rather than claimed as a live model smoke.
