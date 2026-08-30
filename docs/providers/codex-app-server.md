# Codex app-server integration

Agent Space owns one long-lived `codex app-server --stdio` connection per
Codex session adapter, used for structured events and for validating a
resume. The built-in adapter is shared by all Codex agents, so the server
multiplexes threads; the persisted Codex thread id is the routing key. A
custom Codex profile gets its own adapter and connection.

## Identity lifecycle (corrected after #125)

PR4/#125 originally sent `thread/start {"cwd": "...", "ephemeral": false}`
before every fresh launch and treated the response's `result.thread.id` as an
exact, immediately resumable identity, then started the native UI with
`codex resume <thread.id>`. That is not the real contract: verified against a
real `codex app-server --stdio` process on Codex CLI 0.151.0, `thread/start`
returns a thread id and a `path` for its rollout file *before that file exists
on disk*. The rollout is only written once a turn actually runs (confirmed by
sending a real `turn/start` over the same connection and observing the file
appear only after the turn completed). `codex resume <that-id>` run as a
separate process — which is what actually happens, since the native TUI is
spawned as its own CLI process, not driven through this RPC connection —
fails with `No saved session found with ID <id>` for a thread that was merely
started.

Agent Space therefore does **not** call `thread/start` before a fresh launch
and does **not** acquire a pre-launch identity for Codex at all
(`CodexSessionProvider` has no `acquireConversation`). A fresh Codex agent
launches plain (`codex`, no args). Its session is discovered the same way the
Claude family's file-backed discovery scans (`scanSessions`/
`discoverSessionCandidates`), gated by the pre-launch baseline and worktree so
no agent can adopt another's session — but Codex's `conversationIdentity.
ownership` is `provider_assigned`, not `preassigned`, and `CodexSessionProvider`
implements no `correlateOwnedSession`. `SessionBinder.resolveClaim` never binds
a discovered candidate without provider-specific ownership proof, so a single
freshly-appeared rollout is left `ambiguous`, exactly like two or more
candidates — it is **not** auto-bound the way a Claude session is. This
matches OpenCode's existing fail-closed posture: the agent needs the explicit
`Agent Space: Attach Provider Session` action once its rollout exists. A
genuine Codex `correlateOwnedSession` would need provider-native proof (e.g.
app-server driving the turn itself); CWD/timing/uniqueness never qualify, so
none is implemented here.

For an existing agent, resume stays strict and exact: `resumeConversation`
first checks that a rollout file for the id actually exists on disk
(`hasSession`/`findSessionFile` — the same store the native TUI reads), and
only then confirms it with `thread/resume {"threadId": "<persisted id>"}`. If
either check fails, the agent remains unresolved/blocked; a recent or
in-memory-only thread is never adopted, and `codex resume` without an id (or
"most recent session") is never used as a fallback.

## Events and process failure

The adapter consumes only thread-scoped structured messages:

- `turn/started` → provider `working`;
- `item/*/requestApproval` and `item/tool/requestUserInput` → provider
  `waiting_for_user`;
- `turn/completed` → provider `idle`, or `failed` when its turn status is an
  error;
- `error` → provider `failed`.

These events are only emitted by the app-server for threads it is itself
driving through this RPC connection. The interactive Codex agent Agent Space
launches runs as a separate native TUI process in its own tmux pane, so these
events do not fire for it today — this observation path is dormant until
Agent Space drives turns directly through app-server instead of a spawned TUI.
It is not advertised as native-TUI attention: PR2 owns `turn_completed` and
the review receipt when a proven event source is enabled.

If the app-server exits, pending requests fail and live app-server
observations are cleared. The next resume validation lazily starts a fresh
connection. No terminal close, exit code, silence, or JSONL recency creates a
completion. Rollout JSONL remains a same-thread diagnostic fallback, never an
ownership source.

## Capability smoke

On 2026-08-30, local `codex-cli 0.151.0` was queried with a real stdio
connection (see the #125 regression investigation). `initialize` returned
successfully; `thread/start` returned a UUIDv7 `thread.id` and a rollout
`path` that did not yet exist on disk. A native `codex resume <that-id>` in a
separate process failed with `No saved session found`. Sending a real
`turn/start` over the same app-server connection produced `item/*` and
`turn/completed` events, and only then did the rollout file at the previously
reported `path` appear; a subsequent native `codex resume <that-id>` in a
separate PTY-attached process then opened normally. This is the basis for the
identity-lifecycle correction above: a thread id is only an exact, resumable
identity once its rollout is materialized by a real turn, never merely by
`thread/start`.
