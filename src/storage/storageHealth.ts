import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Quarantine helpers for Agent Space JSON persistence (audit P0-1).
 *
 * Corruption must never become silent data loss: when a known store file
 * exists but cannot be parsed/validated, the raw bytes are preserved next
 * to the original (`<file>.corrupt-<timestamp>.bak`) before the caller
 * falls back to an empty state. A later `save` therefore never overwrites
 * the only copy of user data without a backup on disk.
 */

export function quarantineCorruptFile(
	filePath: string,
	raw?: string | null,
): string | null {
	try {
		const content =
			raw ??
			(fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null);
		if (content === null) return null;
		const backupPath = `${filePath}.corrupt-${Date.now()}.bak`;
		fs.writeFileSync(backupPath, content, "utf-8");
		return backupPath;
	} catch {
		return null;
	}
}

export function hasCorruptBackup(filePath: string): boolean {
	try {
		const dir = path.dirname(filePath);
		const base = path.basename(filePath);
		if (!fs.existsSync(dir)) return false;
		return fs
			.readdirSync(dir)
			.some(
				(entry) =>
					entry.startsWith(`${base}.corrupt-`) && entry.endsWith(".bak"),
			);
	} catch {
		return false;
	}
}

/** Non-recursive + one-level `features/<id>` scan for `*.tmp.<pid>.*` orphans. */
export function listTmpOrphans(baseDir: string): string[] {
	const orphans: string[] = [];
	try {
		if (!fs.existsSync(baseDir)) return orphans;
		for (const entry of fs.readdirSync(baseDir)) {
			if (entry.includes(".tmp.")) orphans.push(path.join(baseDir, entry));
		}
		const featuresDir = path.join(baseDir, "features");
		if (!fs.existsSync(featuresDir)) return orphans;
		for (const featureId of fs.readdirSync(featuresDir)) {
			const dir = path.join(featuresDir, featureId);
			let entries: string[] = [];
			try {
				if (fs.statSync(dir).isDirectory()) entries = fs.readdirSync(dir);
			} catch {
				entries = [];
			}
			for (const entry of entries) {
				if (entry.includes(".tmp.")) orphans.push(path.join(dir, entry));
			}
		}
	} catch {
		return orphans;
	}
	return orphans;
}
