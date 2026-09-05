import * as fs from "node:fs";
import * as path from "node:path";
import { agentSpaceDiagnostic } from "../diagnostics/agentSpaceDiagnostics";
import type { Project } from "../types";
import {
	hasCorruptBackup,
	listCorruptBackups,
	listTmpOrphans,
	quarantineCorruptFile,
} from "./storageHealth";

const LEGACY_EXTENSION_STORAGE_IDS = ["paql4711.agent-space"];

/**
 * When the fork moves to its own VS Code publisher, VS Code also moves the
 * extension's global storage to a new directory. Preserve the existing Agent
 * Space state by copying the legacy storage once, but never overwrite data
 * already written by the new extension identity.
 *
 * All-or-nothing (review blocker P0-2): entries are copied into a staging
 * directory first and published to `baseDir` only when every entry copied
 * successfully. A partial failure leaves `baseDir` without entries, so the
 * next startup retries the full migration instead of freezing a partial
 * copy as the definitive state.
 */
export function migrateLegacyExtensionStorage(
	baseDir: string,
	legacyStorageIds = LEGACY_EXTENSION_STORAGE_IDS,
): string | null {
	try {
		if (directoryHasEntries(baseDir)) return null;

		const storageRoot = path.dirname(baseDir);
		cleanStaleMigrationStaging(storageRoot, path.basename(baseDir));
		for (const legacyStorageId of legacyStorageIds) {
			const legacyDir = path.join(storageRoot, legacyStorageId);
			let entries: string[];
			try {
				entries = fs.readdirSync(legacyDir);
			} catch {
				continue;
			}
			if (entries.length === 0) continue;

			const stagingDir = `${baseDir}.migration-${process.pid}-${Date.now()}`;
			try {
				fs.mkdirSync(stagingDir, { recursive: true });
				for (const entry of entries) {
					fs.cpSync(path.join(legacyDir, entry), path.join(stagingDir, entry), {
						recursive: true,
						errorOnExist: true,
						force: false,
					});
				}
				// Publish only after the full copy succeeded. baseDir is
				// still entry-free here, so a failure below keeps the retry
				// path open instead of short-circuiting it.
				fs.mkdirSync(baseDir, { recursive: true });
				for (const entry of entries) {
					fs.cpSync(path.join(stagingDir, entry), path.join(baseDir, entry), {
						recursive: true,
						errorOnExist: true,
						force: false,
					});
				}
			} catch (error) {
				agentSpaceDiagnostic(
					`legacy migration aborted, nothing published: ${error instanceof Error ? error.message : "unknown error"}`,
				);
				return null;
			} finally {
				try {
					fs.rmSync(stagingDir, { recursive: true, force: true });
				} catch {
					// A leftover staging dir never blocks a retry: the next
					// run cleans stale staging dirs and only checks baseDir.
				}
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

function migrationStagingPrefix(baseName: string): string {
	return `${baseName}.migration-`;
}

function cleanStaleMigrationStaging(
	storageRoot: string,
	baseName: string,
): void {
	try {
		const prefix = migrationStagingPrefix(baseName);
		for (const entry of fs.readdirSync(storageRoot)) {
			if (!entry.startsWith(prefix)) continue;
			try {
				fs.rmSync(path.join(storageRoot, entry), {
					recursive: true,
					force: true,
				});
			} catch {
				// Best-effort only; leftovers never block a retry.
			}
		}
	} catch {
		// Storage root unreadable: migration will no-op below.
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
		return [
			...new Set([...this.corrupted, ...listCorruptBackups(this.baseDir)]),
		];
	}

	hasCorruption(): boolean {
		return this.corruptedFiles().length > 0;
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
