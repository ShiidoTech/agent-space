/**
 * Lightweight per-project rollup for the Home portfolio view. Built purely
 * from cheap, already-known state (persisted feature count, live agent/
 * service counts, and whatever Feature snapshots are already cached) — it
 * never triggers a new Git/GitHub observation.
 */
export interface ProjectSummary {
	readonly projectId: string;
	readonly projectName: string;
	readonly featureCount: number;
	/** Non-base features whose lifecycle status is still `active`. */
	readonly activeFeatureCount: number;
	/** Non-base features marked `done` in the persisted lifecycle record. */
	readonly doneFeatureCount: number;
	readonly agentsActive: number;
	readonly servicesActive: number;
	readonly attentionCount: number;
	/** Oldest `observedAt` among this project's cached snapshots, if any. */
	readonly lastObservedAt: string | undefined;
}
