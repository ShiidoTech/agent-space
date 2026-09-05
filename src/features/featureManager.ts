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
	suggestedCommand?: string;
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

	/**
	 * Zero-I/O twin of {@link getBaseFeature}: never runs Git. Uses the
	 * configured `baseBranch` or whatever `getBaseBranch()` has already
	 * cached from a prior call — never a fresh `git rev-parse` — and falls
	 * back to the explicit "(unknown base)" placeholder otherwise. For
	 * render/navigation paths (P0 zero-I/O UI mandate) that only need the
	 * base card's identity, not an up-to-the-moment detected branch.
	 */
	getBaseFeatureCached(projectId: string): Feature {
		const branch =
			this.cachedBaseBranch ||
			this.config.baseBranch?.trim() ||
			"(unknown base)";
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
						timeout: 5_000,
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
							timeout: 5_000,
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
					timeout: 5_000,
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
	private reusedBranchRelation(
		branch: string,
		baseBranch: string,
	): import("../types").ReusedBranchRelation {
		try {
			return parseReusedBranchRelation(
				this.git(
					`git rev-list --left-right --count "${branch}...${baseBranch}"`,
					this.repoRoot,
				),
			);
		} catch (error) {
			return {
				status: "unknown",
				reason: error instanceof Error ? error.message : String(error),
			};
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

	/**
	 * Features whose persisted metadata still exists but whose worktree
	 * directory has disappeared from disk. Cheap filesystem check only — no
	 * Git subprocess. Used by the FeatureStateCoordinator shallow lane and
	 * the cleanup command.
	 */
	getOrphanedFeatures(): Feature[] {
		return this.features.filter(
			(f) =>
				!fs.existsSync(f.worktreePath) &&
				f.provisioning?.state !== "provisioning",
		);
	}

	getFeature(id: string): Feature | undefined {
		const feature = this.features.find((f) => f.id === id);
		if (feature) this.reconcileFeatureBranches(feature);
		return feature;
	}

	/**
	 * Zero-I/O twin of {@link getFeature}: the in-memory record only, no
	 * branch-link reconciliation (no synchronous `git symbolic-ref`/`git
	 * rev-parse`). For render/navigation paths that only need identity
	 * (id, name, branch) — not up-to-the-moment checkout/link state.
	 */
	getFeatureCached(id: string): Feature | undefined {
		return this.features.find((f) => f.id === id);
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
		let relation: import("../types").ReusedBranchRelation | undefined;
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
			try {
				const relationResult = await execFileAsync(
					"git",
					[
						"rev-list",
						"--left-right",
						"--count",
						`${expectedBranch}...${baseBranch}`,
					],
					{ cwd: this.repoRoot, encoding: "utf8" },
				);
				relation = parseReusedBranchRelation(String(relationResult.stdout));
			} catch (error) {
				relation = {
					status: "unknown",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
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
			worktreeStep.label = reusedBranchLabel(
				expectedBranch,
				baseBranch,
				relation,
			);
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
			completed.reusedExistingBranch = {
				relation: relation ?? {
					status: "unknown",
					reason: "relation_not_observed",
				},
			};
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
			const relation = this.reusedBranchRelation(feature.branch, baseBranch);
			feature.reusedExistingBranch = { relation };
			feature.createdFromSha = undefined;
			worktreeStep.label = reusedBranchLabel(
				feature.branch,
				baseBranch,
				relation,
			);
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

	private async runGit(
		argv: readonly string[],
		cwd: string,
	): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number | null;
		error?: Error;
	}> {
		try {
			const { stdout, stderr } = await execFileAsync("git", [...argv], {
				cwd,
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			});
			return { stdout, stderr, exitCode: 0 };
		} catch (cause) {
			const error = cause as Error & {
				code?: number | string;
				stdout?: string;
				stderr?: string;
			};
			return {
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
				exitCode: typeof error.code === "number" ? error.code : null,
				error,
			};
		}
	}

	/**
	 * Evaluate whether a feature can be removed without losing work. Returns
	 * the combined reasons across the feature worktree. Safe to call before
	 * any destructive step.
	 */
	async getDeletionSafety(feature: Feature) {
		const branches = await this.reconcileFeatureBranchesAsync(feature);
		const checkedOutBranch = await this.resolveDeletionBranch(
			feature,
			branches,
		);
		return checkWorktreeDeletionSafety({
			repoRoot: this.repoRoot,
			worktreeBase: this.worktreeBase,
			worktreePath: feature.worktreePath,
			branch: checkedOutBranch,
			baseBranch: this.getBaseBranch(),
		});
	}

	/** Async-only branch reconciliation for the finish/delete critical path. */
	private async reconcileFeatureBranchesAsync(
		feature: Feature,
	): Promise<FeatureBranchState> {
		const checkout = await this.observeFeatureCheckoutAsync(feature);
		let changed = false;
		const hadLinks = Array.isArray(feature.branchLinks);

		if (!hadLinks) {
			const recovered = await this.recoverLegacyPrimaryAsync(feature, checkout);
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
			(await this.isProvedContinuationAsync(feature, checkout.ref, links))
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

	private async observeFeatureCheckoutAsync(
		feature: Feature,
	): Promise<FeatureBranchCheckoutObservation> {
		const symbolic = await this.runGit(
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			feature.worktreePath,
		);
		const branch = symbolic.stdout.trim();
		if (symbolic.exitCode === 0 && !symbolic.error && branch) {
			const link = feature.branchLinks?.find(
				(candidate) => candidate.ref === branch,
			);
			return {
				status: "known",
				ref: branch,
				linked: Boolean(link),
				...(link ? { role: link.role } : {}),
			};
		}
		const head = await this.runGit(
			["rev-parse", "--verify", "HEAD^{commit}"],
			feature.worktreePath,
		);
		const headSha = head.stdout.trim();
		if (head.exitCode === 0 && isCommitSha(headSha)) {
			return { status: "detached", headSha };
		}
		return {
			status: "unknown",
			reason:
				symbolic.error?.message ?? "The worktree branch could not be observed.",
		};
	}

	private async recoverLegacyPrimaryAsync(
		feature: Feature,
		checkout: FeatureBranchCheckoutObservation,
	): Promise<{ primary: string; continuation: string } | undefined> {
		if (checkout.status !== "known" || checkout.ref !== feature.branch)
			return undefined;
		const transition = await this.recentCheckoutIntoAsync(
			feature,
			checkout.ref,
		);
		if (
			!transition ||
			!branchMatchesFeatureName(transition.from, feature.name) ||
			branchMatchesFeatureName(checkout.ref, feature.name)
		)
			return undefined;
		const previousSha = await this.resolveBranchAsync(transition.from);
		const currentSha = await this.resolveBranchAsync(checkout.ref);
		const previousUpstreamSha = await this.resolveUpstreamAsync(
			transition.from,
		);
		if (
			!previousSha ||
			!currentSha ||
			previousUpstreamSha !== previousSha ||
			!(await this.isAncestorAsync(previousSha, currentSha))
		)
			return undefined;
		return { primary: transition.from, continuation: checkout.ref };
	}

	private async isProvedContinuationAsync(
		feature: Feature,
		checkoutRef: string,
		links: readonly FeatureBranchLink[],
	): Promise<boolean> {
		const transition = await this.recentCheckoutIntoAsync(feature, checkoutRef);
		if (!transition || !links.some((link) => link.ref === transition.from))
			return false;
		const primary =
			feature.primaryBranchRef ??
			links.find((link) => link.role === "primary")?.ref;
		if (!primary) return false;
		const primarySha = await this.resolveBranchAsync(primary);
		const checkoutSha = await this.resolveBranchAsync(checkoutRef);
		return Boolean(
			primarySha &&
				checkoutSha &&
				(await this.isAncestorAsync(primarySha, checkoutSha)),
		);
	}

	private async recentCheckoutIntoAsync(
		feature: Feature,
		toRef: string,
	): Promise<{ from: string; to: string } | undefined> {
		const observed = await this.runGit(
			["reflog", "--format=%gs", "-n", "25", "HEAD"],
			feature.worktreePath,
		);
		if (observed.exitCode !== 0 || observed.error) return undefined;
		for (const message of observed.stdout.split(/\r?\n/u)) {
			const match = /^checkout: moving from (.+) to (.+)$/u.exec(
				message.trim(),
			);
			if (
				!match ||
				match[2] !== toRef ||
				!isSafeBranchName(match[1]) ||
				!isSafeBranchName(match[2])
			)
				continue;
			return { from: match[1], to: match[2] };
		}
		return undefined;
	}

	private async resolveBranchAsync(
		branch: string,
	): Promise<string | undefined> {
		if (!isSafeBranchName(branch)) return undefined;
		const observed = await this.runGit(
			["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
			this.repoRoot,
		);
		const sha = observed.stdout.trim();
		return observed.exitCode === 0 && isCommitSha(sha)
			? sha.toLowerCase()
			: undefined;
	}

	private async resolveUpstreamAsync(
		branch: string,
	): Promise<string | undefined> {
		if (!isSafeBranchName(branch)) return undefined;
		const observed = await this.runGit(
			["rev-parse", "--verify", `${branch}@{upstream}^{commit}`],
			this.repoRoot,
		);
		const sha = observed.stdout.trim();
		return observed.exitCode === 0 && isCommitSha(sha)
			? sha.toLowerCase()
			: undefined;
	}

	private async isAncestorAsync(
		ancestorSha: string,
		descendantSha: string,
	): Promise<boolean> {
		const observed = await this.runGit(
			["merge-base", "--is-ancestor", ancestorSha, descendantSha],
			this.repoRoot,
		);
		return observed.exitCode === 0 && !observed.error;
	}

	/**
	 * Resolve the branch used for deletion safety without trusting stale
	 * metadata. A detached or temporarily unobservable checkout may still be
	 * safe to assess when its HEAD exactly matches one persisted Feature ref.
	 */
	private async resolveDeletionBranch(
		feature: Feature,
		branches: FeatureBranchState,
	): Promise<string | undefined> {
		if (branches.checkout.status === "known") return branches.checkout.ref;

		let headSha: string | undefined;
		if (branches.checkout.status === "detached") {
			headSha = branches.checkout.headSha;
		} else {
			const observed = await this.runGit(
				["rev-parse", "--verify", "HEAD^{commit}"],
				feature.worktreePath,
			);
			if (observed.exitCode === 0) headSha = observed.stdout.trim();
		}
		if (!headSha || !/^[0-9a-f]{40,64}$/iu.test(headSha)) return undefined;

		const candidates = new Set<string>([
			feature.branch,
			branches.primary,
			...(feature.branchLinks ?? []).map((link) => link.ref),
		]);
		const matches: string[] = [];
		for (const candidate of candidates) {
			const resolved = await this.runGit(
				["rev-parse", "--verify", `${candidate}^{commit}`],
				this.repoRoot,
			);
			if (
				resolved.exitCode === 0 &&
				resolved.stdout.trim().toLowerCase() === headSha.toLowerCase()
			) {
				matches.push(candidate);
			}
		}
		if (matches.includes(feature.branch)) return feature.branch;
		return matches.length === 1 ? matches[0] : undefined;
	}

	/**
	 * Fail-closed deletion. Refuses (throws with reasons) unless explicitly
	 * forced. A forced path is only ever chosen by a human after the checklist
	 * has been shown; the nominal path never uses `--force`.
	 */
	async deleteFeature(
		id: string,
		options?: { force?: boolean },
	): Promise<FeatureDeleteResult> {
		const result = await this.removeFeatureWorktreeForFinish(id, options);
		if (!result.deleted) return result;
		this.forgetFinishedFeature(id);
		return result;
	}

	/** Remove the Feature worktree while preserving every Agent Space record. */
	async removeFeatureWorktreeForFinish(
		id: string,
		options?: { force?: boolean; acceptedPullRequestHeadSha?: string },
	): Promise<FeatureDeleteResult> {
		const feature = this.features.find((f) => f.id === id);
		if (!feature) return { deleted: false, reasons: [] };

		const force = options?.force === true;
		const safety = await this.getDeletionSafety(feature);
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
				const removal = await this.runGit(
					[
						"worktree",
						"remove",
						feature.worktreePath,
						...(force ? ["--force"] : []),
					],
					this.repoRoot,
				);
				if (removal.exitCode !== 0 || removal.error) {
					throw new Error(
						removal.stderr.trim() || "git worktree remove failed",
					);
				}
			} catch {
				// Idempotent: if the directory is already gone from disk, git
				// worktree remove failure is expected — fall through to
				// forgetFinishedFeature(). If it is still on disk, the removal
				// actually failed: do NOT drop the feature record (invisible
				// residue).
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
	async removeWorktreeResidue(
		worktreePath: string,
	): Promise<FeatureDeleteResult> {
		if (!isWorktreePathSafe(worktreePath, this.worktreeBase)) {
			return {
				deleted: false,
				reasons: [`Refusing to remove worktree outside base: ${worktreePath}`],
			};
		}
		let inventory: string;
		try {
			const observed = await this.runGit(
				["worktree", "list", "--porcelain"],
				this.repoRoot,
			);
			if (observed.exitCode !== 0 || observed.error) {
				throw new Error(observed.stderr.trim() || "git worktree list failed");
			}
			inventory = observed.stdout;
		} catch {
			return {
				deleted: false,
				reasons: ["Git worktree inventory is unavailable."],
			};
		}
		const registered = inventory
			.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => path.resolve(line.slice("worktree ".length)));
		if (registered.includes(path.resolve(worktreePath))) {
			return {
				deleted: false,
				reasons: ["The path is registered by Git again."],
			};
		}
		try {
			await fs.promises.rm(worktreePath, { recursive: true, force: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === "EACCES" || code === "EPERM") {
				const foreign = await hasForeignOwnedEntries(worktreePath);
				return {
					deleted: false,
					reasons: [
						foreign
							? `${message}. The residue contains files owned by another user (e.g. written by a containerized tool); the current user cannot delete them.`
							: `${message}. The residue cannot be removed with the current permissions.`,
					],
					suggestedCommand: `sudo rm -rf '${worktreePath.replace(/'/gu, `'\\''`)}'`,
				};
			}
			return { deleted: false, reasons: [message] };
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

async function hasForeignOwnedEntries(target: string): Promise<boolean> {
	const uid = typeof process.getuid === "function" ? process.getuid() : -1;
	try {
		const stack = [target];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			const stat = await fs.promises.lstat(current);
			if (stat.uid !== uid) return true;
			if (stat.isDirectory()) {
				for (const entry of await fs.promises.readdir(current)) {
					stack.push(path.join(current, entry));
				}
			}
		}
	} catch {
		return true;
	}
	return false;
}

function parseReusedBranchRelation(
	stdout: string,
): import("../types").ReusedBranchRelation {
	const counts = stdout.trim().split(/\s+/u);
	if (counts.length !== 2) {
		return { status: "unknown", reason: "invalid_relation_counts" };
	}
	const [aheadText, behindText] = counts;
	const ahead = Number(aheadText);
	const behind = Number(behindText);
	const normalizedAhead = ahead;
	if (
		!Number.isSafeInteger(normalizedAhead) ||
		normalizedAhead < 0 ||
		!Number.isSafeInteger(behind) ||
		behind < 0
	) {
		return { status: "unknown", reason: "invalid_relation_counts" };
	}
	if (normalizedAhead === 0 && behind === 0)
		return { status: "current", ahead: 0, behind: 0 };
	if (normalizedAhead === 0) return { status: "behind", ahead: 0, behind };
	if (behind === 0)
		return { status: "ahead", ahead: normalizedAhead, behind: 0 };
	return { status: "diverged", ahead: normalizedAhead, behind };
}

function reusedBranchLabel(
	branch: string,
	base: string,
	relation: import("../types").ReusedBranchRelation | undefined,
): string {
	if (!relation || relation.status === "unknown") {
		return `Reusing existing branch ${branch} (Git relation unknown)`;
	}
	if (relation.status === "current") return `Reusing existing branch ${branch}`;
	return `Reusing existing branch ${branch} (${formatRelation(relation)} ${base})`;
}

function formatRelation(
	relation: Exclude<
		import("../types").ReusedBranchRelation,
		{ status: "current" } | { status: "unknown" }
	>,
): string {
	if (relation.status === "behind") return `${relation.behind} commits behind`;
	if (relation.status === "ahead") return `${relation.ahead} commits ahead`;
	return `${relation.ahead} commits ahead, ${relation.behind} behind`;
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
