/**
 * NimaService — TypeScript client for the NIMA aesthetic scoring service.
 *
 * Calls the local NIMA HTTP service (localhost:8765) to evaluate image beauty.
 * Used by Sinter's taste model (replaces qualityScore) and TasteCheck (aesthetic gate).
 *
 * The NIMA service must be running:
 *   python3 nima_service.py
 *
 * Usage:
 *   const nima = NimaService.getInstance();
 *   const score = await nima.score(screenshotBuffer);  // → 6.28
 *   if (!nima.isAvailable()) { // gracefully degrade }
 */

const NIMA_HOST = '127.0.0.1';
const NIMA_PORT = 8765;
const NIMA_BASE = `http://${NIMA_HOST}:${NIMA_PORT}`;
const HEALTH_TIMEOUT_MS = 2000;
const SCORE_TIMEOUT_MS = 10000;

export interface NimaResult {
  /** Aesthetic score 1.0–10.0 (from 250K AVA human ratings) */
  score: number;
  /** Probability distribution over 10 score bins */
  histogram?: number[];
}

export interface NimaBatchResult {
  scores: number[];
}

export class NimaService {
  private static instance: NimaService | null = null;
  private _available: boolean | null = null;
  private _lastHealthCheck = 0;

  static getInstance(): NimaService {
    if (!NimaService.instance) {
      NimaService.instance = new NimaService();
    }
    return NimaService.instance;
  }

  /**
   * Check if the NIMA service is running and responsive.
   * Caches result for 60 seconds.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this._available !== null && now - this._lastHealthCheck < 60_000) {
      return this._available;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const res = await fetch(`${NIMA_BASE}/health`, { signal: controller.signal });
      clearTimeout(timer);
      this._available = res.ok;
    } catch {
      this._available = false;
    }
    this._lastHealthCheck = now;
    return this._available;
  }

  /**
   * Score a single image.
   * @param image Raw image bytes (PNG, JPEG, etc.)
   * @returns Aesthetic score 1.0–10.0 or null if service unavailable
   */
  async score(image: Buffer | Uint8Array): Promise<NimaResult | null> {
    if (!(await this.isAvailable())) return null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS);
      const res = await fetch(`${NIMA_BASE}/score`, {
        method: 'POST',
        body: image instanceof Buffer ? image : Buffer.from(image),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const data = await res.json() as NimaResult;
      // A malformed or out-of-range score is a failure, not a quality value.
      if (!isValidNimaScore(data?.score)) return null;
      return { score: data.score, histogram: data.histogram };
    } catch {
      return null;
    }
  }

  /**
   * Score multiple images in a single request (batch).
   * @param images Array of raw image bytes
   * @returns Array of scores, or null if service unavailable
   */
  async scoreBatch(images: (Buffer | Uint8Array)[]): Promise<number[] | null> {
    if (!(await this.isAvailable()) || images.length === 0) return null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS * images.length);
      const res = await fetch(`${NIMA_BASE}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          images.map(img => img instanceof Buffer ? img.toString('base64') : Buffer.from(img).toString('base64'))
        ),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const data = await res.json() as NimaBatchResult;
      if (!Array.isArray(data?.scores) || data.scores.length !== images.length || !data.scores.every(isValidNimaScore)) {
        return null;
      }
      return data.scores;
    } catch {
      return null;
    }
  }
}

/** NIMA scores are on a 1.0–10.0 scale; anything else is a failed response. */
export function isValidNimaScore(score: unknown): score is number {
  return typeof score === 'number' && Number.isFinite(score) && score >= 1 && score <= 10;
}

/**
 * Convenience function for one-off scoring.
 */
export async function scoreImage(image: Buffer | Uint8Array): Promise<number | null> {
  const result = await NimaService.getInstance().score(image);
  return result?.score ?? null;
}
