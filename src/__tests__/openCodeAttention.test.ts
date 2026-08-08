import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { OpenCodeSessionProvider } from "../agents/sessionProviders/openCodeSessionProvider";

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	mockExecSync.mockReset();
});

function dbRow(message: Record<string, unknown>, gate?: Record<string, unknown>) {
	return JSON.stringify([
		{
			message_data: JSON.stringify(message),
			gate_data: gate ? JSON.stringify(gate) : null,
		},
	]);
}

describe("OpenCode attention evidence", () => {
	it("reports an unfinished assistant message as working", () => {
		mockExecSync.mockReturnValue(
			dbRow({
				role: "assistant",
				time: { created: 1000 },
			}),
		);

		const signal = new OpenCodeSessionProvider().readAttention("ses_working");

		expect(signal).toEqual({
			status: "working",
			reason: "OpenCode has an assistant turn in progress",
		});
	});

	it("reports a completed assistant message as idle", () => {
		mockExecSync.mockReturnValue(
			dbRow({
				role: "assistant",
				time: { created: 1000, completed: 2000 },
			}),
		);

		expect(new OpenCodeSessionProvider().readAttention("ses_idle")?.status).toBe(
			"idle",
		);
	});

	it("reports a live question tool as waiting_for_user", () => {
		mockExecSync.mockReturnValue(
			dbRow(
				{ role: "assistant", time: { created: 1000 } },
				{
					type: "tool",
					tool: "question",
					state: { status: "running" },
				},
			),
		);

		expect(
			new OpenCodeSessionProvider().readAttention("ses_question")?.status,
		).toBe("waiting_for_user");
	});

	it("reports an assistant message error as failed", () => {
		mockExecSync.mockReturnValue(
			dbRow({
				role: "assistant",
				time: { created: 1000 },
				error: { name: "APIError" },
			}),
		);

		expect(new OpenCodeSessionProvider().readAttention("ses_failed")?.status).toBe(
			"failed",
		);
	});

	it("queries only the exact safe session id", () => {
		mockExecSync.mockReturnValue(dbRow({ role: "user", time: { created: 1000 } }));
		const provider = new OpenCodeSessionProvider();
		provider.readAttention("ses_exact-1");

		expect(mockExecSync).toHaveBeenCalledWith(
			expect.stringContaining("session_id = 'ses_exact-1'"),
			expect.objectContaining({ timeout: 5000 }),
		);
		expect(provider.readAttention("bad'id")).toBeNull();
	});
});
