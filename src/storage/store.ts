import * as fs from "node:fs";
import * as path from "node:path";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import type {
	Agent,
	CompanionState,
	Feature,
	FeatureAgents,
	FeatureReviewInbox,
	FeatureServices,
	Service,
} from "../types";
import {
	hasCorruptBackup,
	listCorruptBackups,
	listTmpOrphans,
	quarantineCorruptFile,
} from "./storageHealth";

export class Store {
	private readonly baseDir: string;
	private readonly corrupted = new Set<string>();

	constructor(baseDir: string) {
		this.baseDir = baseDir;
	}

	/**
	 * Files detected as corrupt: the in-memory set (this session) plus the
	 * on-disk `.corrupt-*.bak` backups (durable across restarts and valid
	 * saves — deleting the backup is the acknowledgement).
	 */
	corruptedFiles(): string[] {
		return [
			...new Set([...this.corrupted, ...listCorruptBackups(this.baseDir)]),
		];
	}

	hasCorruption(): boolean {
		return this.corruptedFiles().length > 0;
	}

	/** Stale `*.tmp.*` files left by an interrupted atomic write. */
	tmpOrphans(): string[] {
		return listTmpOrphans(this.baseDir);
	}

	private noteCorruption(filePath: string, raw: string | null): void {
		const backup = quarantineCorruptFile(filePath, raw);
		this.corrupted.add(filePath);
		agentSpaceDiagnostic(
			`corrupt store file quarantined: ${filePath}${backup ? ` -> ${backup}` : ""}`,
		);
	}

	private guardedWrite(filePath: string, data: string): void {
		if (this.corrupted.has(filePath) && !hasCorruptBackup(filePath)) {
			quarantineCorruptFile(filePath);
		}
		this.atomicWriteSync(filePath, data);
		this.corrupted.delete(filePath);
	}

	loadFeatures(): Feature[] {
		const filePath = path.join(this.baseDir, "features.json");
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			return [];
		}
		try {
			const state: CompanionState = JSON.parse(raw);
			if (!state || !Array.isArray(state.features))
				throw new Error("bad shape");
			return state.features;
		} catch {
			this.noteCorruption(filePath, raw);
			return [];
		}
	}

	saveFeatures(features: Feature[]): void {
		this.ensureDir(this.baseDir);
		const filePath = path.join(this.baseDir, "features.json");
		const state: CompanionState = { features };
		this.guardedWrite(filePath, JSON.stringify(state, null, "\t"));
	}

	loadAgents(featureId: string): Agent[] {
		const filePath = path.join(
			this.baseDir,
			"features",
			featureId,
			"agents.json",
		);
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			return [];
		}
		try {
			const data: FeatureAgents = JSON.parse(raw);
			if (!data || !Array.isArray(data.agents)) throw new Error("bad shape");
			return data.agents;
		} catch {
			this.noteCorruption(filePath, raw);
			return [];
		}
	}

	saveAgents(featureId: string, agents: Agent[]): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "agents.json");
		const data: FeatureAgents = { agents };
		this.guardedWrite(filePath, JSON.stringify(data, null, "\t"));
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
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			return {};
		}
		try {
			const data: FeatureReviewInbox = JSON.parse(raw);
			if (!data || typeof data.pending !== "object" || data.pending === null)
				throw new Error("bad shape");
			return data.pending ?? {};
		} catch {
			this.noteCorruption(filePath, raw);
			return {};
		}
	}

	saveReviewInbox(featureId: string, pending: Record<string, string>): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "review-inbox.json");
		const data: FeatureReviewInbox = { pending };
		this.guardedWrite(filePath, JSON.stringify(data, null, "\t"));
	}

	loadServices(featureId: string): Service[] {
		const filePath = path.join(
			this.baseDir,
			"features",
			featureId,
			"services.json",
		);
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			return [];
		}
		try {
			const data: FeatureServices = JSON.parse(raw);
			if (!data || !Array.isArray(data.services)) throw new Error("bad shape");
			return data.services;
		} catch {
			this.noteCorruption(filePath, raw);
			return [];
		}
	}

	saveServices(featureId: string, services: Service[]): void {
		const dir = path.join(this.baseDir, "features", featureId);
		this.ensureDir(dir);
		const filePath = path.join(dir, "services.json");
		const data: FeatureServices = { services };
		this.guardedWrite(filePath, JSON.stringify(data, null, "\t"));
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
		try {
			fs.writeFileSync(tmpPath, data, "utf-8");
			try {
				const fd = fs.openSync(tmpPath, "r");
				try {
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				// fsync is best-effort (e.g. non-POSIX FS); the rename below still applies.
			}
			fs.renameSync(tmpPath, filePath);
		} catch (error) {
			try {
				if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
			} catch {
				// Ignore cleanup failures; the orphan is reported via tmpOrphans().
			}
			throw error;
		}
	}

	private ensureDir(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}
}
