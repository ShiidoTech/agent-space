import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Agent,
	CompanionState,
	Feature,
	FeatureAgents,
	FeatureReviewInbox,
	FeatureServices,
	Service,
} from "../types";

export class Store {
	private readonly baseDir: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	loadFeatures(): Feature[] {
		const filePath = path.join(this.baseDir, "features.json");
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const state: CompanionState = JSON.parse(raw);
			return state.features;
		} catch {
			return [];
		}
	}

	saveFeatures(features: Feature[]): void {
		this.ensureDir(this.baseDir);
		const filePath = path.join(this.baseDir, "features.json");
		const state: CompanionState = { features };
		this.atomicWriteSync(filePath, JSON.stringify(state, null, "\t"));
	}

	loadAgents(featureId: string): Agent[] {
		const filePath = path.join(
			this.baseDir,
			"features",
			featureId,
			"agents.json",
		);
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data: FeatureAgents = JSON.parse(raw);
			return data.agents;
		} catch {
			return [];
		}
	}

	saveAgents(featureId: string, agents: Agent[]): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "agents.json");
		const data: FeatureAgents = { agents };
		this.atomicWriteSync(filePath, JSON.stringify(data, null, "\t"));
	}

	/**
	 * Review-inbox receipts (issue #120 PR2 review round 2, blocker 2) live
	 * in their own file, never in `agents.json`: a write here can never be
	 * structural (add/remove an agent), so cross-window sync can always
	 * treat it as a live patch. See {@link Agent.pendingReviewId}.
	 */
	loadReviewInbox(featureId: string): Record<string, string> {
		const filePath = path.join(
			this.baseDir,
			"features",
			featureId,
			"review-inbox.json",
		);
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data: FeatureReviewInbox = JSON.parse(raw);
			return data.pending ?? {};
		} catch {
			return {};
		}
	}

	saveReviewInbox(featureId: string, pending: Record<string, string>): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "review-inbox.json");
		const data: FeatureReviewInbox = { pending };
		this.atomicWriteSync(filePath, JSON.stringify(data, null, "\t"));
	}

	loadServices(featureId: string): Service[] {
		const filePath = path.join(
			this.baseDir,
			"features",
			featureId,
			"services.json",
		);
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data: FeatureServices = JSON.parse(raw);
			return data.services;
		} catch {
			return [];
		}
	}

	saveServices(featureId: string, services: Service[]): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "services.json");
		const data: FeatureServices = { services };
		this.atomicWriteSync(filePath, JSON.stringify(data, null, "\t"));
	}

	deleteFeatureData(featureId: string): void {
		const dir = path.join(this.baseDir, "features", featureId);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Ignore if already gone
		}
	}

	private atomicWriteSync(filePath: string, data: string): void {
		const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
		fs.writeFileSync(tmpPath, data, "utf-8");
		fs.renameSync(tmpPath, filePath);
	}

	private ensureDir(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}
}
