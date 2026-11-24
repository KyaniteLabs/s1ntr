/**
 * sandboxFrame - run generated sketch code in a sandboxed iframe (#1533).
 *
 * Generated p5 / Tone / Three / Hydra code must never run in the host realm.
 * The GeneratedCodeGuard is a pre-check (a denylist can be bypassed), the
 * iframe is the boundary:
 *
 *  - sandbox="allow-scripts" only: no allow-same-origin, so the frame gets an
 *    opaque origin and cannot reach the parent's DOM, cookies or storage;
 *    no allow-forms/popups/top-navigation either.
 *  - srcdoc carries a CSP meta with default-src 'none': no network, no
 *    nested frames, no workers. Only inline script/style and data:/blob:
 *    media are allowed, so a vendored library must be inlined, never linked.
 *  - the host only sees what the frame posts back (a small, typed state
 *    object). Messages are accepted only from this frame's own window.
 */

import { readVendorAsset } from '../../utils/vendorAssets.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

export const SANDBOX_ATTRIBUTE = 'allow-scripts';

export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:";

export const SANDBOX_MESSAGE_TAG = 's1ntr-sandbox-state';
export const SANDBOX_ERROR_TAG = 's1ntr-sandbox-error';

export interface SandboxFrameOptions {
  /** Vendored library sources, inlined in order before the sketch. */
  libs: string[];
  /** Adapter bootstrap plus the generated code, as one script body. */
  script: string;
  width: number;
  height: number;
  transparent?: boolean;
  /** Short label for the iframe title (accessibility). */
  title: string;
  /** Give up waiting for the first report after this long (ms). Default 10000; 0 disables. */
  settleTimeoutMs?: number;
}

export const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

export interface SandboxFrame {
  iframe: HTMLIFrameElement;
  /** Latest values the frame reported (numbers, strings, booleans, plain data). */
  readonly state: Record<string, unknown>;
  /** True once the frame has reported its first state (the sketch ran a frame). */
  readonly ready: boolean;
  /** First uncaught error the sketch raised inside the frame, if any. */
  readonly error: string | null;
  /**
   * Call with the frame's outcome: ready first (true), or errored / stayed
   * silent past the settle timeout first (false). The first outcome is final;
   * a callback registered later is called at once with it.
   */
  whenSettled(cb: (ok: boolean) => void): void;
  destroy(): void;
}

/** Vendored source for a library: fetched in the browser, read from disk in Node. */
export async function loadSandboxLib(urlPath: string): Promise<string> {
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    try {
      const res = await fetch(urlPath);
      if (res.ok) return await res.text();
    } catch {
      // No network origin to resolve against (tests, Node): read the vendored file.
    }
  }
  return readVendorAsset(urlPath);
}

function attrEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The document the frame loads. Exported so tests can inspect it. */
export function buildSandboxSrcdoc(opts: SandboxFrameOptions): string {
  const bg = opts.transparent ? 'transparent' : '#000';
  // Libraries and the sketch are separate scripts so a syntax error in the
  // sketch cannot stop the library from defining its globals.
  const libs = opts.libs.map((src) => `<script>${scriptSafe(src)}</script>`).join('\n');
  const bridge = `
window.__s1ntrReport = function (state) {
  try { parent.postMessage({ tag: ${JSON.stringify(SANDBOX_MESSAGE_TAG)}, state: state }, '*'); } catch (_e) {}
};
function __s1ntrFail(m) {
  try { parent.postMessage({ tag: ${JSON.stringify(SANDBOX_ERROR_TAG)}, message: String(m).slice(0, 500) }, '*'); } catch (_e) {}
}
window.addEventListener('error', function (e) { __s1ntrFail(e && e.message ? e.message : 'error'); });
window.addEventListener('unhandledrejection', function (e) { __s1ntrFail(e && e.reason && e.reason.message ? e.reason.message : 'unhandled rejection'); });`;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attrEscape(SANDBOX_CSP)}">`,
    `<title>${attrEscape(opts.title)}</title>`,
    `<style>html,body{margin:0;padding:0;overflow:hidden;background:${bg}}canvas{display:block}</style>`,
    '</head><body>',
    `<script>${scriptSafe(bridge + COMMAND_LISTENER)}</script>`,
    libs,
    `<script>${scriptSafe(opts.script)}</script>`,
    '</body></html>',
  ].join('\n');
}

