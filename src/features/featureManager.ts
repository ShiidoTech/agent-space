import { execFile, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { TERMINAL_COLOR_KEYS } from "../constants/colors";
import { checkWorktreeDeletionSafety } from "../git/worktreeSafety";
import type { ProjectConfig } from "../projects/projectConfig";
import type { Store } from "../storage/store";
import type {
	Feature,
	FeatureBranchLink,
	FeatureStatus,
	IsolationMode,
} from "../types";
import { isWorktreePathSafe } from "../utils/worktreeGuard";
import { normalizeFeatureName } from "./featureName";

const execFileAsync = promisify(execFile);

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

export type FeatureBranchCheckoutObservation =
	| {
			readonly status: "known";
			readonly ref: string;
			readonly linked: boolean;
			readonly role?: FeatureBranchLink["role"];
	  }
	| { readonly status: "detached"; readonly headSha: string }
	| { readonly status: "unknown"; readonly reason: string };

/** Read model for a Feature's delivery identity and current checkout. */
export interface FeatureBranchState {
	readonly primary: string;
	readonly links: readonly Readonly<FeatureBranchLink>[];
	readonly checkout: FeatureBranchCheckoutObservation;
}

interface RegisteredWorktree {
	path: string;
	headSha?: string;
	branchRef?: string;
	detached: boolean;
	bare: boolean;
	prunable: boolean;
}

function parseRegisteredWorktrees(output: string): RegisteredWorktree[] {
	const worktrees: RegisteredWorktree[] = [];
	let current: RegisteredWorktree | undefined;

	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		const separator = line.indexOf(" ");
		const key = separator < 0 ? line : line.slice(0, separator);
		const value = separator < 0 ? "" : line.slice(separator + 1);
		if (key === "worktree") {
			if (current) worktrees.push(current);
			current = {
				path: value,
				detached: false,
				bare: false,
				prunable: false,
			};
		} else if (current) {
			if (key === "HEAD") current.headSha = value;
			if (key === "branch") current.branchRef = value;
			if (key === "detached") current.detached = true;
			if (key === "bare") current.bare = true;
			if (key === "prunable") current.prunable = true;
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

export class FeatureManager {
	private features: Feature[];
	private cachedBaseBranch: string | undefined;
	private onChangeCallback?: () => void;
	private readonly activeProvisioningIds = new Set<string>();

	constructor(
		private readonly store: Store,
		private readonly repoRoot: string,
		private readonly worktreeBase: string,
		private config: ProjectConfig = {},
	) {
		this.features = store.loadFeatures();
		this.recoverCompletedProvisioning();
	}

	setOnChange(callback: () => void): void {
		this.onChangeCallback = callback;
	}

	/**
	 * Synthesize a virtual Feature for the repo root (base branch).
	 * Not persisted to storage.
	 */
	getBaseFeature(projectId: string): Feature {
		let branch: string;
		try {
			branch = this.getBaseBranch();
		} catch {
			// Observation-only consumers still need the synthetic Feature identity.
			// Keep the branch explicitly unknown; Git actions call
			// getBaseBranchName() and remain fail-closed.
			branch = "(unknown base)";
		}
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
			const detected = String(
				execSync("git rev-parse --abbrev-ref HEAD", {
					cwd: this.repoRoot,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				}),
			).trim();
			if (!detected || detected === "HEAD") {
				throw new Error("Git did not report a local branch");
			}
			this.cachedBaseBranch = detected;
		} catch (error) {
			const detail = error instanceof Error ? `: ${error.message}` : "";
			throw new Error(
				`Unable to determine the project base branch${detail}. Configure baseBranch explicitly before running Git actions.`,
			);
		}
		return this.cachedBaseBranch;
	}

	/**
	 * Migrate the branch model without treating the worktree checkout as the
	 * delivery identity. A continuation is linked only when both the worktree
	 * reflog and commit ancestry prove its relationship to an existing link.
	 * No Git ref is created, moved, fetched, checked out, or deleted here.
	 */
	private reconcileFeatureBranches(feature: Feature): FeatureBranchState {
		const checkout = this.observeFeatureCheckout(feature);
		let changed = false;
		const hadLinks = Array.isArray(feature.branchLinks);

		if (!hadLinks) {
			const recovered = this.recoverLegacyPrimary(feature, checkout);
			if (recovered) {
				feature.primaryBranchRef = recovered.primary;
				feature.branchLinks = [
					this.branchLink(recovered.primary, "primary", "reflog_checkout"),
					this.branchLink(
						recovered.continuation,
						"continuation",
						"reflog_checkout",
						recovered.primary,
					),
				];
				changed = true;
			} else {
				feature.primaryBranchRef = feature.branch;
				feature.branchLinks = [
					this.branchLink(feature.branch, "primary", "legacy_record"),
				];
				changed = true;
			}
		}

		const links = feature.branchLinks ?? [];
		const linkedPrimary = links.find((link) => link.role === "primary")?.ref;
		if (!feature.primaryBranchRef) {
			feature.primaryBranchRef = linkedPrimary ?? feature.branch;
			changed = true;
		}
		if (!links.some((link) => link.role === "primary")) {
			links.unshift(
				this.branchLink(feature.primaryBranchRef, "primary", "legacy_record"),
			);
			changed = true;
		}
		let primary = feature.primaryBranchRef;
		if (linkedPrimary && linkedPrimary !== primary) {
			feature.primaryBranchRef = linkedPrimary;
			primary = linkedPrimary;
			changed = true;
		}

		if (
			checkout.status === "known" &&
			!links.some((link) => link.ref === checkout.ref) &&
			this.isProvedContinuation(feature, checkout.ref, links)
		) {
			links.push(
				this.branchLink(
					checkout.ref,
					"continuation",
					"reflog_checkout",
					primary,
				),
			);
			changed = true;
		}
		if (
			checkout.status === "known" &&
			links.some((link) => link.ref === checkout.ref) &&
			feature.branch !== checkout.ref
		) {
			feature.branch = checkout.ref;
			changed = true;
		}

		if (changed) this.store.saveFeatures(this.features);
		return this.branchState(feature, checkout);
	}

	private observeFeatureCheckout(
		feature: Feature,
	): FeatureBranchCheckoutObservation {
		try {
			const branch = this.git(
				"git symbolic-ref --quiet --short HEAD",
				feature.worktreePath,
			);
			if (!branch) {
				return { status: "unknown", reason: "Git returned an empty branch." };
			}
			const link = feature.branchLinks?.find(
				(candidate) => candidate.ref === branch,
			);
			return {
				status: "known",
				ref: branch,
				linked: Boolean(link),
				...(link ? { role: link.role } : {}),
			};
		} catch (branchError) {
			try {
				const headSha = this.git(
					"git rev-parse --verify HEAD^{commit}",
					feature.worktreePath,
				);
				if (isCommitSha(headSha)) return { status: "detached", headSha };
			} catch {
				// The worktree or Git state is unavailable, not proven detached.
			}
			return {
				status: "unknown",
				reason:
					branchError instanceof Error
						? branchError.message
						: "The worktree branch could not be observed.",
			};
		}
	}

	private recoverLegacyPrimary(
		feature: Feature,
		checkout: FeatureBranchCheckoutObservation,
	): { primary: string; continuation: string } | undefined {
		if (checkout.status !== "known" || checkout.ref !== feature.branch) {
			return undefined;
		}
		const transition = this.recentCheckoutInto(feature, checkout.ref);
		if (!transition) return undefined;
		if (
			!branchMatchesFeatureName(transition.from, feature.name) ||
			branchMatchesFeatureName(checkout.ref, feature.name)
		) {
			return undefined;
		}
		const previousSha = this.resolveBranch(transition.from);
		const currentSha = this.resolveBranch(checkout.ref);
		const previousUpstreamSha = this.resolveUpstream(transition.from);
		if (
			!previousSha ||
			!currentSha ||
			previousUpstreamSha !== previousSha ||
			!this.isAncestor(previousSha, currentSha)
		) {
			return undefined;
		}
		return { primary: transition.from, continuation: checkout.ref };
	}

	private isProvedContinuation(
		feature: Feature,
		checkoutRef: string,
		links: readonly FeatureBranchLink[],
	): boolean {
		const transition = this.recentCheckoutInto(feature, checkoutRef);
		if (!transition || !links.some((link) => link.ref === transition.from)) {
			return false;
		}
		const primary =
			feature.primaryBranchRef ??
			links.find((link) => link.role === "primary")?.ref;
		if (!primary) return false;
		const primarySha = this.resolveBranch(primary);
		const checkoutSha = this.resolveBranch(checkoutRef);
		return Boolean(
			primarySha && checkoutSha && this.isAncestor(primarySha, checkoutSha),
		);
	}

	private recentCheckoutInto(
		feature: Feature,
		toRef: string,
	): { from: string; to: string } | undefined {
		try {
			const messages = this.git(
				"git reflog --format=%gs -n 25 HEAD",
				feature.worktreePath,
			);
			for (const message of messages.split(/\r?\n/u)) {
				const match = /^checkout: moving from (.+) to (.+)$/u.exec(
					message.trim(),
				);
				if (!match || match[2] !== toRef) continue;
				if (!isSafeBranchName(match[1]) || !isSafeBranchName(match[2])) {
					return undefined;
				}
				return { from: match[1], to: match[2] };
			}
		} catch {
			// Reflog absence is insufficient proof, so no branch is linked.
		}
		return undefined;
	}

	private resolveBranch(branch: string): string | undefined {
		if (!isSafeBranchName(branch)) return undefined;
		try {
			const sha = this.git(
				`git rev-parse --verify "refs/heads/${branch}^{commit}"`,
				this.repoRoot,
			);
			return isCommitSha(sha) ? sha.toLowerCase() : undefined;
		} catch {
			return undefined;
		}
	}

	private resolveUpstream(branch: string): string | undefined {
		if (!isSafeBranchName(branch)) return undefined;
		try {
			const sha = this.git(
				`git rev-parse --verify "${branch}@{upstream}^{commit}"`,
				this.repoRoot,
			);
			return isCommitSha(sha) ? sha.toLowerCase() : undefined;
		} catch {
			return undefined;
		}
	}

	/** Commits present in the base branch but missing from the given branch. */
	private commitsBehind(branch: string, baseBranch: string): number {
		try {
			const output = this.git(
				`git rev-list --count "${branch}..${baseBranch}"`,
				this.repoRoot,
			);
			const count = Number.parseInt(output.trim(), 10);
			return Number.isFinite(count) && count >= 0 ? count : 0;
		} catch {
			return 0;
		}
	}

	private isAncestor(ancestorSha: string, descendantSha: string): boolean {
		try {
			this.git(
				`git merge-base --is-ancestor "${ancestorSha}" "${descendantSha}"`,
				this.repoRoot,
			);
			return true;
		} catch {
			return false;
		}
	}

	private branchLink(
		ref: string,
		role: FeatureBranchLink["role"],
		source: FeatureBranchLink["source"],
		relationRef?: string,
	): FeatureBranchLink {
		return {
			ref,
			role,
			linkedAt: new Date().toISOString(),
			source,
			...(relationRef
				? { relation: { kind: "descends_from" as const, ref: relationRef } }
				: {}),
		};
	}

	private branchState(
		feature: Feature,
		checkout: FeatureBranchCheckoutObservation,
	): FeatureBranchState {
		const links = (feature.branchLinks ?? []).map((link) => ({ ...link }));
		if (checkout.status !== "known") {
			return {
				primary: feature.primaryBranchRef ?? feature.branch,
				links,
				checkout,
			};
		}
		const link = links.find((candidate) => candidate.ref === checkout.ref);
		return {
			primary: feature.primaryBranchRef ?? feature.branch,
			links,
			checkout: {
				status: "known",
				ref: checkout.ref,
				linked: Boolean(link),
				...(link ? { role: link.role } : {}),
			},
		};
	}

	private git(command: string, cwd: string): string {
		return String(
			execSync(command, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).trim();
	}

	reload(): void {
		const loaded = this.store.loadFeatures();
		// The storage watcher also observes this extension host's own atomic writes.
		// Keep locally-owned objects alive across those events: an async Git step may
		// still hold one until it reacquires the record by id after its await.
		for (const current of this.features) {
			if (!this.activeProvisioningIds.has(current.id)) continue;
			const index = loaded.findIndex((feature) => feature.id === current.id);
			if (index >= 0) loaded[index] = current;
			else loaded.push(current);
		}
		this.features = loaded;
		this.recoverCompletedProvisioning();
	}

	/** A spinner is honest only while this extension host owns the operation. */
	isProvisioningActive(id: string): boolean {
		return this.activeProvisioningIds.has(id);
	}

	getFeatures(): Feature[] {
		for (const feature of this.features) {
			this.reconcileFeatureBranches(feature);
		}
		return [...this.features];
	}

	/**
	 * The in-memory feature list without branch-link reconciliation: no
	 * synchronous Git reads and no migration writes. For read-only surfaces
	 * that only need presence (existence, name, id) — e.g. the sidebar's
	 * lightweight polling lane — not evidence about branch state.
	 */
	listFeaturesCached(): Feature[] {
		return [...this.features];
	}

	getFeature(id: string): Feature | undefined {
		const feature = this.features.find((f) => f.id === id);
		if (feature) this.reconcileFeatureBranches(feature);
		return feature;
	}

	/** Observe linked branches without conflating checkout and delivery identity. */
	getFeatureBranchState(id: string): FeatureBranchState | undefined {
		const feature = this.features.find((candidate) => candidate.id === id);
		return feature ? this.reconcileFeatureBranches(feature) : undefined;
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
		const feature = this.createFeatureRecord(name, isolation, branchKind);
		try {
			this.provisionFeatureSync(feature.id);
		} finally {
			this.activeProvisioningIds.delete(feature.id);
		}
		return feature;
	}

	/** Save a visible Feature record before Git work starts. */
	createFeatureRecord(
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
		const feature: Feature = {
			id,
			name: displayName,
			branch,
			primaryBranchRef: branch,
			branchLinks: [
				{
					ref: branch,
					role: "primary",
					linkedAt: new Date().toISOString(),
					source: "feature_created",
				},
			],
			worktreePath,
			status: "active",
			color: this.pickColor(displayName),
			isolation,
			createdAt: new Date().toISOString(),
			provisioning: {
				state: "provisioning",
				steps: [
					{ id: "resolve-base", label: "Preparing feature", status: "pending" },
					{
						id: "create-worktree",
						label: "Creating branch and worktree",
						status: "pending",
					},
				],
			},
		};

		this.features.push(feature);
		this.activeProvisioningIds.add(feature.id);
		this.store.saveFeatures(this.features);
		return feature;
	}

	async provisionFeature(id: string): Promise<Feature | undefined> {
		this.activeProvisioningIds.add(id);
		// Yield once so the cockpit paints its pending state, then keep Git off
		// the extension host thread while the worktree is being created.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		try {
			await this.provisionFeatureAsync(id);
			return this.features.find((candidate) => candidate.id === id);
		} catch (error) {
			const feature = this.features.find((candidate) => candidate.id === id);
			const progress = feature?.provisioning;
			if (progress) {
				const step = progress.steps.find(
					(candidate) => candidate.status === "running",
				);
				const message = error instanceof Error ? error.message : String(error);
				if (step) {
					step.status = "failed";
					step.error = message;
				}
				progress.state = "failed";
				progress.error = message;
				this.saveAndNotify();
			}
			throw error;
		} finally {
			this.activeProvisioningIds.delete(id);
		}
	}

	private async provisionFeatureAsync(id: string): Promise<void> {
		const initial = this.features.find((candidate) => candidate.id === id);
		if (!initial?.provisioning) return;
		const expectedBranch = initial.branch;
		const expectedWorktreePath = initial.worktreePath;
		const baseBranch = this.getBaseBranch();
		initial.provisioning.steps[0].status = "running";
		this.saveAndNotify();
		const baseResult = await execFileAsync("git", ["rev-parse", baseBranch], {
			cwd: this.repoRoot,
			encoding: "utf8",
		});
		let branchExists = false;
		let behind = 0;
		try {
			const branchResult = await execFileAsync(
				"git",
				["rev-parse", "--verify", `refs/heads/${expectedBranch}^{commit}`],
				{ cwd: this.repoRoot, encoding: "utf8" },
			);
			branchExists = isCommitSha(String(branchResult.stdout).trim());
		} catch {
			// Ref not found: a new branch will be created.
		}
		if (branchExists) {
			const behindResult = await execFileAsync(
				"git",
				["rev-list", "--count", `${expectedBranch}..${baseBranch}`],
				{ cwd: this.repoRoot, encoding: "utf8" },
			);
			const parsed = Number.parseInt(String(behindResult.stdout).trim(), 10);
			behind = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
		}
		const afterBase = this.getProvisioningFeature(
			id,
			expectedBranch,
			expectedWorktreePath,
		);
		if (branchExists) {
			// The branch already exists in git (e.g. created manually or by a
			// previously finished feature). Reuse it instead of failing, and
			// surface how far behind the base branch it has drifted.
			const worktreeStep = afterBase.provisioning.steps[1];
			worktreeStep.label =
				behind > 0
					? `Reusing existing branch ${expectedBranch} (${behind} commits behind ${baseBranch})`
					: `Reusing existing branch ${expectedBranch}`;
		} else {
			afterBase.createdFromSha = String(baseResult.stdout).trim();
		}
		afterBase.provisioning.steps[0].status = "completed";
		afterBase.provisioning.steps[1].status = "running";
		this.saveAndNotify();
		await execFileAsync(
			"git",
			branchExists
				? ["worktree", "add", expectedWorktreePath, expectedBranch]
				: [
						"worktree",
						"add",
						expectedWorktreePath,
						"-b",
						expectedBranch,
						baseBranch,
					],
			{ cwd: this.repoRoot, encoding: "utf8" },
		);
		const completed = this.getProvisioningFeature(
			id,
			expectedBranch,
			expectedWorktreePath,
		);
		if (branchExists) {
			completed.reusedExistingBranch = { behind };
		}
		completed.provisioning.state = "ready";
		completed.provisioning.currentStepId = undefined;
		for (const step of completed.provisioning.steps) step.status = "completed";
		this.saveAndNotify();
	}

	private getProvisioningFeature(
		id: string,
		expectedBranch: string,
		expectedWorktreePath: string,
	): Feature & { provisioning: NonNullable<Feature["provisioning"]> } {
		const feature = this.features.find((candidate) => candidate.id === id);
		if (!feature?.provisioning) {
			throw new Error(
				"Feature setup metadata disappeared while Git was running",
			);
		}
		if (
			feature.branch !== expectedBranch ||
			path.resolve(feature.worktreePath) !== path.resolve(expectedWorktreePath)
		) {
			throw new Error("Feature setup metadata changed while Git was running");
		}
		return feature as Feature & {
			provisioning: NonNullable<Feature["provisioning"]>;
		};
	}

	/**
	 * Recover only from positive, repository-owned Git evidence. Missing,
	 * partial, detached or unreadable state remains provisioning-but-unowned;
	 * the UI presents that as unknown and never starts a destructive retry.
	 */
	private recoverCompletedProvisioning(): void {
		const orphaned = this.features.filter(
			(feature) =>
				feature.provisioning?.state === "provisioning" &&
				!this.activeProvisioningIds.has(feature.id),
		);
		if (orphaned.length === 0) return;

		let registered: RegisteredWorktree[];
		try {
			registered = parseRegisteredWorktrees(
				String(
					execSync("git worktree list --porcelain", {
						cwd: this.repoRoot,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "pipe"],
					}),
				),
			);
		} catch {
			return;
		}

		let changed = false;
		for (const feature of orphaned) {
			const worktree = registered.find(
				(candidate) =>
					path.resolve(candidate.path) === path.resolve(feature.worktreePath),
			);
			if (
				!worktree?.headSha ||
				worktree.branchRef !== `refs/heads/${feature.branch}` ||
				worktree.detached ||
				worktree.bare ||
				worktree.prunable
			) {
				continue;
			}

			const progress = feature.provisioning;
			if (!progress) continue;
			progress.state = "ready";
			progress.currentStepId = undefined;
			progress.error = undefined;
			for (const step of progress.steps) {
				step.status = "completed";
				step.error = undefined;
			}
			changed = true;
		}
		if (changed) this.store.saveFeatures(this.features);
	}

	private provisionFeatureSync(id: string): void {
		const feature = this.features.find((candidate) => candidate.id === id);
		if (!feature?.provisioning) return;
		const baseBranch = this.getBaseBranch();
		feature.provisioning.steps[0].status = "running";
		this.saveAndNotify();
		feature.createdFromSha = String(
			execSync(`git rev-parse "${baseBranch}"`, {
				cwd: this.repoRoot,
				encoding: "utf-8",
			}),
		).trim();
		feature.provisioning.steps[0].status = "completed";
		feature.provisioning.steps[1].status = "running";
		this.saveAndNotify();
		const worktreeStep = feature.provisioning.steps[1];
		if (this.resolveBranch(feature.branch)) {
			// The branch already exists in git (e.g. created manually or by a
			// previously finished feature). Reuse it instead of failing, and
			// surface how far behind the base branch it has drifted.
			const behind = this.commitsBehind(feature.branch, baseBranch);
			feature.reusedExistingBranch = { behind };
			feature.createdFromSha = undefined;
			worktreeStep.label =
				behind > 0
					? `Reusing existing branch ${feature.branch} (${behind} commits behind ${baseBranch})`
					: `Reusing existing branch ${feature.branch}`;
			this.saveAndNotify();
			execSync(
				`git worktree add "${feature.worktreePath}" "${feature.branch}"`,
				{ cwd: this.repoRoot },
			);
		} else {
			execSync(
				`git worktree add "${feature.worktreePath}" -b "${feature.branch}" "${baseBranch}"`,
				{ cwd: this.repoRoot },
			);
		}
		feature.provisioning.state = "ready";
		feature.provisioning.currentStepId = undefined;
		for (const step of feature.provisioning.steps) step.status = "completed";
		this.saveAndNotify();
	}

	private saveAndNotify(): void {
		this.store.saveFeatures(this.features);
		this.onChangeCallback?.();
	}

	/**
	 * Evaluate whether a feature can be removed without losing work. Returns
	 * the combined reasons across the feature worktree. Safe to call before
	 * any destructive step.
	 */
	getDeletionSafety(feature: Feature) {
		const branches = this.reconcileFeatureBranches(feature);
		const checkedOutBranch =
			branches.checkout.status === "known"
				? branches.checkout.ref
				: undefined;
		return checkWorktreeDeletionSafety({
			repoRoot: this.repoRoot,
			worktreeBase: this.worktreeBase,
			worktreePath: feature.worktreePath,
			branch: checkedOutBranch,
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
		const result = this.removeFeatureWorktreeForFinish(id, options);
		if (!result.deleted) return result;
		this.forgetFinishedFeature(id);
		return result;
	}

	/** Remove the Feature worktree while preserving every Agent Space record. */
	removeFeatureWorktreeForFinish(
		id: string,
		options?: { force?: boolean; acceptedPullRequestHeadSha?: string },
	): FeatureDeleteResult {
		const feature = this.features.find((f) => f.id === id);
		if (!feature) return { deleted: false, reasons: [] };

		const force = options?.force === true;
		const safety = this.getDeletionSafety(feature);
		const acceptedPullRequestIntegration =
			typeof options?.acceptedPullRequestHeadSha === "string" &&
			safety.forceable &&
			!safety.dirty &&
			typeof safety.featureSha === "string" &&
			safety.featureSha.toLowerCase() ===
				options.acceptedPullRequestHeadSha.toLowerCase();

		if (force && !safety.forceable) {
			return {
				deleted: false,
				reasons: [
					...safety.reasons,
					"Force is unavailable because deletion safety could not be fully observed.",
				],
			};
		}
		if (!force && !safety.safe && !acceptedPullRequestIntegration) {
			const staleEvidence = options?.acceptedPullRequestHeadSha
				? [
						"The pull request evidence no longer matches the current Feature head or working tree.",
					]
				: [];
			throw new Error(
				`Cannot delete feature "${feature.name}":\n\n${[...safety.reasons, ...staleEvidence].join("\n")}`,
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
				// Worktree may already be gone — but if it is still on disk,
				// the removal actually failed. Do NOT drop the feature record:
				// it would silently orphan the worktree (invisible residue).
				if (fs.existsSync(feature.worktreePath)) {
					return {
						deleted: false,
						reasons: [
							...safety.reasons,
							`Git refused to remove worktree: ${feature.worktreePath}`,
						],
					};
				}
			}
		} else {
			return {
				deleted: false,
				reasons: [
					...safety.reasons,
					`Refusing to remove worktree outside base: ${feature.worktreePath}`,
				],
			};
		}

		return {
			deleted: true,
			reasons: acceptedPullRequestIntegration ? [] : safety.reasons,
		};
	}

	/** Remove an explicitly reviewed directory that Git no longer registers. */
	removeWorktreeResidue(worktreePath: string): FeatureDeleteResult {
		if (!isWorktreePathSafe(worktreePath, this.worktreeBase)) {
			return {
				deleted: false,
				reasons: [`Refusing to remove worktree outside base: ${worktreePath}`],
			};
		}
		let inventory: string;
		try {
			inventory = String(
				execSync("git worktree list --porcelain", {
					cwd: this.repoRoot,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
		} catch {
			return { deleted: false, reasons: ["Git worktree inventory is unavailable."] };
		}
		const registered = inventory
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => path.resolve(line.slice("worktree ".length)));
		if (registered.includes(path.resolve(worktreePath))) {
			return { deleted: false, reasons: ["The path is registered by Git again."] };
		}
		try {
			fs.rmSync(worktreePath, { recursive: true, force: false });
		} catch (error) {
			return {
				deleted: false,
				reasons: [error instanceof Error ? error.message : String(error)],
			};
		}
		return fs.existsSync(worktreePath)
			? { deleted: false, reasons: ["The residue still exists on disk."] }
			: { deleted: true, reasons: [] };
	}

	/** Forget metadata only after every worktree removal has been verified. */
	forgetFinishedFeature(id: string): void {
		if (!this.features.some((feature) => feature.id === id)) return;
		this.store.deleteFeatureData(id);
		this.features = this.features.filter((f) => f.id !== id);
		this.store.saveFeatures(this.features);
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

	private pickColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash * 31 + name.charCodeAt(i)) | 0;
		}
		return TERMINAL_COLOR_KEYS[Math.abs(hash) % TERMINAL_COLOR_KEYS.length];
	}
}

function isCommitSha(value: string): boolean {
	return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
}

/** Restrictive by design: an unusual ref remains unlinked until explicit UI. */
function isSafeBranchName(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.includes("..");
}

function branchMatchesFeatureName(
	branch: string,
	featureName: string,
): boolean {
	const leaf = branch.slice(branch.lastIndexOf("/") + 1);
	return (
		normalizeFeatureName(leaf).toLowerCase() ===
		normalizeFeatureName(featureName).toLowerCase()
	);
}
