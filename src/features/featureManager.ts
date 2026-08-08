import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TERMINAL_COLOR_KEYS } from "../constants/colors";
import { checkWorktreeDeletionSafety } from "../git/worktreeSafety";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Store } from "../storage/store";
import type {
	Feature,
	FeatureStatus,
	GitAwareStatus,
	IsolationMode,
} from "../types";
import { isWorktreePathSafe } from "../utils/worktreeGuard";
import { computeGitStatus, computeGitStatusAsync } from "./featureGitStatus";
import { normalizeFeatureName } from "./featureName";

export interface FeatureDeleteResult {
	deleted: boolean;
	reasons: string[];
}

export type FeatureLifecycleStatus =
	| "valid"
	| "missing_worktree"
	| "detached_head"
	| "branch_mismatch"
	| "git_state_unknown";

export interface FeatureLifecycleDiagnostic {
	featureId: string;
	featurePath: string;
	declaredBranch: string;
	actualBranch?: string;
	status: FeatureLifecycleStatus;
}

export class FeatureManager {
	private features: Feature[];
	private cachedBaseBranch: string | undefined;

	constructor(
		private readonly store: Store,
		private readonly repoRoot: string,
		private readonly worktreeBase: string,
		private config: ProjectConfig = {},
	) {
		this.features = store.loadFeatures();
	}

	/**
	 * Synthesize a virtual Feature for the repo root (base branch).
	 * Not persisted to storage.
	 */
	getBaseFeature(projectId: string): Feature {
		const branch = this.getBaseBranch();
		return {
			id: `base:${projectId}`,
			name: branch,
			branch,
			worktreePath: this.repoRoot,
			status: "active",
			color: "terminal.ansiBlue",
			isolation: "shared",
			createdAt: new Date(0).toISOString(),
		};
	}

	/** The effective base branch (configured, or checked-out as a fallback). */
	getBaseBranchName(): string {
		return this.getBaseBranch();
	}

	/** The worktree base directory used for this project's features. */
	getWorktreeBase(): string {
		return this.worktreeBase;
	}

	/** Branch kinds offered at feature creation (e.g. ["feature", "fix"]). */
	getBranchKinds(): string[] {
		return this.config.branchKinds?.filter(Boolean) ?? [];
	}

	/** Default branch kind, if any is declared by the project. */
	getDefaultBranchKind(): string | undefined {
		return this.config.defaultBranchKind;
	}

	/** Commands declared by the project for explicit worktree setup. */
	getBootstrapCommands(): string[] {
		return (this.config.bootstrapCommands ?? [])
			.map((command) => command.trim())
			.filter(Boolean);
	}

