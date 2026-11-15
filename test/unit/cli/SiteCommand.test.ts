/**
 * SiteCommand tests — re-entrancy guard, clear-on-stop, and slot seeding.
 *
 * The continuous evolution loop must NOT stack overlapping ticks when a cycle
 * runs longer than the interval, and stop() must clear the interval so the
 * timer does not leak.
 *
 * runSiteSeed must create the default starter slots and persist them to disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Suppress Logger noise.
vi.mock("../../../src/utils/Logger.js", () => ({
	Logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { startSiteEvolveLoop, runSiteSeed } from "../../../src/cli/SiteCommand.js";
import { SlotManager } from "../../../src/site/SlotManager.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = join(repoRoot, "bin", "sinter");

describe("startSiteEvolveLoop (E5)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A controllable tick: each call returns a promise we resolve manually. */
	function controllableTick() {
		const resolvers: Array<() => void> = [];
		let calls = 0;
		const tick = vi.fn(() => {
			calls++;
			return new Promise<void>((resolve) => {
				resolvers.push(resolve);
			});
		});
		return {
			tick,
			get calls() {
				return calls;
			},
			/** Resolve the oldest in-flight tick. */
			resolveOne() {
				const r = resolvers.shift();
				if (r) r();
			},
		};
	}

	it("skips an overlapping tick while the previous is still in flight", async () => {
		const ctrl = controllableTick();
		const loop = startSiteEvolveLoop(ctrl.tick, 1000);

		// First interval fires → tick #1 starts (still pending, never resolved).
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(1);

		// Second interval fires while #1 is still running → MUST be skipped.
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(1);

		// Third interval fires, still running → still skipped.
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(1);

		// Resolve the in-flight tick, then the next interval may start a new one.
		ctrl.resolveOne();
		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(2);

		loop.stop();
	});

	it("runs sequential ticks when each completes before the next interval", async () => {
		const ctrl = controllableTick();
		const loop = startSiteEvolveLoop(ctrl.tick, 1000);

		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(1);
		ctrl.resolveOne();

		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(2);
		ctrl.resolveOne();

		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(3);
		ctrl.resolveOne();

		loop.stop();
	});

	it("stop() clears the interval so no further ticks fire", async () => {
		const ctrl = controllableTick();
		const loop = startSiteEvolveLoop(ctrl.tick, 1000);

		await vi.advanceTimersByTimeAsync(1000);
		expect(ctrl.calls).toBe(1);
		ctrl.resolveOne();

		loop.stop();

		// Advance well past several intervals — no new ticks should fire.
		await vi.advanceTimersByTimeAsync(5000);
		expect(ctrl.calls).toBe(1);
	});

	it("stop() removes the timer from the active timer set", () => {
		const ctrl = controllableTick();
		const loop = startSiteEvolveLoop(ctrl.tick, 1000);

		// One pending interval timer is registered.
		expect(vi.getTimerCount()).toBe(1);

		loop.stop();

		// After stop() the interval is cleared — zero active timers.
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("runSiteSeed", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "sinter-seed-test-"));
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates 3 starter slots by default and persists to disk", async () => {
		await runSiteSeed({ stateDir: tmpDir });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();
		const slots = slotManager.getAllSlots();

		expect(slots).toHaveLength(3);
		expect(slots.map((s) => s.id)).toEqual(["home-hero", "home-about", "tools-hero"]);
	});

	it("each seeded slot has the correct page and at least one domain", async () => {
		await runSiteSeed({ stateDir: tmpDir });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();

		const hero = slotManager.getSlot("home-hero");
		expect(hero?.page).toBe("/");
		expect(hero?.domains.length).toBeGreaterThanOrEqual(1);

		const tools = slotManager.getSlot("tools-hero");
		expect(tools?.page).toBe("/tools");
		expect(tools?.domains.length).toBeGreaterThanOrEqual(1);
	});

	it("respects --count option to seed fewer slots", async () => {
		await runSiteSeed({ stateDir: tmpDir, count: 1 });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();
		const slots = slotManager.getAllSlots();

		expect(slots).toHaveLength(1);
		expect(slots[0].id).toBe("home-hero");
	});

	it("is idempotent — re-seeding does not duplicate slots", async () => {
		await runSiteSeed({ stateDir: tmpDir });
		await runSiteSeed({ stateDir: tmpDir });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();
		const slots = slotManager.getAllSlots();

		expect(slots).toHaveLength(3);
	});

	it("seeded slots start with no challenger (ready for evolve)", async () => {
		await runSiteSeed({ stateDir: tmpDir });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();

		for (const slot of slotManager.getAllSlots()) {
			expect(slot.challenger).toBeNull();
		}
	});

	it("needsChallenger returns true for all seeded slots", async () => {
		await runSiteSeed({ stateDir: tmpDir });

		const slotManager = new SlotManager(join(tmpDir, "slots.json"));
		await slotManager.load();

		for (const slot of slotManager.getAllSlots()) {
			expect(slotManager.needsChallenger(slot.id)).toBe(true);
		}
	});
});

describe("site seed CLI validation", () => {
	it("rejects a non-numeric --slots value before seeding", async () => {
		try {
			await execFileAsync(process.execPath, [binPath, "site", "seed", "--slots", "abc"], {
				cwd: repoRoot,
				env: {
					...process.env,
					NODE_ENV: "test",
					DOTENV_CONFIG_QUIET: "true",
				},
			});
			expect.fail("Expected command to fail");
		} catch (err: any) {
			expect(err.code).toBe(1);
			expect(err.stderr).toContain("Invalid value for --slots: expected a positive integer.");
		}
	});
});
