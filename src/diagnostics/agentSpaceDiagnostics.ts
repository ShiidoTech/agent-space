import { setFallbackReporter } from "../agents/sessionProviders/sqliteRead";

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

/** Wire sqliteRead one-shot fallback events into the diagnostics output channel. */
export function configureSqliteFallbackDiagnostics(): void {
	setFallbackReporter((kind) => {
		agentSpaceDiagnostic(`sqlite-fallback: ${kind}`);
	});
}
