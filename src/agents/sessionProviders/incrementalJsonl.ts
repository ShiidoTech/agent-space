import * as fs from "node:fs";

const INITIAL_READ_BYTES = 64 * 1024;
const MAX_INCREMENT_BYTES = 256 * 1024;

export interface IncrementalJsonlState<T> {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	prefix: string;
	offset: number;
	remainder: string;
	value: T | undefined;
}

export function readFirstJsonlLine(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(4096);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const content = buffer.toString("utf-8", 0, bytesRead);
		const newline = content.indexOf("\n");
		return (newline >= 0 ? content.slice(0, newline) : content).trim();
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Read only the new/bounded tail of a JSONL file and retain the last value. */
export function readIncrementalJsonl<T>(
	filePath: string,
	state: IncrementalJsonlState<T> | undefined,
	parseLine: (line: string, previous: T | undefined) => T | undefined,
): IncrementalJsonlState<T> | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}

	if (
		state &&
		state.size === stat.size &&
		state.mtimeMs === stat.mtimeMs &&
		state.ctimeMs === stat.ctimeMs
	) {
		return state;
	}

	const prefix = readPrefix(filePath);
	const canAppend = Boolean(
		state &&
			stat.size >= state.offset &&
			stat.size > state.size &&
			state.prefix === prefix,
	);
	let offset = canAppend
		? (state?.offset ?? 0)
		: Math.max(0, stat.size - INITIAL_READ_BYTES);
	if (canAppend && stat.size - offset > MAX_INCREMENT_BYTES) {
		offset = Math.max(0, stat.size - MAX_INCREMENT_BYTES);
	}

	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const length = stat.size - offset;
		const buffer = Buffer.alloc(length);
		const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
		let content = buffer.toString("utf-8", 0, bytesRead);
		let value =
			canAppend && offset === state?.offset ? state?.value : undefined;
		if (offset > 0 && !canAppend) {
			const boundary = content.indexOf("\n");
			content = boundary >= 0 ? content.slice(boundary + 1) : "";
		}
		if (canAppend && state?.remainder) content = state.remainder + content;

		const lines = content.split("\n");
		let remainder = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				value = parseLine(line, value);
			} catch {
				// Ignore malformed or provider-incompatible rows.
			}
		}
		if (remainder.trim()) {
			try {
				value = parseLine(remainder, value);
				remainder = "";
			} catch {
				// Keep an incomplete final row for the next append.
			}
		}
		return {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			prefix,
			offset: stat.size,
			remainder,
			value,
		};
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readPrefix(filePath: string): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(128);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf-8", 0, bytesRead);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
