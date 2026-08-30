# Agent observation contract

Agent Space keeps four independently observable dimensions:

- identity: the stable Agent Space name and the optional provider session title;
- lifecycle: the universal Agent Space/tmux/process state;
- attention: an optional structured provider observation;
- session: provider binding health.

The persisted agent record contains the stable name, its provenance, the last
provider title, lifecycle facts and binding facts. `AgentObservation` and the
primary label returned by `presentAgentState` are derived at read time.

`unsupported` means that a provider does not promise an observation. `unknown`
means that the provider does promise it, but no usable observation is currently
available. Binding health is never promoted to the primary state.

## Primary-state hierarchy

`presentAgentState` applies this order to the provider-neutral state:

1. lifecycle `errored`, `done`, then `stopped`;
2. attention `waiting_for_user`, `failed`, then pending review, then `working`/`idle`;
3. lifecycle `starting`;
4. running plus attention `unsupported` becomes `Running`;
5. running plus attention `unknown` becomes `Unknown`.

Home and the Feature Sidebar consume `presentAgentCard`, which wraps that state
for the compact card. When lifecycle evidence proves the agent runtime is
running but provider activity is unknown, the card says `Running` and keeps the
activity uncertainty in its detail. It never turns an unknown lifecycle into a
known state. Provider session titles are secondary and omitted when they repeat
the stable name. An ambiguous or unverified session is one explicit `Choose
session` action; other binding states stay in Doctor rather than becoming a
second card status.

## Provider matrix

| Provider | Lifecycle | Session binding | Naming | Working | Waiting user | Idle | Failed |
|---|---|---|---|---|---|---|---|
| Claude | supported | preassigned exact id | supported | supported | supported | supported | supported |
| Codex | supported | file-backed discovery/session | app-server/session | unsupported | unsupported | unsupported | unsupported |
| OpenCode | supported | controlled backend/session | provider title | supported via SSE/store | supported via SSE/store | supported via SSE/store | supported via SSE/store |
| Hermes | supported | exact provider session | supported | unsupported | unsupported | unsupported | supported |
| Copilot | supported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |

Lifecycle remains useful for every provider because it is established by Agent
Space's launch/runtime evidence. Adding a provider with partial capabilities
does not require a Home or Sidebar presentation change.
