import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../types";

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
	if (directoryHasEntries(baseDir)) return null;

	const storageRoot = path.dirname(baseDir);
	for (const legacyStorageId of legacyStorageIds) {
		const legacyDir = path.join(storageRoot, legacyStorageId);
		if (!directoryHasEntries(legacyDir)) continue;

		fs.mkdirSync(baseDir, { recursive: true });
		for (const entry of fs.readdirSync(legacyDir)) {
			fs.cpSync(path.join(legacyDir, entry), path.join(baseDir, entry), {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
		}
		return legacyDir;
	}

	return null;
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

	constructor(baseDir: string, options: { migrateLegacy?: boolean } = {}) {
		this.baseDir = baseDir;
		if (options.migrateLegacy !== false) {
			migrateLegacyExtensionStorage(baseDir);
		}
		this.projectsPath = path.join(baseDir, "projects.json");
		this.preferencesPath = path.join(baseDir, "preferences.json");
	}

	getProjects(): Project[] {
		try {
			const raw = fs.readFileSync(this.projectsPath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	saveProjects(projects: Project[]): void {
		this.ensureDir(this.baseDir);
		this.atomicWriteSync(
			this.projectsPath,
			JSON.stringify(projects, null, "\t"),
		);
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
		this.atomicWriteSync(
			this.preferencesPath,
			JSON.stringify(prefs, null, "\t"),
		);
	}

	hasProjectsFile(): boolean {
		return fs.existsSync(this.projectsPath);
	}

	private loadPreferences(): Record<string, unknown> {
		try {
			const raw = fs.readFileSync(this.preferencesPath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
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
