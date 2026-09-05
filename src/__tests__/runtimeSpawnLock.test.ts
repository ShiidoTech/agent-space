import { describe, expect, it } from "vitest";
import { withRuntimeSpawnLock } from "../agents/runtimeOwnership";

describe("withRuntimeSpawnLock timeout (audit P1-5)", () => {
	it("does not wait forever for a pendu spawn", async () => {
		const key = `audit-spawn-${Date.now()}-${Math.random()}`;
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const first = withRuntimeSpawnLock(key, () => gate.then(() => "first"));
		// Let the first spawn occupy the key.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const startedAt = Date.now();
		const second = await withRuntimeSpawnLock(key, async () => "second", 50);
		expect(second).toBe("second");
		expect(Date.now() - startedAt).toBeLessThan(5_000);

		openGate();
		await expect(first).resolves.toBe("first");
	});

	it("serializes spawns on the same key in order", async () => {
		const key = `audit-order-${Date.now()}-${Math.random()}`;
		const order: string[] = [];
		await Promise.all([
			withRuntimeSpawnLock(key, async () => {
				order.push("first");
			}),
			withRuntimeSpawnLock(key, async () => {
				order.push("second");
			}),
		]);
		expect(order).toEqual(["first", "second"]);
	});
});
