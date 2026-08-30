import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import type { TmuxIntegration, TmuxPanesObservation } from "../agents/tmux";
import type { Store } from "../storage/store";
import type { Service, ServiceStatus } from "../types";
import { exec } from "../utils/platform";

export class ServiceManager {
	private servicesByFeature = new Map<string, Service[]>();
	private cachedDefaultBranch: string | undefined;
	private lastRefreshTime = new Map<string, number>();
	private static readonly REFRESH_TTL_MS = 5_000;

	constructor(
		private readonly store: Store,
		private readonly repoRoot: string,
		private readonly tmux: TmuxIntegration,
	) {}

	invalidateFeature(featureId: string): void {
		this.servicesByFeature.delete(featureId);
		this.lastRefreshTime.delete(featureId);
	}

	getServices(featureId: string): Service[] {
		this.refreshStatuses(featureId);
		return [...this.loadServices(featureId)];
	}

	/**
	 * Non-blocking twin of {@link getServices}: identical TTL-guarded refresh
	 * semantics, but background reconciliation
	 * (`FeatureStateCoordinator.reconcilePresence`) never blocks the
	 * Extension Host on a subprocess — and, when `knownTmuxPanes` is given
	 * (that tick's single canonical `list-panes -a` sweep), never makes a
	 * tmux call of its own at all, whether the sweep succeeded or failed
	 * (`status: "unknown"` is a fail-closed "don't retry", not "not
	 * supplied" — see {@link refreshStatusesAsync}).
	 */
	async getServicesAsync(
		featureId: string,
		knownTmuxPanes?: TmuxPanesObservation,
	): Promise<Service[]> {
		await this.refreshStatusesAsync(featureId, knownTmuxPanes);
		return [...this.loadServices(featureId)];
	}

	/**
	 * Read the persisted service model without probing tmux at all — zero
	 * I/O. For a caller that only needs the read model (a UI path that must
	 * never touch tmux) rather than a freshly reconciled status.
	 */
	getServicesReadModel(featureId: string): Service[] {
		return [...this.loadServices(featureId)];
	}

	createService(
		featureId: string,
		name: string,
		command: string,
		launchCommand: string | null = command,
	): Service {
		const services = this.loadServices(featureId);
		const id = crypto.randomUUID();
		const tmuxSession = this.tmux.serviceSessionName(
			this.sessionLabel(featureId),
			id,
		);

		const service: Service = {
			id,
			featureId,
			name,
			command,
			launchCommand,
			tmuxSession,
			status: "running",
			createdAt: new Date().toISOString(),
		};

		services.push(service);
		this.saveServices(featureId, services);
		return service;
	}

	stopService(serviceId: string, featureId: string): void {
		const services = this.loadServices(featureId);
		const service = services.find((s) => s.id === serviceId);
		if (!service) return;
		this.tmux.killSession(service.tmuxSession);
		service.status = "stopped";
		this.saveServices(featureId, services);
	}

	restartService(serviceId: string, featureId: string, cwd: string): void {
		const services = this.loadServices(featureId);
		const service = services.find((s) => s.id === serviceId);
		if (!service) return;

		this.tmux.killSession(service.tmuxSession);
		service.status = this.startServiceSession(service, cwd);
		this.saveServices(featureId, services);
	}

	deleteService(serviceId: string, featureId: string): void {
		const services = this.loadServices(featureId);
		const service = services.find((s) => s.id === serviceId);
		if (service) {
			this.tmux.killSession(service.tmuxSession);
		}
		this.saveServices(
			featureId,
			services.filter((s) => s.id !== serviceId),
		);
	}

	deleteAllServices(featureId: string): void {
		for (const service of this.loadServices(featureId)) {
			this.tmux.killSession(service.tmuxSession);
		}
		this.saveServices(featureId, []);
	}

	refreshStatuses(featureId: string): void {
		const lastRefresh = this.lastRefreshTime.get(featureId);
		if (
			lastRefresh &&
			Date.now() - lastRefresh < ServiceManager.REFRESH_TTL_MS
		) {
			return;
		}
		this.lastRefreshTime.set(featureId, Date.now());

		const services = this.loadServices(featureId);
		let changed = false;
		for (const service of services) {
			if (service.status === "stopped" || service.status === "errored")
				continue;

			const alive = this.tmux.isSessionAlive(service.tmuxSession);
			if (!alive) {
				service.status = "stopped";
				changed = true;
				continue;
			}

			// Session alive — check if the pane process has exited
			// (remain-on-exit keeps the session open after command exits)
			const pane = this.tmux.getPaneStatus(service.tmuxSession);
			if (pane?.dead) {
				service.status = pane.exitCode === 0 ? "stopped" : "errored";
				changed = true;
			}
		}
		if (changed) {
			this.saveServices(featureId, services);
		}
	}

