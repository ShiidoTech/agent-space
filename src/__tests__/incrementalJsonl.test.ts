import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readIncrementalJsonl,
	readIncrementalJsonlAsync,
} from "../agents/sessionProviders/incrementalJsonl";

describe("readIncrementalJsonlAsync (parity with sync twin)", () => {
	const dirs: string[] = [];

	function tmpFile(lines: string[]): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incr-jsonl-"));
		dirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		fs.writeFileSync(filePath, lines.join("\n") + "\n");
		return filePath;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	const parseLast = (line: string): string => line;

	it("produces the exact same state as the sync reader on a fresh file", async () => {
		const filePath = tmpFile(["a", "b", "c"]);

		const syncState = readIncrementalJsonl(filePath, undefined, parseLast);
		const asyncState = await readIncrementalJsonlAsync(
			filePath,
			undefined,
			parseLast,
		);

		expect(asyncState).toEqual(syncState);
		expect(syncState?.value).toBe("c");
	});

	it("appends incrementally with identical results", async () => {
		const filePath = tmpFile(["one", "two"]);
		const syncState = readIncrementalJsonl(filePath, undefined, parseLast);
		const asyncState = await readIncrementalJsonlAsync(
			filePath,
			undefined,
			parseLast,
		);
		expect(syncState?.value).toBe("two");

		fs.appendFileSync(filePath, "three\nfour\n");

		const syncNext = readIncrementalJsonl(filePath, syncState, parseLast);
		const asyncNext = await readIncrementalJsonlAsync(
			filePath,
			asyncState,
			parseLast,
		);

		expect(asyncNext).toEqual(syncNext);
		expect(syncNext?.value).toBe("four");
		expect(asyncNext?.offset).toBe(fs.statSync(filePath).size);
	});

	it("returns the unchanged state untouched when the file has not grown", async () => {
		const filePath = tmpFile(["only"]);
		const state = readIncrementalJsonl(filePath, undefined, parseLast);

		const asyncSame = await readIncrementalJsonlAsync(
			filePath,
			state,
			parseLast,
		);

		expect(asyncSame).toBe(state);
	});
});
