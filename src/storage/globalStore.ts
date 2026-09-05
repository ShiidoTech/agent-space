import * as fs from "node:fs";
import * as path from "node:path";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import type { Project } from "../types";
import {
	hasCorruptBackup,
	listTmpOrphans,
	quarantineCorruptFile,
} from "./storageHealth";

const LEGACY_EXTENSION_STORAGE_IDS = ["paql4711.agent-space"];

/**
 * When the fork moves to its own VS Code publisher, VS Code also moves the
 * extension's global storage to a new directory. Preserve the existing Agent
 * Space state by copying the legacy storage once, but never overwrite data
 * already written by the new extension identity.
 */
export function migrateLegacyExtensionStorage(
	baseDir: string,
	legacyStorageIds = LEGACY_EXTENSION_STORAGE_IDS,
): string | null {
	try {
		if (directoryHasEntries(baseDir)) return null;

		const storageRoot = path.dirname(baseDir);
		for (const legacyStorageId of legacyStorageIds) {
			const legacyDir = path.join(storageRoot, legacyStorageId);
			if (!directoryHasEntries(legacyDir)) continue;

			try {
				fs.mkdirSync(baseDir, { recursive: true });
			} catch (error) {
				agentSpaceDiagnostic(
					`legacy migration skipped: cannot create ${baseDir}: ${error instanceof Error ? error.message : "unknown error"}`,
				);
				return null;
			}
			try {
				for (const entry of fs.readdirSync(legacyDir)) {
					try {
						fs.cpSync(path.join(legacyDir, entry), path.join(baseDir, entry), {
							recursive: true,
							errorOnExist: true,
							force: false,
						});
					} catch (error) {
						agentSpaceDiagnostic(
							`legacy migration skipped entry ${entry}: ${error instanceof Error ? error.message : "unknown error"}`,
						);
					}
				}
			} catch (error) {
				agentSpaceDiagnostic(
					`legacy migration aborted: ${error instanceof Error ? error.message : "unknown error"}`,
				);
				return null;
			}
			return legacyDir;
		}

		return null;
	} catch (error) {
		agentSpaceDiagnostic(
			`legacy migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
		return null;
	}
}

function directoryHasEntries(dir: string): boolean {
	try {
		return fs.readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

export class GlobalStore {
	private readonly baseDir: string;
	private readonly projectsPath: string;
	private readonly preferencesPath: string;
	private readonly corrupted = new Set<string>();

	constructor(baseDir: string, options: { migrateLegacy?: boolean } = {}) {
		this.baseDir = baseDir;
		if (options.migrateLegacy !== false) {
			try {
				migrateLegacyExtensionStorage(baseDir);
			} catch (error) {
				agentSpaceDiagnostic(
					`legacy migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
				);
			}
		}
		this.projectsPath = path.join(baseDir, "projects.json");
		this.preferencesPath = path.join(baseDir, "preferences.json");
	}

	corruptedFiles(): string[] {
		return [...this.corrupted];
	}

	hasCorruption(): boolean {
		return this.corrupted.size > 0;
	}

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

	getProjects(): Project[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.projectsPath, "utf-8");
		} catch {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("bad shape");
			return parsed as Project[];
		} catch {
			this.noteCorruption(this.projectsPath, raw);
			return [];
		}
	}

	saveProjects(projects: Project[]): void {
		this.ensureDir(this.baseDir);
		this.guardedWrite(this.projectsPath, JSON.stringify(projects, null, "\t"));
	}

	getPreference<T>(key: string): T | undefined;
	getPreference<T>(key: string, defaultValue: T): T;
	getPreference<T>(key: string, defaultValue?: T): T | undefined {
		const prefs = this.loadPreferences();
		const value = prefs[key];
		return value !== undefined ? (value as T) : defaultValue;
	}

	setPreference(key: string, value: unknown): void {
		const prefs = this.loadPreferences();
		prefs[key] = value;
		this.ensureDir(this.baseDir);
		this.guardedWrite(this.preferencesPath, JSON.stringify(prefs, null, "\t"));
	}

	hasProjectsFile(): boolean {
		return fs.existsSync(this.projectsPath);
	}

	private loadPreferences(): Record<string, unknown> {
		let raw: string;
		try {
			raw = fs.readFileSync(this.preferencesPath, "utf-8");
		} catch {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("bad shape");
			return parsed as Record<string, unknown>;
		} catch {
			this.noteCorruption(this.preferencesPath, raw);
			return {};
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
				// fsync best-effort only.
			}
			fs.renameSync(tmpPath, filePath);
		} catch (error) {
			try {
				if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
			} catch {
				// Orphan reported via tmpOrphans().
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
