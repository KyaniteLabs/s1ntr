import { describe, expect, it } from 'vitest';
import { engineLoadTimeoutError } from '../../../src/render/HeadlessRenderer.js';

// engine-render.test.ts (integration) proves this end to end; these pin the mapping itself.
const ENGINE_PAGE = '<!doctype html>\n<html lang="en" data-sinter-engine="nbe"><head></head><body></body></html>';
const timeout = Object.assign(new Error('page.setContent: Timeout 4000ms exceeded.\nCall log: ...'), { name: 'TimeoutError' });

describe('engineLoadTimeoutError', () => {
  it('maps a load timeout on an engine page to ENGINE_NOT_READY naming the engine', () => {
    expect(engineLoadTimeoutError(ENGINE_PAGE, timeout, 4000)?.message)
      .toBe('ENGINE_NOT_READY:nbe: page did not finish loading within 4000 ms (page.setContent: Timeout 4000ms exceeded.)');
  });

  it('recognises the timeout by its message when the error name is lost', () => {
    const plain = new Error('page.setContent: Timeout 30000ms exceeded.');
    expect(engineLoadTimeoutError(ENGINE_PAGE, plain, 30000)?.message)
      .toBe('ENGINE_NOT_READY:nbe: page did not finish loading within 30000 ms (page.setContent: Timeout 30000ms exceeded.)');
  });

  it('leaves non-engine pages and non-timeout errors alone', () => {
    expect(engineLoadTimeoutError('<html><body></body></html>', timeout, 4000)).toBeUndefined();
    expect(engineLoadTimeoutError(ENGINE_PAGE, new Error('net::ERR_ABORTED'), 4000)).toBeUndefined();
  });
});