	/**
	 * Non-blocking twin of {@link refreshStatuses}: identical TTL-guarded
	 * decision tree, but probes run through `isSessionAliveAsync` /
	 * `getPaneStatusAsync` so a caller on a background reconciliation path
	 * never blocks the Extension Host on a subprocess.
	 */
	private async refreshStatusesAsync(
		featureId: string,
		knownTmuxPanes?: TmuxPanesObservation,
	): Promise<void> {
		const lastRefresh = this.lastRefreshTime.get(featureId);
		if (
			lastRefresh &&
			Date.now() - lastRefresh < ServiceManager.REFRESH_TTL_MS
		) {
			return;
		}
		this.lastRefreshTime.set(featureId, Date.now());

		const services = this.loadServices(featureId);
		let changed = false;
		await Promise.all(
			services.map(async (service) => {
				if (service.status === "stopped" || service.status === "errored") {
					return;
				}

				// The caller's own canonical sweep for this tick — trust it
				// exclusively, no tmux call of our own (P0 mandate: one tmux
				// subprocess per tick, not one per service). A sweep that was
				// attempted and failed (`status: "unknown"`) must NOT fall
				// through to the per-service probe below — that would turn one
				// failed global sweep into an O(N) retry storm. Leave the
				// service's last-known status untouched instead.
				if (knownTmuxPanes) {
					if (knownTmuxPanes.status === "unknown") {
						return;
					}
					const pane = knownTmuxPanes.panes.get(service.tmuxSession);
					if (!pane) {
						service.status = "stopped";
						changed = true;
						return;
					}
					if (pane.dead) {
						service.status = pane.exitCode === 0 ? "stopped" : "errored";
						changed = true;
					}
					return;
				}

				const alive =
					(await this.tmux.isSessionAliveAsync?.(service.tmuxSession)) ?? false;
				if (!alive) {
					service.status = "stopped";
					changed = true;
					return;
				}

				const pane =
					(await this.tmux.getPaneStatusAsync?.(service.tmuxSession)) ?? null;
				if (pane?.dead) {
					service.status = pane.exitCode === 0 ? "stopped" : "errored";
					changed = true;
				}
			}),
		);
		if (changed) {
			this.saveServices(featureId, services);
		}
	}

	private loadServices(featureId: string): Service[] {
		if (!this.servicesByFeature.has(featureId)) {
			const services = this.normalizeServiceSessions(
				featureId,
				this.store.loadServices(featureId),
			);
			this.servicesByFeature.set(featureId, services);
		}
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by has() check above
		return this.servicesByFeature.get(featureId)!;
	}

	private saveServices(featureId: string, services: Service[]): void {
		this.servicesByFeature.set(featureId, services);
		this.store.saveServices(featureId, services);
	}

	private normalizeServiceSessions(
		featureId: string,
		services: Service[],
	): Service[] {
		let changed = false;
		const label = this.sessionLabel(featureId);

		for (const service of services) {
			const preferredSession = this.tmux.serviceSessionName(label, service.id);
			if (service.tmuxSession === preferredSession) {
				continue;
			}

			this.tmux.adoptSession(preferredSession, service.tmuxSession);
			service.tmuxSession = preferredSession;
			changed = true;
		}

		if (changed) {
			this.store.saveServices(featureId, services);
		}

		return services;
	}

	private startServiceSession(service: Service, cwd: string): ServiceStatus {
		try {
			exec(this.resolveStartCommand(service), { cwd });
			this.tmux.configureServiceSession(service.tmuxSession);
			return this.tmux.isSessionAlive(service.tmuxSession)
				? "running"
				: "errored";
		} catch (err) {
			console.warn(`[ServiceManager] service tmux create failed: ${err}`);
			return "errored";
		}
	}

	private resolveStartCommand(service: Service): string {
		if (service.launchCommand === null) {
			return this.tmux.createShellCommand(service.tmuxSession);
		}

		return this.tmux.createCommand(
			service.tmuxSession,
			service.launchCommand ?? service.command,
		);
	}

	private sessionLabel(featureId: string): string {
		if (!featureId.startsWith("base:")) {
			return featureId;
		}
		return this.getDefaultBranch();
	}

	private getDefaultBranch(): string {
		if (this.cachedDefaultBranch !== undefined) {
			return this.cachedDefaultBranch;
		}
		let branch: string;
		try {
			branch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: this.repoRoot,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			branch = "main";
		}
		this.cachedDefaultBranch = branch;
		return branch;
	}
}
