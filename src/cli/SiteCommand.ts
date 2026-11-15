/**
 * SiteCommand — CLI interface for the living website daemon.
 *
 * Usage:
 *   sinter site seed                    # Seed default starter slots
 *   sinter site seed --slots <n>        # Seed n starter slots
 *   sinter site evolve                  # Run daemon continuously
 *   sinter site evolve --once           # Run single cycle
 *   sinter site evolve --dry-run        # Generate but don't deploy
 *   sinter site evolve --slot home-hero # Target specific slot
 */

import {
	LivingSiteDaemon,
	DEFAULT_DAEMON_CONFIG,
} from "../daemon/LivingSiteDaemon.js";
import { SlotManager, type SiteSlot } from "../site/SlotManager.js";
import { PostHogClient } from "../analytics/PostHogClient.js";
import { Logger } from "../utils/Logger.js";
import { Domain } from "../types/domains.js";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SiteEvolveOptions {
	once?: boolean;
	dryRun?: boolean;
	slot?: string;
	interval?: number;
}

export interface SiteSeedOptions {
	/** Number of starter slots to create (default: 3) */
	count?: number;
	/** State directory override (default: ~/.sinter/site) */
	stateDir?: string;
}

const DEFAULT_STATE_DIR = join(homedir(), ".sinter", "site");

/**
 * Default starter slots for example.internal.
 * Each covers a distinct page section and creative domain mix.
 */
const STARTER_SLOTS: SiteSlot[] = [
	{
		id: "home-hero",
		page: "/",
		domains: [Domain.P5, Domain.THREE, Domain.GLSL],
		active: {
			htmlPath: "",
			experimentId: "sinter-home-hero-seed",
			fitness: 0,
			deployedAt: new Date(0).toISOString(),
			model: "seed",
			domain: Domain.P5,
		},
		challenger: null,
	},
	{
		id: "home-about",
		page: "/",
		domains: [Domain.P5, Domain.GLSL],
		active: {
			htmlPath: "",
			experimentId: "sinter-home-about-seed",
			fitness: 0,
			deployedAt: new Date(0).toISOString(),
			model: "seed",
			domain: Domain.P5,
		},
		challenger: null,
	},
	{
		id: "tools-hero",
		page: "/tools",
		domains: [Domain.THREE, Domain.GLSL, Domain.P5],
		active: {
			htmlPath: "",
			experimentId: "sinter-tools-hero-seed",
			fitness: 0,
			deployedAt: new Date(0).toISOString(),
			model: "seed",
			domain: Domain.THREE,
		},
		challenger: null,
	},
];

/**
 * Seed starter slots so `site evolve` has something to operate on.
 * Skips slots that already exist (idempotent).
 */
export async function runSiteSeed(options: SiteSeedOptions = {}): Promise<void> {
	const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
	const statePath = join(stateDir, "slots.json");
	const count = Math.max(1, Math.min(options.count ?? 3, STARTER_SLOTS.length));

	const slotManager = new SlotManager(statePath);
	await slotManager.load();

	const existing = slotManager.getAllSlots();
	const existingIds = new Set(existing.map((s) => s.id));

	let seeded = 0;
	for (const template of STARTER_SLOTS.slice(0, count)) {
		if (existingIds.has(template.id)) {
			Logger.info("SiteCommand", `Slot "${template.id}" already exists — skipping`);
			continue;
		}
		slotManager.setSlot(template);
		seeded++;
		Logger.info("SiteCommand", `Seeded slot "${template.id}" (${template.page}, domain: ${template.domains[0]})`);
	}

	if (seeded > 0) {
		await slotManager.save();
		Logger.info("SiteCommand", `Seeded ${seeded} slot(s) → ${statePath}`);
	} else {
		Logger.info("SiteCommand", `All ${count} requested slot(s) already exist — nothing to seed`);
	}
}

/**
 * Schedule a recurring async tick with a re-entrancy guard.
 *
 * If a tick is still running when the next interval fires, that tick is
 * SKIPPED rather than stacked — long cycles can no longer pile up overlapping
 * runs. Returns a `stop()` that clears the underlying interval (no leak).
 */
export function startSiteEvolveLoop(
	tick: () => Promise<void>,
	intervalMs: number,
): { stop: () => void } {
	let running = false;

	const timer = setInterval(() => {
		if (running) {
			Logger.info(
				"SiteCommand",
				"Previous cycle still running, skipping this tick",
			);
			return;
		}
		running = true;
		void tick().finally(() => {
			running = false;
		});
	}, intervalMs);

	return {
		stop: () => clearInterval(timer),
	};
}

export async function runSiteEvolve(
	options: SiteEvolveOptions = {},
): Promise<void> {
	const statePath = join(DEFAULT_STATE_DIR, "slots.json");
	const config = { ...DEFAULT_DAEMON_CONFIG };

	if (options.interval) {
		config.cycleIntervalMs = options.interval;
	}

	const slotManager = new SlotManager(statePath);
	const posthog = new PostHogClient();
	const daemon = new LivingSiteDaemon(slotManager, posthog, config);

	// Load existing slot state
	await slotManager.load();

	if (options.once) {
		Logger.info("SiteCommand", "Running single evolution cycle");
		await daemon.runCycle(options.dryRun);
		await posthog.shutdown();
		return;
	}

	// Continuous mode
	Logger.info(
		"SiteCommand",
		`Starting continuous evolution (interval: ${config.cycleIntervalMs}ms)`,
	);

	const run = async () => {
		try {
			await daemon.runCycle(options.dryRun);
		} catch (err) {
			Logger.error("SiteCommand", "Cycle failed:", err);
		}
	};

	// Run first cycle immediately
	await run();

	// Schedule subsequent cycles with a re-entrancy guard so a slow cycle
	// cannot stack overlapping ticks.
	const loop = startSiteEvolveLoop(run, config.cycleIntervalMs);

	// Graceful shutdown
	const shutdown = () => {
		Logger.info("SiteCommand", "Shutting down...");
		loop.stop();
		void posthog.shutdown().then(() => process.exit(0));
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
