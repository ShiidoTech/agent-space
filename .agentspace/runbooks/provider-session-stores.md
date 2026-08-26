---
title: Provider session stores
canonical: true
---

# Provider session stores

Agent Space reads agent session names and activity state from each provider's
own store. This runbook documents the exact schema each provider depends on, the
readonly invariant, and how to validate a store against the contract.

## Invariants

- **Read-only.** Agent Space never writes to a provider store.  All SQLite
  connections use `{ readOnly: true }` + `PRAGMA query_only = ON`.
- **WAL mode.** Provider databases (especially OpenCode) are WAL-locked by the
  running process.  A readonly connection can read concurrently; it never
  interferes with the writer.
- **CLI fallback is a compatibility net.** The subprocess CLI (`opencode db`,
  `hermes sessions export`) is only spawned when the in-process `node:sqlite`
  read is unavailable.  It must never become the steady-state path.
- **Never log real prompt content.** Smoke tests and observability must report
  structural assertions only (length, type, presence), never the actual text of
  user prompts or assistant responses.

---

## OpenCode

### Database location

Resolved via `opencode db path` (cached; retries after 60 s on failure).

Typical path: `~/.local/share/opencode/opencode.db`

### Tables and columns

| Table | Key columns | Notes |
|-------|-------------|-------|
| `session` | `id TEXT PK`, `title TEXT`, `directory TEXT`, `time_created INTEGER` | `title` may be empty — falls back to first user prompt. |
| `message` | `id TEXT`, `session_id TEXT`, `time_created INTEGER`, `time_updated INTEGER`, `data TEXT` | **No `role` column.** Role lives in `data` JSON: `json_extract(data, '$.role')` → `'user'` / `'assistant'`. |
| `part` | `id TEXT`, `message_id TEXT`, `session_id TEXT`, `time_created INTEGER`, `time_updated INTEGER`, `data TEXT` | Prompt text lives here: `json_extract(data, '$.type') = 'text'`, `json_extract(data, '$.text')` → the string. |

### Schema contract (critical)

```
message.data keys: { role, time, agent, model, summary, ... }
part.data keys:    { type: 'text', text: '...' }   (for text parts)
                   { type: 'tool', state: {...}, tool: '...' } (for tool parts)
```

**Do not** reference a `message.role` column — it does not exist in the real
schema.  The P0.2 bug in PR #114 was caused by a fixture that added a fake
`role` column.

### Indexes (verified against production)

- `message_session_time_created_id_idx` on `(session_id, time_created, id)`
- `part_message_id_id_idx` on `(message_id, id)`
- `part_session_idx` on `(session_id)`
- `sqlite_autoindex_message_1` (PK)
- `sqlite_autoindex_part_1` (PK)

All hot queries use these indexes.  Timings: 0.01–0.02 ms per query.

### Timing of first-user-prompt query

Scalar subquery form (used in `USER_PROMPT_SQL`):

```sql
SELECT (
    SELECT p.data FROM part p
    WHERE p.session_id = m.session_id AND p.message_id = m.id
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY p.id ASC LIMIT 1
) AS part_data
FROM message m
WHERE m.session_id = ?
  AND json_extract(m.data, '$.role') = 'user'
ORDER BY m.time_created ASC, m.id ASC
LIMIT 1
```

This avoids the temp b-tree that a JOIN form would require (~6 ms vs ~0.01 ms).

---

## Hermes

### Database location

`$HERMES_HOME/state.db` (defaults to `~/.hermes/state.db`).

### Tables and columns

| Table | Key columns | Notes |
|-------|-------------|-------|
| `sessions` | `id TEXT PK`, `title TEXT`, `cwd TEXT`, `source TEXT` | `title` may be blank. |

### Breadcrumbs

Session-to-cwd mapping stored as JSON files in `$HERMES_HOME/terminal-sessions/`:

```json
{ "session_id": "her_abc", "cwd": "/path/to/project", "ts": 1700000000 }
```

Timestamps are **seconds** (not milliseconds).

### Fallback

`hermes sessions export --session-id <id> --format jsonl -` (async only on the
async path).  Dry-run variant: `--dry-run` for existence checks.

---

## Codex

### Session index location

`~/.codex/session_index.jsonl` (one JSON object per line).

For profiled setups (`codex-perso`), the index lives at the profile root
(parent of the `sessionsDir`):
`~/.codex-perso/session_index.jsonl`.

### Schema

Each line is a JSON object with at minimum:
- `session_id` or `id` — the session identifier
- `thread_name` — optional display name

Session files live under `sessionsDir` (e.g., `~/.codex/sessions/`).

---

## Smoke test

Validate the real stores against the contract:

```bash
npm run smoke:test          # requires AGENTSPACE_SMOKE=1
AGENTSPACE_SMOKE=1 npm run smoke:test
```

Tests run against whatever stores are present on the machine.  Stores that
don't exist are skipped (not failures).  The smoke test never logs real prompt
content.
