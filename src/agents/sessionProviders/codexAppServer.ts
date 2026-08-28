import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexAppServerEvent {
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

export interface CodexAppServerTransport {
	request<T>(method: string, params: Record<string, unknown>): Promise<T>;
	onEvent(listener: (event: CodexAppServerEvent) => void): () => void;
	onClose?(listener: () => void): () => void;
	close(): void;
}

interface JsonRpcResponse {
	id?: string | number;
	result?: unknown;
	error?: unknown;
}

/**
 * One long-lived app-server connection per Codex adapter. Threads are the
 * multiplexing key; no event is exposed without a thread id at the adapter
 * boundary. The process is intentionally owned here, not by a one-shot
 * lookup, and is restarted lazily after a crash.
 */
export class CodexAppServerTransportImpl implements CodexAppServerTransport {
	private process?: ChildProcessWithoutNullStreams;
	private sequence = 0;
	private pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private listeners = new Set<(event: CodexAppServerEvent) => void>();
	private closeListeners = new Set<() => void>();
	private initialized?: Promise<void>;

	async request<T>(
		method: string,
		params: Record<string, unknown>,
	): Promise<T> {
		await this.ensureStarted();
		const id = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			try {
				this.process?.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.initialized = undefined;
		for (const request of this.pending.values())
			request.reject(new Error("Codex app-server connection closed"));
		this.pending.clear();
		this.process?.kill();
		this.process = undefined;
		for (const listener of this.closeListeners) listener();
	}

	private async ensureStarted(): Promise<void> {
		if (this.initialized) return this.initialized;
		this.initialized = new Promise<void>((resolve, reject) => {
			const child = spawn("codex", ["app-server", "--stdio"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.process = child;
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => this.handleLine(line));
			child.once("error", (error) => {
				this.initialized = undefined;
				reject(error);
				this.rejectPending(error);
			});
			child.once("exit", () => {
				this.initialized = undefined;
				this.process = undefined;
				this.rejectPending(new Error("Codex app-server exited"));
				for (const listener of this.closeListeners) listener();
			});
			void this.requestAfterSpawn("initialize", {
				clientInfo: {
					name: "agent-space",
					title: "Agent Space",
					version: "0.0.0",
				},
				capabilities: { experimentalApi: true },
			}).then(() => {
				this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
				resolve();
			}, reject);
		});
		return this.initialized;
	}

	private requestAfterSpawn<T>(
		method: string,
		params: Record<string, unknown>,
	) {
		const id = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private write(message: Record<string, unknown>): void {
		this.process?.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		let message: JsonRpcResponse & CodexAppServerEvent;
		try {
			message = JSON.parse(line) as JsonRpcResponse & CodexAppServerEvent;
		} catch {
			return;
		}
		if (message.id !== undefined && this.pending.has(message.id)) {
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error !== undefined) request?.reject(message.error);
			else request?.resolve(message.result);
			return;
		}
		if (typeof message.method === "string")
			for (const listener of this.listeners) listener(message);
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}
}
