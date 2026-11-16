/**
 * Flash measurement from the frames the screen actually shows.
 *
 * WCAG 2.3.1 "general flash": a flash is a pair of opposing changes in
 * relative luminance of at least 0.1, where the darker state is below 0.8.
 * More than three flashes in any one-second period fails. The area rule
 * (a flash must cover about a tenth of the screen) is measured with windows
 * a third of the viewport on each side, stepped by a quarter window, plus the
 * whole viewport. A flash much smaller than a window is diluted below the
 * 0.1 threshold, as WCAG intends; one a window in size covers at least
 * (7/8)^2 of some window wherever it sits.
 *
 * The frames come from the compositor (CDP Page.startScreencast), so CSS
 * opacity, filters, DOM overlays and every kind of canvas count exactly as a
 * viewer sees them.
 */
import type { Page } from 'puppeteer';
import { decodeImagePixels, type DecodedImagePixels } from '../render/DecodedImageVisibility.js';

/** Relative luminance (0..1) of each region of one drawn frame. */
export interface LuminanceFrame {
  /** Compositor time of the frame in ms, or its arrival time when a frame has none. */
  t: number;
  /** Windows in row order, then the whole viewport. */
  regions: number[];
}

export interface LuminanceCapture {
  frames: LuminanceFrame[];
  /** Why the capture failed, e.g. the screencast could not start. */
  error: string | null;
  /** Errors the page threw while recording. */
  pageErrors?: string[];
}

export interface FlashMeasurement {
  frames: number;
  spanMs: number;
  /**
   * Most flashes any one region shows inside any one-second window, as
   * transitions / 2. Seven transitions are 3.5 flashes: more than three.
   */
  maxFlashesPerSecond: number;
}

export const FLASH_DELTA = 0.1;
export const FLASH_DARK_LIMIT = 0.8;
export const MAX_SAFE_FLASHES_PER_SECOND = 3;
/** Fine cells per side of the frame. */
export const REGION_GRID = 12;
/** Fine cells per side of one measured window: a ninth of the viewport. */
export const REGION_WINDOW = 4;
/** Windows per frame; the whole viewport comes after them. */
export const WINDOW_COUNT = (REGION_GRID - REGION_WINDOW + 1) ** 2;
/** Largest size the compositor scales each frame down to (4:3, as the viewport). */
export const FRAME_SIZE = { width: 200, height: 150 };
/** Float slack, so a swing of exactly 0.1 counts. */
const EPSILON = 1e-9;
/**
 * Time slack in ms. CDP frame times are epoch seconds, and at that size a
 * double resolves about 2.4e-4 ms, so the slack must be larger than that.
 */
const EPSILON_MS = 1e-3;
const reaches = (a: number, b: number) => Math.abs(a - b) >= FLASH_DELTA - EPSILON;

/**
 * Times at which a region completes a counted luminance transition. The
 * sequence is reduced to its turning points with a 0.1 hysteresis, so a slow
 * ramp or small noise is not a flash, but a swing hidden behind a few noisy
 * frames still is.
 */
export function transitionTimes(samples: Array<{ t: number; value: number }>): number[] {
  const times: number[] = [];
  if (samples.length === 0) return times;
  let pivot = samples[0].value;
  let extreme = samples[0];
  let direction = 0;
  const leg = (from: number, to: { t: number; value: number }) => {
    if (reaches(to.value, from) && Math.min(from, to.value) < FLASH_DARK_LIMIT) {
      times.push(to.t);
    }
  };
  for (const sample of samples.slice(1)) {
    if (direction === 0) {
      if (reaches(sample.value, pivot)) {
        direction = Math.sign(sample.value - pivot);
        extreme = sample;
      }
      continue;
    }
    const further = direction > 0 ? sample.value > extreme.value : sample.value < extreme.value;
    if (further) {
      extreme = sample;
    } else if (reaches(extreme.value, sample.value)) {
      leg(pivot, extreme);
      pivot = extreme.value;
      extreme = sample;
      direction = -direction;
    }
  }
  if (direction !== 0) leg(pivot, extreme);
  return times;
}

function maxInAnySecond(times: number[]): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    // Two changes a full second apart are in different seconds, even when
    // float sums put them a hair under 1000 ms apart.
    while (times[end] - times[start] >= 1000 - EPSILON_MS) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export function measureFlashes(frames: LuminanceFrame[]): FlashMeasurement {
  const spanMs = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  const regionCount = frames[0]?.regions.length ?? 0;
  let maxFlashesPerSecond = 0;
  for (let region = 0; region < regionCount; region++) {
    const times = transitionTimes(frames.map((frame) => ({ t: frame.t, value: frame.regions[region] })));
    // A flash is a pair of opposing changes. Six transitions in a second are
    // three flashes (safe); a seventh starts a fourth, so 3.2 Hz fails.
    maxFlashesPerSecond = Math.max(maxFlashesPerSecond, maxInAnySecond(times) / 2);
  }
  return { frames: frames.length, spanMs, maxFlashesPerSecond };
}

export interface PhotosensitivityVerdict {
  pass: boolean;
  issue: string | null;
  measurement: FlashMeasurement | null;
}

