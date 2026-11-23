/**
 * Project `live` settings (syncMode, oscHost) -> a validated sync contract that both live-music generators receive.
 * Sol F17: the CLI read these settings from a Result it never unwrapped and neither generator ever saw them.
 */
export const LIVE_SYNC_MODES = ['clock', 'midi', 'osc', 'free'] as const;
export type LiveSyncMode = typeof LIVE_SYNC_MODES[number];

export interface LiveSettings { readonly syncMode?: LiveSyncMode; readonly oscHost?: string }

const HOST = /^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/;

/** Accepts the raw `live` block of a project config; throws a plain error on a malformed value. */
export function parseLiveSettings(raw: unknown): LiveSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('project config "live" must be an object');
  const { syncMode, oscHost } = raw as Record<string, unknown>;
  const out: { syncMode?: LiveSyncMode; oscHost?: string } = {};
  if (syncMode !== undefined) {
    if (typeof syncMode !== 'string' || !(LIVE_SYNC_MODES as readonly string[]).includes(syncMode)) {
      throw new Error(`live.syncMode must be one of ${LIVE_SYNC_MODES.join(', ')}, got ${JSON.stringify(syncMode)}`);
    }
    out.syncMode = syncMode as LiveSyncMode;
  }
  if (oscHost !== undefined) {
    if (typeof oscHost !== 'string' || !HOST.test(oscHost)) throw new Error(`live.oscHost must be host or host:port, got ${JSON.stringify(oscHost)}`);
    out.oscHost = oscHost;
  }
  return out;
}

/** Reads the `live` block from a loadProjectConfig() Result (a missing project config is simply no settings). */
export function liveSettingsFromProjectConfig(result: { isOk(): boolean; value?: unknown }): LiveSettings {
  if (!result.isOk()) return {};
  return parseLiveSettings((result.value as { live?: unknown } | undefined)?.live);
}

/** The text appended to BOTH the music and the visuals prompt so the pair shares one timing contract. */
export function liveSyncContract(settings: LiveSettings): string {
  const lines: string[] = [];
  if (settings.syncMode) lines.push(`Sync mode: ${settings.syncMode}. Music and visuals must share this timing source${settings.syncMode === 'free' ? ' (no external clock; each runs free)' : ''}.`);
  if (settings.oscHost) lines.push(`OSC host: ${settings.oscHost}. Send and receive sync messages there.`);
  return lines.length ? `\n\nSYNC CONTRACT (from project config):\n${lines.join('\n')}` : '';
}

export function withLiveSync(prompt: string, settings: LiveSettings): string {
  return `${prompt}${liveSyncContract(settings)}`;
}
