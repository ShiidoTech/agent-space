export type AgentSpaceDiagnosticSink = (message: string) => void;

let sink: AgentSpaceDiagnosticSink = () => {};

export function configureAgentSpaceDiagnostics(
	next: AgentSpaceDiagnosticSink,
): void {
	sink = next;
}

export function agentSpaceDiagnostic(message: string): void {
	sink(`[${new Date().toISOString()}] ${message}`);
}

/**
 * UI refresh paths (sidebar/Home/project-change) must never fail silently:
 * a swallowed rejection leaves a stale snapshot on screen presented as
 * fresh. Log through the diagnostics channel so the failure is visible in
 * `Agent Space Diagnostics` instead of vanishing.
 */
export function reportUiRefreshError(scope: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	agentSpaceDiagnostic(`ui-refresh failed [${scope}]: ${detail}`);
}

/** Wire sqliteRead one-shot fallback events into the diagnostics output channel. */
export function configureSqliteFallbackDiagnostics(): void {
	// Lazy require: a top-level import would evaluate sqliteRead's module
	// scope (promisify(execFile)) inside every low-level importer of this
	// file (stores, coordinators), breaking tests that partially mock
	// node:child_process — the same reason platform.ts lazily inits exec.
	const { setFallbackReporter } =
		require("../agents/sessionProviders/sqliteRead") as {
			setFallbackReporter: (reporter: (kind: string) => void) => void;
		};
	setFallbackReporter((kind) => {
		agentSpaceDiagnostic(`sqlite-fallback: ${kind}`);
	});
}
