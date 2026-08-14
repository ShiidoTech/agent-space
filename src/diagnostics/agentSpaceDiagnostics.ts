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
