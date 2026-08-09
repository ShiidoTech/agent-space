# Agent Space identity/state smoke

This is the release gate for identity and attention. It is intentionally a
real VS Code dogfood scenario, not a unit-test substitute.

1. Open one repository with two features and launch two agents concurrently,
   using different prompts and providers (rotate OpenCode, Codex, Claude and
   Hermes when installed).
2. At launch, after the first prompt, during tool work, at a provider question,
   after answering, after the turn completes, and after stopping, record the
   visible agent name, primary state, feature and project.
3. Restart the extension host / VS Code and repeat the checks. Confirm that a
   bound provider session keeps its name and that no agent silently adopts its
   neighbour's session.
4. If a provider cannot prove ownership, select the compact ⚠ indicator and
   explicitly attach the intended provider session. Confirm that the provider
   title appears automatically afterward.

Expected result: the main row is always `name · primary state`; binding health
is secondary. `Unknown` is exceptional, and `Ambiguous session` is never shown
as the main agent state. The Project page must show the repository base,
features, agents/states and services; the sidebar remains the compact navigator.

Evidence to attach to the PR: screenshots at each checkpoint, provider/version,
feature/project ids, and whether the result is PASS, FAIL_PRODUCT, FAIL_ENV or
NOT_RUN.