/**
 * The photosensitivity verdict. A capture that failed or saw no frame is
 * "not measured" and fails: a check that saw nothing must not pass. So is a
 * calm capture of a page that threw, since a crashed sketch draws nothing
 * and its frames say nothing about the artwork. The screencast sends a frame
 * only when the screen changes, so a still page gives one frame and a slow
 * page gives few. Neither is a sampling gap.
 */
export function judgePhotosensitivity(capture: LuminanceCapture | null | undefined): PhotosensitivityVerdict {
  const frames = capture?.frames ?? [];
  if (capture?.error || frames.length === 0) {
    const why = capture?.error ?? 'no frame reached the screen';
    return { pass: false, issue: `Photosensitivity not measured: ${why}`, measurement: null };
  }
  const measurement = measureFlashes(frames);
  if (measurement.maxFlashesPerSecond > MAX_SAFE_FLASHES_PER_SECOND) {
    return {
      pass: false,
      issue: `Photosensitivity risk: ${measurement.maxFlashesPerSecond} flashes in one second (max safe: ${MAX_SAFE_FLASHES_PER_SECOND})`,
      measurement,
    };
  }
  const thrown = capture?.pageErrors?.[0];
  if (thrown) {
    return { pass: false, issue: `Photosensitivity not measured: the artwork threw: ${thrown}`, measurement };
  }
  return { pass: true, issue: null, measurement };
}

const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/**
 * Mean relative luminance of each window of a decoded RGBA frame, in row
 * order, then of the whole frame. Pixels are linearized before averaging.
 */
export function regionLuminance(frame: DecodedImagePixels, grid = REGION_GRID, span = REGION_WINDOW): number[] {
  const { width, height, data } = frame;
  // A frame narrower than the grid leaves cells empty, and an empty cell
  // would average to NaN, which no threshold reaches.
  if (width < grid || height < grid) {
    throw new Error(`frame is ${width}x${height}, smaller than the ${grid}x${grid} grid`);
  }
  const sums = new Array<number>(grid * grid).fill(0);
  const counts = new Array<number>(grid * grid).fill(0);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * grid) / height) * grid;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const cell = row + Math.floor((x * grid) / width);
      sums[cell] += 0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]];
      counts[cell]++;
    }
  }
  const regions: number[] = [];
  for (let wy = 0; wy + span <= grid; wy++) {
    for (let wx = 0; wx + span <= grid; wx++) {
      let sum = 0;
      let count = 0;
      for (let y = wy; y < wy + span; y++) {
        for (let x = wx; x < wx + span; x++) {
          sum += sums[y * grid + x];
          count += counts[y * grid + x];
        }
      }
      regions.push(sum / count);
    }
  }
  regions.push(sums.reduce((a, b) => a + b, 0) / (width * height));
  return regions;
}

type ScreencastFrame = { data: string; sessionId: number; metadata: { timestamp?: number } };

export interface LuminanceRecording {
  /** Stops recording and measures every frame the compositor sent. */
  stop(): Promise<LuminanceCapture>;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Starts recording what the compositor shows. Start it before the page loads,
 * so a flash in the first second counts.
 */
export async function startLuminanceCapture(page: Page): Promise<LuminanceRecording> {
  const shots: Array<{ seconds: number | undefined; arrived: number; data: string }> = [];
  let recording = true;
  let failure: string | null = null;
  let session: Awaited<ReturnType<Page['createCDPSession']>> | null = null;
  const pageErrors: string[] = [];
  const onPageError = (error: unknown) => { if (recording) pageErrors.push(reason(error)); };
  page.on('pageerror', onPageError);
  try {
    session = await page.createCDPSession();
    const live = session;
    live.on('Page.screencastFrame', (frame: ScreencastFrame) => {
      if (recording) shots.push({ seconds: frame.metadata.timestamp, arrived: performance.now(), data: frame.data });
      live.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await live.send('Page.startScreencast', { format: 'png', maxWidth: FRAME_SIZE.width, maxHeight: FRAME_SIZE.height, everyNthFrame: 1 });
  } catch (error) {
    failure = `screencast failed: ${reason(error)}`;
  }
  return {
    async stop() {
      recording = false;
      page.off('pageerror', onPageError);
      if (session && !failure) {
        await session.send('Page.stopScreencast').catch((error: unknown) => { failure = `screencast failed: ${reason(error)}`; });
      }
      await session?.detach().catch(() => undefined);
      if (failure) return { frames: [], error: failure };
      // Compositor times when every frame has one; arrival times otherwise.
      // Mixing the two clocks would invent gaps and overlaps.
      const compositor = shots.every((shot) => shot.seconds !== undefined);
      const frames: LuminanceFrame[] = [];
      for (const [index, shot] of shots.entries()) {
        try {
          const pixels = await decodeImagePixels(Buffer.from(shot.data, 'base64'));
          frames.push({ t: compositor ? shot.seconds! * 1000 : shot.arrived, regions: regionLuminance(pixels) });
        } catch (error) {
          return { frames: [], error: `screencast frame ${index + 1} of ${shots.length} could not be measured: ${reason(error)}` };
        }
      }
      return { frames, error: null, pageErrors };
    },
  };
}
