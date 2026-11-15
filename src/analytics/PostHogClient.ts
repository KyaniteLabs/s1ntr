/**
 * PostHogClient — server-side PostHog integration for Sinter.
 *
 * Wraps posthog-node to send custom events and query experiment results.
 * Gated on LIMINAL_POSTHOG_KEY env var — does nothing when absent.
 *
 * Uses the PostHog proxy at puenteworks.com/ph by default.
 */

import { PostHog } from "posthog-node";
import { Logger } from "../utils/Logger.js";
import type { EngagementMetrics } from "../evolution/EngagementFitness.js";

const ENV_KEY = "LIMINAL_POSTHOG_KEY";
const ENV_HOST = "LIMINAL_POSTHOG_HOST";
const ENV_PERSONAL_API_KEY = "LIMINAL_POSTHOG_PERSONAL_API_KEY";
const ENV_PROJECT_ID = "LIMINAL_POSTHOG_PROJECT_ID";
const ENV_API_HOST = "LIMINAL_POSTHOG_API_HOST";
const DEFAULT_HOST = "https://puenteworks.com/ph";
const DEFAULT_API_HOST = "https://app.posthog.com";

/**
 * Canonical PostHog event/property schema for living-site engagement.
 *
 * The browser injects events with these names/keys (see
 * LivingSiteDaemon.injectVariantEngagementTracking) and the HogQL readback
 * (buildVariantEngagementQuery) reads the same keys. Both sides MUST import
 * from here — a literal mismatch (e.g. emit `liminal_*`, query `sinter_*`)
 * produces a zero-row match and silently breaks the engagement sensorium.
 */
export const ENGAGEMENT_EVENTS = {
	view: "liminal_slot_view",
	interaction: "liminal_slot_interaction",
	bounce: "liminal_slot_bounce",
} as const;

export const ENGAGEMENT_PROPS = {
	slotId: "liminal_slot_id",
	page: "liminal_page",
	variantId: "liminal_variant_id",
	dwellSeconds: "liminal_dwell_seconds",
	scrollDepth: "liminal_scroll_depth",
} as const;

export interface PostHogEventProperties {
	[key: string]: string | number | boolean | null | undefined;
}

export interface VariantEngagementResult {
	variantId: string;
	visitors: number;
	metrics: EngagementMetrics;
}

export class PostHogClient {
	private client: PostHog | null = null;
	private readonly apiKey: string;
	private readonly host: string;
	private readonly personalApiKey: string;
	private readonly projectId: string;
	private readonly apiHost: string;

	constructor() {
		this.apiKey = process.env[ENV_KEY] ?? "";
		this.host = process.env[ENV_HOST] ?? DEFAULT_HOST;
		this.personalApiKey = process.env[ENV_PERSONAL_API_KEY] ?? "";
		this.projectId = process.env[ENV_PROJECT_ID] ?? "";
		this.apiHost = process.env[ENV_API_HOST] ?? DEFAULT_API_HOST;

		if (this.apiKey) {
			this.client = new PostHog(this.apiKey, {
				host: this.host,
			});
		}
	}

	/** Whether PostHog is configured (env var set) */
	isConfigured(): boolean {
		return this.client !== null;
	}

	/** Get the API key (for CSP injection) */
	getApiKey(): string {
		return this.apiKey;
	}

	/** Get the host URL (for CSP injection) */
	getHost(): string {
		return this.host;
	}

	/**
	 * Track a custom server-side event.
	 * No-op when not configured.
	 */
	trackEvent(event: string, properties?: PostHogEventProperties): void {
		if (!this.client) return;

		try {
			this.client.capture({
				distinctId: "sinter-daemon",
				event,
				properties: {
					source: "sinter-server",
					...properties,
				},
			});
		} catch (err) {
			Logger.warn("PostHogClient", "Failed to track event:", err);
		}
	}

	/**
	 * Fetch engagement metrics for a deployed variant.
	 *
	 * Runs a HogQL query against the configured project. Returns null when the
	 * personal API key / project ID are not configured, the request fails, no
	 * row comes back, or any cell is missing/non-numeric — malformed values
	 * are unknown, never an observed zero. The daemon treats null as "not
	 * enough data yet" rather than guessing.
	 */
	async getVariantEngagementMetrics(variantId: string): Promise<VariantEngagementResult | null> {
		if (!this.personalApiKey || !this.projectId) return null;

		try {
			const url = `${this.apiHost.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(this.projectId)}/query/`;
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.personalApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: {
						kind: "HogQLQuery",
						query: this.buildVariantEngagementQuery(),
						values: { variantId },
					},
				}),
			});

			if (!response.ok) {
				Logger.warn("PostHogClient", `Engagement query failed with status ${response.status}`);
				return null;
			}

			const payload = (await response.json()) as { results?: unknown[][] };
			const row = payload.results?.[0];
			if (!row) return null;

			const cells = [0, 1, 2, 3, 4].map((i) => this.toNumber(row[i]));
			if (cells.some((v) => v === null)) {
				Logger.warn("PostHogClient", `Engagement row for ${variantId} has missing or non-numeric values; treating as unavailable`);
				return null;
			}
			const [visitors, dwellRate, scrollDepth, interactionRate, retentionScore] = cells as number[];
			return {
				variantId,
				visitors,
				metrics: { dwellRate, scrollDepth, interactionRate, retentionScore },
			};
		} catch (err) {
			Logger.warn("PostHogClient", "Failed to fetch engagement metrics:", err);
			return null;
		}
	}

	/**
	 * HogQL query that reads back living-site engagement metrics. Keyed entirely
	 * off ENGAGEMENT_EVENTS / ENGAGEMENT_PROPS so it can never drift from the
	 * browser-side emit schema. Public so tests can assert emit/query parity.
	 */
	buildVariantEngagementQuery(): string {
		return `
SELECT
	uniq(distinct_id) AS visitors,
	avg(if(toFloat(properties.${ENGAGEMENT_PROPS.dwellSeconds}) >= 10, 1, 0)) AS dwell_rate,
	avg(least(greatest(toFloat(properties.${ENGAGEMENT_PROPS.scrollDepth}), 0), 1)) AS scroll_depth,
	avg(if(event = '${ENGAGEMENT_EVENTS.interaction}', 1, 0)) AS interaction_rate,
	avg(if(event = '${ENGAGEMENT_EVENTS.bounce}', 0, 1)) AS retention_score
FROM events
WHERE properties.${ENGAGEMENT_PROPS.variantId} = {variantId}
	AND event IN ('${ENGAGEMENT_EVENTS.view}', '${ENGAGEMENT_EVENTS.interaction}', '${ENGAGEMENT_EVENTS.bounce}')
`;
	}

	/** Strict numeric parse: null/undefined/blank/non-numeric are unknown (null), not 0. */
	private toNumber(value: unknown): number | null {
		if (typeof value === "number") return Number.isFinite(value) ? value : null;
		if (typeof value === "string" && value.trim() !== "") {
			const numberValue = Number(value);
			return Number.isFinite(numberValue) ? numberValue : null;
		}
		return null;
	}

	/**
	 * Shutdown the client, flushing any pending events.
	 */
	async shutdown(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.shutdown();
		} catch (err) {
			Logger.warn("PostHogClient", "Failed to shutdown:", err);
		}
	}
}