	/**
	 * Inspect persisted features against their current worktree state.
	 * This is deliberately read-only: stale state is reported, never repaired
	 * by guessing or resetting Git.
	 */
	inspectFeatureLifecycle(): FeatureLifecycleDiagnostic[] {
		return this.features.map((feature) => {
			if (!fs.existsSync(feature.worktreePath)) {
				return {
					featureId: feature.id,
					featurePath: feature.worktreePath,
					declaredBranch: feature.branch,
					status: "missing_worktree",
				};
			}

			try {
				const isWorktree = String(
					execSync("git rev-parse --is-inside-work-tree", {
						cwd: feature.worktreePath,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "pipe"],
					}),
				).trim();
				if (isWorktree !== "true") {
					return {
						featureId: feature.id,
						featurePath: feature.worktreePath,
						declaredBranch: feature.branch,
						status: "git_state_unknown",
					};
				}

				let actualBranch: string;
				try {
					actualBranch = String(
						execSync("git symbolic-ref --quiet --short HEAD", {
							cwd: feature.worktreePath,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "pipe"],
						}),
					).trim();
				} catch {
					return {
						featureId: feature.id,
						featurePath: feature.worktreePath,
						declaredBranch: feature.branch,
						status: "detached_head",
					};
				}
				return {
					featureId: feature.id,
					featurePath: feature.worktreePath,
					declaredBranch: feature.branch,
					actualBranch: actualBranch || undefined,
					status: actualBranch === feature.branch ? "valid" : "branch_mismatch",
				};
			} catch {
				return {
					featureId: feature.id,
					featurePath: feature.worktreePath,
					declaredBranch: feature.branch,
					status: "git_state_unknown",
				};
			}
		});
	}

	setProjectConfig(config: ProjectConfig): void {
		this.config = config;
		this.cachedBaseBranch = undefined;
	}

	private getBaseBranch(): string {
		if (this.cachedBaseBranch) return this.cachedBaseBranch;

		// A configured base branch wins over whatever is checked out in the
		// main checkout: git actions and statuses must be computed against the
		// project's real base (e.g. v2_ia_first), never the branch momentarily
		// checked out, and never an implicit "main".
		const configured = this.config.baseBranch?.trim();
		if (configured) {
			this.cachedBaseBranch = configured;
			return configured;
		}

		try {
			this.cachedBaseBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: this.repoRoot,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			this.cachedBaseBranch = "main";
		}
		return this.cachedBaseBranch;
	}

	/**
	 * A feature is represented by a dedicated worktree. Git therefore owns the
	 * authoritative branch identity. If that branch is renamed or changed
	 * outside Agent Space, reconcile the persisted metadata before any status,
	 * PR, deletion-safety, or per-agent operation consumes `feature.branch`.
	 *
	 * Detached/missing worktrees deliberately keep the persisted value: there is
	 * no trustworthy replacement branch to invent in that state.
	 */
	private reconcileFeatureBranch(feature: Feature): void {
		try {
			const branch = String(
				execSync("git symbolic-ref --quiet --short HEAD", {
					cwd: feature.worktreePath,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				}),
			).trim();
			if (!branch || branch === feature.branch) return;

			feature.branch = branch;
			this.store.saveFeatures(this.features);
		} catch {
			// Detached HEAD, missing worktree, or unavailable Git: retain the
			// persisted branch instead of guessing.
		}
	}

	reload(): void {
		this.features = this.store.loadFeatures();
	}

	getFeatures(): Feature[] {
		for (const feature of this.features) {
			this.reconcileFeatureBranch(feature);
		}
		return [...this.features];
	}

	getFeature(id: string): Feature | undefined {
		const feature = this.features.find((f) => f.id === id);
		if (feature) this.reconcileFeatureBranch(feature);
		return feature;
	}

	/**
	 * Create a feature: a git worktree branch created from the configured base
	 * branch (never from the momentarily-checked-out HEAD), placed in the
	 * configured worktree base.
	 *
	 * `branchKind` selects the branch prefix (e.g. `feature`/`fix`). When the
	 * project declares `defaultBranchKind` it is used unless a kind is given;
	 * otherwise `feat` keeps backwards compatibility.
	 */
	createFeature(
		name: string,
		isolation: IsolationMode,
		branchKind?: string,
	): Feature {
		const displayName = name.trim();
		const normalizedName = normalizeFeatureName(displayName);
		if (!normalizedName) {
			throw new Error("Feature name is required");
		}

		const kind = branchKind?.trim() || this.config.defaultBranchKind || "feat";
		const branch = `${kind}/${normalizedName}`;

		const existing = this.features.find(
			(f) =>
				f.name === displayName ||
				normalizeFeatureName(f.name) === normalizedName ||
				f.branch === branch,
		);
		if (existing) {
			throw new Error(
				`Feature "${displayName}" conflicts with existing feature "${existing.name}"`,
			);
		}

		const id = crypto.randomUUID();
		const worktreePath = path.join(
			this.worktreeBase,
			`${kind}-${normalizedName}`,
		);
		const baseBranch = this.getBaseBranch();
		const createdFromSha = String(
			execSync(`git rev-parse "${baseBranch}"`, {
				cwd: this.repoRoot,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).trim();

		execSync(
			`git worktree add "${worktreePath}" -b "${branch}" "${baseBranch}"`,
			{
				cwd: this.repoRoot,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		const feature: Feature = {
			id,
			name: displayName,
			branch,
			worktreePath,
			status: "active",
			color: this.pickColor(displayName),
			isolation,
			createdAt: new Date().toISOString(),
			createdFromSha,
		};

		this.features.push(feature);
		this.store.saveFeatures(this.features);
		return feature;
	}

	/**
	 * Evaluate whether a feature can be removed without losing work. Returns
	 * the combined reasons across the feature worktree. Safe to call before
	 * any destructive step.
	 */
	getDeletionSafety(feature: Feature) {
		this.reconcileFeatureBranch(feature);
		return checkWorktreeDeletionSafety({
			repoRoot: this.repoRoot,
			worktreeBase: this.worktreeBase,
			worktreePath: feature.worktreePath,
			branch: feature.branch,
			baseBranch: this.getBaseBranch(),
		});
	}

	/**
	 * Fail-closed deletion. Refuses (throws with reasons) unless explicitly
	 * forced. A forced path is only ever chosen by a human after the checklist
	 * has been shown; the nominal path never uses `--force`.
	 */
	deleteFeature(
		id: string,
		options?: { force?: boolean },
	): FeatureDeleteResult {
		const feature = this.features.find((f) => f.id === id);
		if (!feature) return { deleted: false, reasons: [] };

		const force = options?.force === true;
		const safety = this.getDeletionSafety(feature);

		if (!force && !safety.safe) {
			throw new Error(
				`Cannot delete feature "${feature.name}":\n\n${safety.reasons.join("\n")}`,
			);
		}

		if (isWorktreePathSafe(feature.worktreePath, this.worktreeBase)) {
			try {
				execSync(
					`git worktree remove "${feature.worktreePath}"${force ? " --force" : ""}`,
					{
						cwd: this.repoRoot,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
			} catch {
				// Worktree may already be gone
			}
		} else {
			console.error(
				`[FeatureManager] Refusing to remove worktree outside base: "${feature.worktreePath}"`,
			);
		}

		this.store.deleteFeatureData(id);
		this.features = this.features.filter((f) => f.id !== id);
		this.store.saveFeatures(this.features);
		return { deleted: true, reasons: safety.reasons };
	}

	updateFeatureStatus(id: string, status: FeatureStatus): void {
		const feature = this.features.find((f) => f.id === id);
		if (!feature) return;
		feature.status = status;
		this.store.saveFeatures(this.features);
	}

	updateFeatureIsolation(id: string, isolation: IsolationMode): void {
		const feature = this.features.find((f) => f.id === id);
		if (!feature) return;
		feature.isolation = isolation;
		this.store.saveFeatures(this.features);
	}

	getFeatureGitStatus(feature: Feature): GitAwareStatus {
		this.reconcileFeatureBranch(feature);
		return computeGitStatus({
			featureBranch: feature.branch,
			baseBranch: this.getBaseBranch(),
			worktreePath: feature.worktreePath,
			repoRoot: this.repoRoot,
			...(feature.createdFromSha
				? { createdFromSha: feature.createdFromSha }
				: {}),
		});
	}

	async getFeatureGitStatusAsync(feature: Feature): Promise<GitAwareStatus> {
		this.reconcileFeatureBranch(feature);
		return computeGitStatusAsync({
			featureBranch: feature.branch,
			baseBranch: this.getBaseBranch(),
			worktreePath: feature.worktreePath,
			repoRoot: this.repoRoot,
			...(feature.createdFromSha
				? { createdFromSha: feature.createdFromSha }
				: {}),
		});
	}

	private pickColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash * 31 + name.charCodeAt(i)) | 0;
		}
		return TERMINAL_COLOR_KEYS[Math.abs(hash) % TERMINAL_COLOR_KEYS.length];
	}
}
