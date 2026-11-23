/**
 * @vitest-environment jsdom
 *
 * #1533 acceptance, STRUCTURAL ONLY: with GeneratedCodeGuard mocked OFF, each
 * adapter that runs LLM output still mounts it in a sandboxed iframe
 * (allow-scripts, no allow-same-origin) whose srcdoc has a default-src 'none'
 * CSP. jsdom never executes srcdoc iframe scripts and does not enforce
 * `sandbox` or CSP, so this file does NOT prove runtime isolation; the
 * __pwn probe below only guards against the adapter evaluating code in the
 * host realm. Real execution isolation needs a browser run (Chromium).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P5Adapter } from '../../../src/composition/adapters/P5Adapter.js';
import { ToneAdapter } from '../../../src/composition/adapters/ToneAdapter.js';
import { ThreeAdapter } from '../../../src/composition/adapters/ThreeAdapter.js';
import { HydraAdapter } from '../../../src/composition/adapters/HydraAdapter.js';
import type { SandboxedInstance } from '../../../src/composition/adapters/sandboxFrame.js';
import { attachedContainer, makeLayer, srcdocOf, STUB_LIB } from '../composition/adapters/sandboxTestUtils.js';

vi.mock('../../../src/guardrails/GeneratedCodeGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/guardrails/GeneratedCodeGuard.js')>()),
  findGeneratedCodeViolations: () => [],
}));
vi.mock('../../../src/composition/adapters/sandboxFrame.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/composition/adapters/sandboxFrame.js')>()),
  loadSandboxLib: async () => STUB_LIB,
}));

// A payload no regex pre-check names: constructor chain to reach the host.
const PAYLOAD = `[].constructor.constructor('__pwn("ctor")')(); __pwn("direct");`;

describe('generated code is mounted in a sandbox frame, never evaluated by the adapter (guard mocked off)', () => {
  const pwn = vi.fn();

  beforeEach(() => { (window as unknown as { __pwn: unknown }).__pwn = pwn; pwn.mockClear(); });
  afterEach(() => {
    Reflect.deleteProperty(window, '__pwn');
    document.body.innerHTML = '';
  });

  const cases: Array<[string, () => Promise<(code: string) => SandboxedInstance>]> = [
    ['p5', async () => { const a = new P5Adapter(); await a.initialize(); return (c) => a.render(makeLayer('p5', 'p', `function setup(){ ${c} }\nfunction draw(){}`), attachedContainer()); }],
    ['tone', async () => { const a = new ToneAdapter(); await a.initialize(); return (c) => a.render(makeLayer('tone', 't', c), attachedContainer()); }],
    ['three', async () => { const a = new ThreeAdapter(); await a.initialize(); return (c) => a.render(makeLayer('three', 'r', c), attachedContainer()); }],
    ['hydra', async () => { const a = new HydraAdapter(); await a.initialize(); return (c) => a.render(makeLayer('hydra', 'h', c), attachedContainer()); }],
  ];

  for (const [name, make] of cases) {
    it(`${name}: mounts an opaque-origin sandbox frame and the adapter never evaluates the code`, async () => {
      const render = await make();
      // The pre-check here is only the adapter's own pattern list; the payload evades it.
      const inst = render(PAYLOAD);

      expect(inst.iframe?.tagName).toBe('IFRAME');
      const sandbox = inst.iframe!.getAttribute('sandbox');
      expect(sandbox).toBe('allow-scripts');
      expect(sandbox).not.toContain('allow-same-origin');

      const doc = srcdocOf(inst);
      expect(doc).toMatch(/Content-Security-Policy" content="[^"]*default-src 'none'/);
      expect(doc).toContain(STUB_LIB);
      expect(doc).toContain('__pwn("direct")');

      await new Promise((r) => setTimeout(r, 25));
      expect(pwn).not.toHaveBeenCalled();
    });
  }
});
