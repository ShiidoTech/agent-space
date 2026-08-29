/**
 * Thin HTTP client for the OpenCode server API.
 *
 * The OpenCode server exposes:
 * - `POST /session` — create a new session, returns `{ id, slug, ... }`
 * - `GET /session` — list all sessions
 * - `GET /api/session` — list all sessions (paginated, `data` wrapper)
 * - `POST /api/session` — create a new session (`data` wrapper)
 * - `GET /event` — Server-Sent Events stream for all sessions (filter by sessionId in payload)
 * - `GET /global/health` — health check endpoint
 *
 * This client is intentionally minimal: it only covers the endpoints
 * needed for controlled session creation and attention signal consumption.
 */
export class OpenCodeHttpClient {
	constructor(
		private readonly baseUrl: string,
		private readonly password?: string,
	) {}

	/**
	 * Create a new session via the OpenCode server.
	 * Returns the exact session id from the provider control plane.
	 *
	 * @param directory - The worktree directory for the session.
	 * @returns The created session's id and proof string.
	 * @throws If the HTTP request fails or the response is malformed.
	 */
	async createSession(
		directory: string,
	): Promise<{ sessionId: string; proof: string }> {
		const response = await this.post("/session", {
			directory,
		});
		const data = await response.json();
		const sessionId = extractSessionId(data);
		if (!sessionId) {
			throw new Error(
				`OpenCode POST /session returned no session id: ${JSON.stringify(data)}`,
			);
		}
		return { sessionId, proof: "opencode.http.post.session" };
	}

	/**
	 * List sessions from the OpenCode server.
	 * Returns an array of session objects with at least `id` and `directory`.
	 */
	async listSessions(): Promise<Array<{ id: string; directory: string }>> {
		const response = await this.get("/session");
		const data = await response.json();
		return extractSessionList(data);
	}

	/**
	 * Check if a session exists in the OpenCode server.
	 */
	async hasSession(sessionId: string): Promise<boolean> {
		const sessions = await this.listSessions();
		return sessions.some((s) => s.id === sessionId);
	}

	/**
	 * Consume SSE events from the OpenCode server, filtered by session id.
	 *
	 * The event stream is `GET /event` (global bus). Each event has a `sessionId`
	 * field that we filter on.
	 *
	 * @param sessionId - The session to filter events for.
	 * @param listener - Called for each event that matches the session.
	 * @returns An abort function to close the event stream.
	 */
	onSessionEvents(
		sessionId: string,
		listener: (event: OpenCodeServerEvent) => void,
	): () => void {
		const controller = new AbortController();
		void this.consumeEventStream(sessionId, listener, controller.signal);
		return () => controller.abort();
	}

	private async consumeEventStream(
		sessionId: string,
		listener: (event: OpenCodeServerEvent) => void,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const url = new URL("/event", this.baseUrl);
			const headers: Record<string, string> = {
				Accept: "text/event-stream",
				"Cache-Control": "no-cache",
			};
			if (this.password) {
				headers.Authorization = `Basic ${btoa(`opencode:${this.password}`)}`;
			}
			const response = await fetch(url.toString(), {
				headers,
				signal,
			});
			if (!response.ok || !response.body) {
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(":")) continue;
					if (trimmed.startsWith("data: ")) {
						const jsonStr = trimmed.slice(6);
						try {
							const parsed = JSON.parse(jsonStr) as OpenCodeServerEvent;
							// Filter by sessionId from the event payload
							if (parsed.sessionId === sessionId) {
								listener(parsed);
							}
						} catch {
							// Ignore malformed event data.
						}
					}
				}
			}
		} catch {
			// Connection aborted or network error — silent close.
		}
	}

	private async post(
		path: string,
		body: Record<string, unknown>,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.password) {
			headers.Authorization = `Basic ${btoa(`opencode:${this.password}`)}`;
		}
		return fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	private async get(path: string): Promise<Response> {
		const headers: Record<string, string> = {};
		if (this.password) {
			headers.Authorization = `Basic ${btoa(`opencode:${this.password}`)}`;
		}
		return fetch(`${this.baseUrl}${path}`, { headers });
	}
}

export interface OpenCodeServerEvent {
	readonly type: string;
	readonly sessionId?: string;
	readonly data?: Record<string, unknown>;
	readonly timestamp?: string;
}

/**
 * Extract a session id from the OpenCode server response.
 *
 * The `/session` endpoint returns a flat object: `{ id, slug, ... }`.
 * The `/api/session` endpoint wraps it: `{ data: { id, slug, ... } }`.
 */
function extractSessionId(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;
	// Direct: { id: "..." }
	if (typeof obj.id === "string" && obj.id) return obj.id;
	// Wrapped: { data: { id: "..." } }
	if (obj.data && typeof obj.data === "object") {
		const inner = obj.data as Record<string, unknown>;
		if (typeof inner.id === "string" && inner.id) return inner.id;
	}
	return null;
}

/**
 * Extract session list from the OpenCode server response.
 *
 * The `/session` endpoint returns a flat array: `[{ id, directory, ... }, ...]`.
 * The `/api/session` endpoint wraps it: `{ data: [{ id, directory, ... }, ...] }`.
 */
function extractSessionList(
	data: unknown,
): Array<{ id: string; directory: string }> {
	if (!data || typeof data !== "object") return [];
	const obj = data as Record<string, unknown>;
	const raw = Array.isArray(obj.data)
		? obj.data
		: Array.isArray(obj)
			? obj
			: [];
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === "object",
		)
		.map((item) => ({
			id: String(item.id ?? ""),
			directory: String(item.directory ?? ""),
		}))
		.filter((s) => s.id);
}
