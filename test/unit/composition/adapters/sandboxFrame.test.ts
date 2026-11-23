/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_ATTRIBUTE,
  SANDBOX_CSP,
  buildSandboxSrcdoc,
  importsPrelude,
  mountGuardedFrame,
  mountSandboxFrame,
} from '../../../../src/composition/adapters/sandboxFrame.js';
import { attachedContainer, frameFails, frameReports } from './sandboxTestUtils.js';

const OPTS = { libs: ['var LIB = 1;'], script: 'var CODE = 2;', width: 320, height: 200, title: 'test layer' };

afterEach(() => { document.body.innerHTML = ''; });

describe('buildSandboxSrcdoc', () => {
  it('carries a CSP that denies everything by default', () => {
    const doc = buildSandboxSrcdoc(OPTS);
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/connect-src|frame-src|worker-src|https?:/);
  });

  it('inlines libraries before the sketch and never links a script', () => {
    const doc = buildSandboxSrcdoc(OPTS);
    expect(doc.indexOf('var LIB = 1;')).toBeGreaterThan(-1);
    expect(doc.indexOf('var LIB = 1;')).toBeLessThan(doc.indexOf('var CODE = 2;'));
    expect(doc).not.toMatch(/<script[^>]*\ssrc=/i);
  });

  it('keeps generated code from ending its own script tag', () => {
    const doc = buildSandboxSrcdoc({ ...OPTS, script: 'var s = "</script><img src=x onerror=alert(1)>";' });
    expect(doc).not.toContain('</script><img');
  });
});

describe('mountSandboxFrame', () => {
  it('uses sandbox="allow-scripts" and nothing that restores same-origin access', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    expect(SANDBOX_ATTRIBUTE).toBe('allow-scripts');
    expect(frame.iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.iframe.getAttribute('title')).toBe('test layer');
  });

  it('mirrors state from its own frame only', () => {
    const container = attachedContainer();
    const a = mountGuardedFrame(container, [], OPTS);
    const b = mountGuardedFrame(container, [], OPTS);
    frameReports(a, { mouseX: 5 });
    expect(a.state.mouseX).toBe(5);
    expect(b.state.mouseX).toBeUndefined();
  });

  it('ignores messages that are not from a frame it owns', () => {
    const frame = mountGuardedFrame(attachedContainer(), [], OPTS);
    window.dispatchEvent(new MessageEvent('message', { data: { tag: 's1ntr-sandbox-state', state: { hacked: 1 } }, source: window }));
    expect(frame.state.hacked).toBeUndefined();
  });

  it('removes the frame and stops listening on destroy', () => {
    const container = attachedContainer();
    const frame = mountGuardedFrame(container, [], OPTS);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    frame.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('mountGuardedFrame', () => {
  it('mounts nothing when the pre-check found violations', () => {
    const container = attachedContainer();
    const inst = mountGuardedFrame(container, ['fetch API'], OPTS);
    expect(inst.iframe).toBeNull();
    expect(inst.blocked).toEqual(['fetch API']);
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('importsPrelude', () => {
  it('passes plain data only', () => {
    const out = importsPrelude({ a: 1, b: 'x</script>', c: true, d: () => 1, e: { deep: 1 }, 'bad key': 2 });
    expect(out).toContain('var __import_a = 1;');
    expect(out).toContain('var __import_c = true;');
    expect(out).toContain('__import_b');
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('__import_d');
    expect(out).not.toContain('__import_e');
    expect(out).not.toContain('bad key');
  });
});

describe('frame error channel (#1533 review)', () => {
  it('reports an uncaught in-frame error and settles false before the first frame', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    const settled: boolean[] = [];
    frame.whenSettled((ok) => settled.push(ok));
    frameFails({ iframe: frame.iframe } as never, 'x is not defined');
    expect(frame.error).toBe('x is not defined');
    expect(frame.ready).toBe(false);
    expect(settled).toEqual([false]);
  });

  it('settles true on the first state report', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    const settled: boolean[] = [];
    frame.whenSettled((ok) => settled.push(ok));
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    expect(frame.ready).toBe(true);
    expect(settled).toEqual([true]);
  });

  it('ignores error messages from any other window', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    window.dispatchEvent(new MessageEvent('message', { data: { tag: 's1ntr-sandbox-error', message: 'spoof' }, source: window }));
    expect(frame.error).toBeNull();
  });

  it('wires window error and unhandledrejection to the host in the srcdoc', () => {
    const doc = buildSandboxSrcdoc(OPTS);
    expect(doc).toContain("addEventListener('error'");
    expect(doc).toContain("addEventListener('unhandledrejection'");
  });

  it('only obeys commands that come from the parent window', () => {
    expect(buildSandboxSrcdoc(OPTS)).toContain('e.source === parent');
  });
});

describe('whenSettled outcome is final (#1802 nits)', () => {
  const settle = (frame: ReturnType<typeof mountSandboxFrame>): boolean[] => {
    const seen: boolean[] = [];
    frame.whenSettled((ok) => seen.push(ok));
    return seen;
  };

  it('answers a late callback after ready then error with true', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    frameFails({ iframe: frame.iframe } as never, 'late boom');
    expect(settle(frame)).toEqual([true]);
  });

  it('answers a late callback after error then ready with false', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    frameFails({ iframe: frame.iframe } as never, 'boom');
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    expect(settle(frame)).toEqual([false]);
  });

  it('calls a waiter once even when both messages arrive', () => {
    const frame = mountSandboxFrame(attachedContainer(), OPTS);
    const seen = settle(frame);
    frameFails({ iframe: frame.iframe } as never, 'boom');
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    expect(seen).toEqual([false]);
  });
});

describe('settle timeout for a silent frame (#1802 nits)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('settles false and records an error when the frame never reports', () => {
    vi.useFakeTimers();
    const frame = mountSandboxFrame(attachedContainer(), { ...OPTS, settleTimeoutMs: 500 });
    const seen: boolean[] = [];
    frame.whenSettled((ok) => seen.push(ok));
    vi.advanceTimersByTime(499);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([false]);
    expect(frame.error).toContain('500 ms');
    frame.whenSettled((ok) => seen.push(ok));
    expect(seen).toEqual([false, false]);
  });

  it('keeps the timeout verdict if the frame reports afterwards', () => {
    vi.useFakeTimers();
    const frame = mountSandboxFrame(attachedContainer(), { ...OPTS, settleTimeoutMs: 100 });
    vi.advanceTimersByTime(100);
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    const seen: boolean[] = [];
    frame.whenSettled((ok) => seen.push(ok));
    expect(seen).toEqual([false]);
  });

  it('does not fire once the frame reported in time', () => {
    vi.useFakeTimers();
    const frame = mountSandboxFrame(attachedContainer(), { ...OPTS, settleTimeoutMs: 100 });
    frameReports({ iframe: frame.iframe } as never, { a: 1 });
    vi.advanceTimersByTime(1000);
    expect(frame.error).toBeNull();
    const seen: boolean[] = [];
    frame.whenSettled((ok) => seen.push(ok));
    expect(seen).toEqual([true]);
  });

  it('clears the timer on destroy and honours 0 as disabled', () => {
    vi.useFakeTimers();
    const frame = mountSandboxFrame(attachedContainer(), { ...OPTS, settleTimeoutMs: 100 });
    frame.destroy();
    expect(vi.getTimerCount()).toBe(0);
    const off = mountSandboxFrame(attachedContainer(), { ...OPTS, settleTimeoutMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(off.error).toBeNull();
  });
});
