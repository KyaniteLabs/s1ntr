/**
 * Bounded, session-scoped store for "Run in preview" code (Sol F19).
 * Keyed by session + version so two sessions that both submit version 1 never overwrite each other,
 * capped by entry count and total bytes with deterministic oldest-first eviction.
 * Callers that send no session share the '' scope (the legacy single-session behaviour).
 */
export const PREVIEW_MAX_ENTRIES = 64;
export const PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

export function normaliseSession(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

export class PreviewStore {
  constructor({ maxEntries = PREVIEW_MAX_ENTRIES, maxBytes = PREVIEW_MAX_BYTES } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map(); // insertion order = age; re-set moves to newest
    this.bytes = 0;
  }
  key(session, version) { return `${normaliseSession(session)}\u0000${version}`; }
  set(session, version, code) {
    const k = this.key(session, version);
    const size = Buffer.byteLength(code, 'utf8');
    if (size > this.maxBytes) return false; // a single entry larger than the whole budget is refused, not stored
    const old = this.entries.get(k);
    if (old !== undefined) { this.bytes -= Buffer.byteLength(old, 'utf8'); this.entries.delete(k); }
    this.entries.set(k, code);
    this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= Buffer.byteLength(this.entries.get(oldest), 'utf8');
      this.entries.delete(oldest);
    }
    return true;
  }
  get(session, version) { return this.entries.get(this.key(session, version)); }
  get size() { return this.entries.size; }
}
