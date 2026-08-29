import type { Agent, CodingTool } from "../types";
import type { CodingToolRegistry } from "./codingToolRegistry";

export interface SessionProvenDeps {
	toolRegistry: CodingToolRegistry;
}

/**
 * Prove the persisted session id still exists before resuming it. A provider
 * with a session store is checked fresh (`hasSession`); a provider without one
 * can only fall back on a previously persisted `bound` verdict — never on an
 * ordering or naming heuristic.
 */
export async function sessionIsProven(
	deps: SessionProvenDeps,
	tool: CodingTool,
	agent: Agent,
): Promise<boolean> {
	const adapter = deps.toolRegistry.getProvider(tool).sessionAdapter;
	if (adapter?.async?.hasSession) {
		try {
			return (
				(await adapter.async.hasSession(agent.sessionId as string)) === true
			);
		} catch {
			return false;
		}
	}
	if (adapter?.hasSession) return false;
	return agent.sessionBinding?.state === "bound";
}