/** Mount a sandboxed frame in `container`. */
export function mountSandboxFrame(container: HTMLElement, opts: SandboxFrameOptions): SandboxFrame {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX_ATTRIBUTE);
  iframe.setAttribute('title', opts.title);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.width = String(opts.width);
  iframe.height = String(opts.height);
  iframe.srcdoc = buildSandboxSrcdoc(opts);

  const state: Record<string, unknown> = {};
  let ready = false;
  let error: string | null = null;
  const waiters: Array<(ok: boolean) => void> = [];
  let outcome: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = (ok: boolean): void => {
    if (outcome !== null) return;
    outcome = ok;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    for (const cb of waiters.splice(0)) cb(ok);
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as { tag?: unknown; state?: unknown; message?: unknown } | null;
    if (!data) return;
    if (data.tag === SANDBOX_ERROR_TAG) {
      if (error === null) {
        error = typeof data.message === 'string' ? data.message : 'error';
        settle(false);
      }
      return;
    }
    if (data.tag !== SANDBOX_MESSAGE_TAG) return;
    if (data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
      const incoming = data.state as Record<string, unknown>;
      for (const [k, v] of Object.entries(incoming)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        state[k] = v;
      }
      if (!ready) {
        ready = true;
        settle(error === null);
      }
    }
  };
  window.addEventListener('message', onMessage);
  container.appendChild(iframe);

  const timeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      if (outcome !== null) return;
      if (error === null) error = `sandbox frame reported nothing within ${timeoutMs} ms`;
      settle(false);
    }, timeoutMs);
  }

  return {
    iframe,
    state,
    get ready() { return ready; },
    get error() { return error; },
    whenSettled(cb: (ok: boolean) => void): void {
      if (outcome !== null) cb(outcome);
      else waiters.push(cb);
    },
    destroy(): void {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      window.removeEventListener('message', onMessage);
      settle(false);
      iframe.remove();
    },
  };
}

/** What an adapter's render() returns: the frame (null when blocked) and its mirrored state. */
export interface SandboxedInstance {
  iframe: HTMLIFrameElement | null;
  readonly state: Record<string, unknown>;
  /** True once the frame reported its first state. */
  readonly ready: boolean;
  /** First uncaught error the sketch raised inside the frame. */
  readonly error: string | null;
  /** Fires once when the frame first reports (true) or first errors (false). */
  whenSettled(cb: (ok: boolean) => void): void;
  /** Violations that stopped the code from being mounted at all. */
  blocked: string[];
  /** Send a command to the frame (frames listen with `__s1ntrOnCommand`). */
  send(command: string): void;
  destroy(): void;
}

/**
 * Cross-layer imports as a script prelude. Only plain data crosses into the
 * frame (numbers, strings, booleans); anything else is dropped.
 */
export function importsPrelude(imports: Record<string, unknown> | undefined): string {
  if (!imports) return '';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(imports)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`var __import_${key} = ${Number.isFinite(value as number) || typeof value === 'boolean' ? String(value) : 'null'};`);
    } else if (typeof value === 'string') {
      lines.push(`var __import_${key} = ${JSON.stringify(value).replace(/</g, '\\u003c')};`);
    }
  }
  return lines.join('\n');
}

/** In-frame command listener used by Tone's start/stop buttons. */
export const COMMAND_LISTENER = `
window.addEventListener('message', function (e) {
  if (e.source === parent && e.data && typeof e.data.cmd === 'string' && typeof window.__s1ntrOnCommand === 'function') {
    window.__s1ntrOnCommand(e.data.cmd);
  }
});`;

/**
 * Pre-check, then mount. `violations` come from GeneratedCodeGuard plus the
 * adapter's own pattern list; when any exist the code is never mounted.
 */
export function mountGuardedFrame(
  container: HTMLElement,
  violations: string[],
  opts: SandboxFrameOptions,
): SandboxedInstance {
  if (violations.length > 0) {
    return { iframe: null, state: {}, ready: false, error: null, whenSettled(cb) { cb(false); }, blocked: violations, send() {}, destroy() {} };
  }
  const frame = mountSandboxFrame(container, opts);
  return {
    iframe: frame.iframe,
    state: frame.state,
    get ready() { return frame.ready; },
    get error() { return frame.error; },
    whenSettled: (cb) => frame.whenSettled(cb),
    blocked: [],
    send(command: string): void {
      frame.iframe.contentWindow?.postMessage({ cmd: command }, '*');
    },
    destroy: () => frame.destroy(),
  };
}
