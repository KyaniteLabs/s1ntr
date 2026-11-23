import { SANDBOX_ERROR_TAG, SANDBOX_MESSAGE_TAG, type SandboxedInstance } from '../../../../src/composition/adapters/sandboxFrame.js';
import type { Layer } from '../../../../src/composition/types.js';

export const STUB_LIB = '/* stub vendored library */ window.__stubLib = true;';

export function makeLayer(type: Layer['type'], id: string, code: string, overrides: Partial<Layer['config']> = {}): Layer {
  return {
    id,
    type,
    code,
    config: { zIndex: 1, blendMode: 'normal', opacity: 1, position: { x: 0, y: 0 }, scale: 1, ...overrides },
    metadata: { prompt: 'test', generator: 'test', model: 'test', generatedAt: new Date().toISOString() },
    enabled: true,
    locked: false,
  };
}

/** Attach a container to the document so the iframe gets a contentWindow. */
export function attachedContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

/** Deliver a state message as if the sandbox frame had posted it. */
export function frameReports(instance: SandboxedInstance, state: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { tag: SANDBOX_MESSAGE_TAG, state },
    source: instance.iframe?.contentWindow ?? null,
  }));
}

export function srcdocOf(instance: SandboxedInstance): string {
  return instance.iframe?.getAttribute('srcdoc') ?? instance.iframe?.srcdoc ?? '';
}

/** Deliver an uncaught-error message as if the sketch inside the frame had thrown. */
export function frameFails(instance: SandboxedInstance, message: string): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { tag: SANDBOX_ERROR_TAG, message },
    source: instance.iframe?.contentWindow ?? null,
  }));
}
