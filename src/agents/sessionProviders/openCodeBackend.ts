import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { createInterface } from "node:readline";
import type { OpenCodeSessionProviderOptions } from "./openCodeSessionProvider";
import { OpenCodeSessionProvider } from "./openCodeSessionProvider";

export interface OpenCodeBackendManagerOptions {
	/** Test seam for the process boundary; production uses node:child_process. */
	spawn?: (
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	) => ChildProcess;
}

export interface OpenCodeBackendHandle {
	readonly baseUrl: string;
	readonly pid: number;
	readonly port: number;
	kill(): void;
	/** The scoped session provider for this backend/worktree. */
	readonly sessionProvider: OpenCodeSessionProvider;
	/**
	 * Unique per-spawn identifier, distinct from every other handle this
	 * manager has ever produced (including an earlier handle for the same
	 * worktree). Lets a reconciler tell "this runtime is already reconnected
	 * to the current backend" apart from "the backend was replaced since I
	 * last reconnected" without relying on `baseUrl`/port reuse being unique.
	 */
	readonly instanceId: string;
}

interface PendingHealthCheck {
	resolve: (ok: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface EnsurePromise {
	promise: Promise<OpenCodeBackendHandle>;
	resolve: (handle: OpenCodeBackendHandle) => void;
	reject: (error: Error) => void;
}

/**
 * Per-worktree OpenCode backend manager.
 *
 * One `opencode serve` process per worktree, shared by all agents in the same
 * worktree. The backend is started lazily on the first `ensure()` call and
 * reused for subsequent agents. The process is killed when the extension
 * disposes or when the backend is explicitly shut down.
 *
 * Architecture invariant: Agent Space never runs more than one
 * `opencode serve` per worktree. The port is randomly allocated by the OS
 * (via `--port 0`) so two worktrees never collide.
 */
export class OpenCodeBackendManager {
	private readonly spawnProcess: NonNullable<
		OpenCodeBackendManagerOptions["spawn"]
	>;
	private backends = new Map<string, OpenCodeBackendHandle>();
	private pendingHealthChecks = new Map<string, PendingHealthCheck>();
	/** In-flight ensure() promises, keyed by worktreePath, for coalescence. */
	private ensurePromises = new Map<string, EnsurePromise>();
	/** Invalidates startup completions after shutdown/dispose. */
	private readonly generations = new Map<string, number>();
	/** Child-process cancellation hooks for backends not ready yet. */
	private readonly pendingStarts = new Map<string, () => void>();
	/**
	 * Listeners notified when a worktree's backend exits unexpectedly (i.e.
	 * not via `kill()`/`shutdown()`/`dispose()`). Consumers (e.g. a runtime
	 * reconciler) use this to know a worktree's `opencode attach` clients are
	 * now pointed at a dead server and need to be reconnected once a
	 * replacement backend is ensured. Tmux/runtime logic intentionally does
	 * not live in this class — it only reports the fact.
	 */
	private readonly lostListeners = new Set<(worktreePath: string) => void>();

	constructor(options: OpenCodeBackendManagerOptions = {}) {
		this.spawnProcess = options.spawn ?? defaultSpawn;
	}

	/**
	 * Ensure a backend is running for the given worktree. If one already exists,
	 * return it immediately. Otherwise, start a new `opencode serve` process and
	 * wait for it to be ready.
	 *
	 * Concurrent calls for the same worktree are coalesced into a single spawn.
	 *
	 * @param worktreePath - The worktree directory this backend serves.
	 * @param openCodeBinary - Path to the `opencode` binary. Defaults to `"opencode"`.
	 * @param healthCheckTimeoutMs - How long to wait for the health check. Defaults to 10s.
	 * @param providerOptions - Options to pass to the scoped session provider.
	 * @returns A handle to the running backend (including the scoped provider).
	 * @throws If the backend fails to start or the health check times out.
	 */
	ensure(
		worktreePath: string,
		openCodeBinary = "opencode",
		healthCheckTimeoutMs = 10_000,
		providerOptions: OpenCodeSessionProviderOptions = {},
	): Promise<OpenCodeBackendHandle> {
		const existing = this.backends.get(worktreePath);
		if (existing) {
			return this.isHealthy(existing.baseUrl).then((healthy) => {
				if (healthy) {
					if (this.backends.get(worktreePath) === existing) return existing;
					throw new Error(`Backend was shut down for ${worktreePath}`);
				}
				// Stale backend — kill and restart.
				existing.kill();
				this.backends.delete(worktreePath);
				return this.ensure(
					worktreePath,
					openCodeBinary,
					healthCheckTimeoutMs,
					providerOptions,
				);
			});
		}

		// Coalesce concurrent ensure() calls for the same worktree.
		const inFlight = this.ensurePromises.get(worktreePath);
		if (inFlight) {
			return inFlight.promise;
		}

		let resolvePromise: (handle: OpenCodeBackendHandle) => void = () => {};
		let rejectPromise: (error: Error) => void = () => {};
		const promise = new Promise<OpenCodeBackendHandle>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		// Both are assigned in the executor before the promise is returned.
		const entry: EnsurePromise = {
			promise,
			resolve: resolvePromise,
			reject: rejectPromise,
		};
		this.ensurePromises.set(worktreePath, entry);
		const generation = this.generations.get(worktreePath) ?? 0;

		void this.startBackend(
			worktreePath,
			openCodeBinary,
			healthCheckTimeoutMs,
			providerOptions,
		)
			.then((handle) => {
				if (
					(this.generations.get(worktreePath) ?? 0) !== generation ||
					this.ensurePromises.get(worktreePath) !== entry
				) {
					handle.kill();
					entry.reject(
						new Error(`Backend startup cancelled for ${worktreePath}`),
					);
					return;
				}
				this.backends.set(worktreePath, handle);
				// Clear the in-flight entry in the same tick as resolving it — a
				// `.finally()` on this chain would run a microtask later, leaving
				// a window where a fresh `ensure()` call (e.g. right after this
				// `await` returns, as a crash-recovery caller does) would coalesce
				// onto this already-resolved entry instead of starting anew.
				if (this.ensurePromises.get(worktreePath) === entry) {
					this.ensurePromises.delete(worktreePath);
				}
				entry.resolve(handle);
			})
			.catch((error) => {
				if (this.ensurePromises.get(worktreePath) === entry) {
					this.ensurePromises.delete(worktreePath);
				}
				entry.reject(error instanceof Error ? error : new Error(String(error)));
			});
		return promise;
	}

	/**
	 * Get a backend handle for the given worktree, if one exists and is healthy.
	 * Does NOT start a new backend.
	 */
	get(worktreePath: string): OpenCodeBackendHandle | undefined {
		return this.backends.get(worktreePath);
	}

	/**
	 * Subscribe to unexpected backend exits. Fired once per worktree per
	 * unexpected exit — never for a deliberate `kill()`/`shutdown()`/`dispose()`,
	 * and never when the exiting child has already been superseded by a newer
	 * backend for the same worktree. Returns an unsubscribe function.
	 */
	onBackendLost(listener: (worktreePath: string) => void): () => void {
		this.lostListeners.add(listener);
		return () => this.lostListeners.delete(listener);
	}

	private emitLost(worktreePath: string): void {
		for (const listener of this.lostListeners) {
			try {
				listener(worktreePath);
			} catch (error) {
				console.warn(
					`[OpenCodeBackendManager] onBackendLost listener threw: ${error}`,
				);
			}
		}
	}

	/**
	 * Get the scoped session provider for a worktree, if the backend exists.
	 */
	getSessionProvider(
		worktreePath: string,
	): OpenCodeSessionProvider | undefined {
		return this.backends.get(worktreePath)?.sessionProvider;
	}

	/** Stop and forget the backend serving one worktree. */
	shutdown(worktreePath: string): void {
		this.generations.set(
			worktreePath,
			(this.generations.get(worktreePath) ?? 0) + 1,
		);
		const handle = this.backends.get(worktreePath);
		if (handle) {
			handle.kill();
			this.backends.delete(worktreePath);
		}
		this.pendingStarts.get(worktreePath)?.();
		const pending = this.ensurePromises.get(worktreePath);
		if (pending) {
			pending.reject(new Error(`Backend shutdown for ${worktreePath}`));
			this.ensurePromises.delete(worktreePath);
		}
	}

	/**
	 * Kill all managed backends and clear the map.
	 */
	dispose(): void {
		for (const worktreePath of new Set([
			...this.backends.keys(),
			...this.ensurePromises.keys(),
			...this.pendingStarts.keys(),
		])) {
			this.generations.set(
				worktreePath,
				(this.generations.get(worktreePath) ?? 0) + 1,
			);
		}
		for (const cancel of this.pendingStarts.values()) cancel();
		this.pendingStarts.clear();
		for (const handle of this.backends.values()) {
			handle.kill();
			handle.sessionProvider.dispose();
		}
		this.backends.clear();
		for (const pending of this.pendingHealthChecks.values()) {
			clearTimeout(pending.timer);
			pending.resolve(false);
		}
		this.pendingHealthChecks.clear();
		for (const pending of this.ensurePromises.values()) {
			pending.reject(new Error("Backend manager disposed"));
		}
		this.ensurePromises.clear();
		this.lostListeners.clear();
	}

	private async startBackend(
		worktreePath: string,
		openCodeBinary: string,
		healthCheckTimeoutMs: number,
		providerOptions: OpenCodeSessionProviderOptions,
	): Promise<OpenCodeBackendHandle> {
		return new Promise<OpenCodeBackendHandle>((resolve, reject) => {
			// Use explicit empty password for controlled loopback backend.
			// The server prints a warning if no password is set, but loopback is
			// intentionally unauthenticated. We do NOT inherit OPENCODE_SERVER_PASSWORD.
			const child: ChildProcess = this.spawnProcess(
				openCodeBinary,
				["serve", "--port", "0", "--hostname", "127.0.0.1"],
				{
					cwd: worktreePath,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						OPENCODE_SERVER_PASSWORD: "",
					},
				},
			);

			let resolved = false;
			let settled = false;
			let baseUrl: string | undefined;
			let port = 0;
			let providerDisposed = false;
			const disposeProviderOnce = (sessionProvider: { dispose(): void }) => {
				if (providerDisposed) return;
				providerDisposed = true;
				sessionProvider.dispose();
			};

			// Only the startup-phase listeners (used to reject on an early
			// crash/error) are removed here — never `removeAllListeners()`,
			// which would also strip the persistent post-startup `exit`
			// listener registered below once the handle exists.
			const cleanup = () => {
				child.removeListener("error", onStartupError);
				child.removeListener("exit", onStartupExit);
				stdoutLineReader.close();
				stderrLineReader.close();
			};

			if (!child.stdout || !child.stderr) {
				reject(
					new Error(
						`OpenCode backend failed to start in ${worktreePath}: stdout/stderr not available`,
					),
				);
				return;
			}

			const stdoutLineReader = createInterface({ input: child.stdout });
			const stderrLineReader = createInterface({ input: child.stderr });
			const cancelStartup = () => {
				if (settled) return;
				settled = true;
				if (this.pendingStarts.get(worktreePath) === cancelStartup) {
					this.pendingStarts.delete(worktreePath);
				}
				try {
					child.kill("SIGTERM");
				} catch {
					// best-effort
				}
				cleanup();
				reject(
					new Error(`OpenCode backend startup cancelled for ${worktreePath}`),
				);
			};
			this.pendingStarts.set(worktreePath, cancelStartup);

			// Parse the listen address from stdout.
			// OpenCode prints: "opencode server listening on http://127.0.0.1:<port>"
			stdoutLineReader.on("line", (line) => {
				const match = line.match(
					/opencode server listening on (https?:\/\/[^\s]+)/,
				);
				if (match?.[1] && !resolved) {
					baseUrl = match[1];
					const url = new URL(baseUrl);
					port = Number.parseInt(url.port, 10);
					resolved = true;
					cleanup();
					// Create the scoped session provider for this backend.
					const sessionProvider = new OpenCodeSessionProvider({
						...providerOptions,
						serverUrl: baseUrl,
						serverPassword: "",
					});
					const handle: OpenCodeBackendHandle = {
						baseUrl,
						pid: child.pid ?? 0,
						port,
						sessionProvider,
						instanceId: `${worktreePath}#${child.pid ?? 0}#${Date.now()}#${Math.random().toString(36).slice(2)}`,
						kill: () => {
							try {
								child.kill("SIGTERM");
							} catch {
								// best-effort
							}
							disposeProviderOnce(sessionProvider);
						},
					};
					// Persistent post-startup supervision. Fires on any exit that
					// was not caused by our own `kill()` (which always removes/
					// replaces the map entry synchronously before the child
					// actually exits) and that has not already been superseded by
					// a newer handle for the same worktree — see the identity
					// check below, which also protects against the old-process /
					// new-process race.
					child.on("exit", () => {
						if (this.backends.get(worktreePath) !== handle) return;
						this.backends.delete(worktreePath);
						disposeProviderOnce(sessionProvider);
						this.emitLost(worktreePath);
					});
					// Wait for the health check to pass before resolving.
					this.waitForHealth(baseUrl, healthCheckTimeoutMs)
						.then((ok) => {
							if (settled) return;
							settled = true;
							this.pendingStarts.delete(worktreePath);
							if (ok) {
								resolve(handle);
							} else {
								handle.kill();
								reject(
									new Error(
										`OpenCode backend health check failed for ${worktreePath}`,
									),
								);
							}
						})
						.catch((err) => {
							settled = true;
							this.pendingStarts.delete(worktreePath);
							handle.kill();
							reject(err);
						});
				}
			});

			stderrLineReader.on("line", (line) => {
				// Log stderr for diagnostics but don't fail on it.
				if (line.includes("OPENCODE_SERVER_PASSWORD")) {
					// The server prints a warning if no password is set — this is expected.
				}
			});

			const onStartupError = (error: Error) => {
				if (!resolved && !settled) {
					settled = true;
					this.pendingStarts.delete(worktreePath);
					cleanup();
					reject(
						new Error(
							`OpenCode backend failed to start in ${worktreePath}: ${error.message}`,
						),
					);
				}
			};

			const onStartupExit = (code: number | null) => {
				if (!resolved && !settled) {
					settled = true;
					this.pendingStarts.delete(worktreePath);
					cleanup();
					reject(
						new Error(
							`OpenCode backend exited with code ${code} in ${worktreePath}`,
						),
					);
				}
			};

			child.once("error", onStartupError);
			child.once("exit", onStartupExit);
		});
	}

	private async waitForHealth(
		baseUrl: string,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const pollInterval = 200;
		while (Date.now() < deadline) {
			if (await this.isHealthy(baseUrl)) return true;
			await sleep(pollInterval);
		}
		return false;
	}

	/**
	 * Health check against the OpenCode server.
	 * Uses `/global/health` which is the official health endpoint.
	 */
	private async isHealthy(baseUrl: string): Promise<boolean> {
		try {
			const response = await fetch(`${baseUrl}/global/health`, {
				signal: AbortSignal.timeout(3_000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(
	command: string,
	args: readonly string[],
	options: SpawnOptions,
): ChildProcess {
	return spawn(command, args, options);
}
