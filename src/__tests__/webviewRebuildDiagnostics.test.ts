import { beforeEach, describe, expect, it } from "vitest";
import {
	getWebviewRebuildCounts,
	recordFullRebuild,
	resetWebviewRebuildCounts,
} from "../diagnostics/webviewRebuildDiagnostics";

describe("webviewRebuildDiagnostics", () => {
	beforeEach(() => {
		resetWebviewRebuildCounts();
	});

	it("starts at zero for every surface", () => {
		expect(getWebviewRebuildCounts()).toEqual({ sidebar: 0, home: 0 });
	});

	it("counts full rebuilds independently per surface", () => {
		recordFullRebuild("sidebar");
		recordFullRebuild("sidebar");
		recordFullRebuild("home");

		expect(getWebviewRebuildCounts()).toEqual({ sidebar: 2, home: 1 });
	});
});
