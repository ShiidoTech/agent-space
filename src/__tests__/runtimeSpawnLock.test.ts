import { describe, expect, it } from "vitest";
import {
	SpawnLockTimeoutError,
	withRuntimeSpawnLock,
	withRuntimeSpawnLockSync,
} from "../agents/runtimeOwnership";

describe("withRuntimeSpawnLock timeout (audit P1-5, fail-closed)", () => {
	it("refuses the new spawn instead of double-spawning", async () => {
		const key = `audit-spawn-${Date.now()}-${Math.random()}`;
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const first = withRuntimeSpawnLock(key, () => gate.then(() => "first"));
		// Let the first spawn occupy the key.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const startedAt = Date.now();
		await expect(
			withRuntimeSpawnLock(key, async () => "second", 50),
		).rejects.toBeInstanceOf(SpawnLockTimeoutError);
		expect(Date.now() - startedAt).toBeLessThan(5_000);

		// The key still belongs to the first spawn: a retry also refuses.
		await expect(
			withRuntimeSpawnLock(key, async () => "third", 50),
		).rejects.toBeInstanceOf(SpawnLockTimeoutError);

		// Once the first spawn settles, the key is free again.
		openGate();
		await expect(first).resolves.toBe("first");
		await expect(
			withRuntimeSpawnLock(key, async () => "fourth", 50),
		).resolves.toBe("fourth");
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

	it("never pins the key for the sync path after refusal + settlement", async () => {
		// Guards the timeout/settlement race: if previous settles between
		// our timeout and the hand-back, handing it back unconditionally
		// would leave a dead promise in the map, and the sync path (plain
		// has(), no settle check) would refuse until an unrelated async
		// call cleans it. Either interleaving must leave the key free.
		const key = `audit-stale-${Date.now()}-${Math.random()}`;
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const first = withRuntimeSpawnLock(key, () => gate.then(() => "first"));
		await new Promise((resolve) => setTimeout(resolve, 10));

		await expect(
			withRuntimeSpawnLock(key, async () => "second", 20),
		).rejects.toBeInstanceOf(SpawnLockTimeoutError);

		openGate();
		await expect(first).resolves.toBe("first");

		expect(withRuntimeSpawnLockSync(key, () => "sync")).toBe("sync");
		await expect(
			withRuntimeSpawnLock(key, async () => "third", 20),
		).resolves.toBe("third");
	});
});
