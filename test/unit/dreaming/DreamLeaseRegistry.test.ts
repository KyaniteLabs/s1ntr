import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DreamLeaseRegistry } from '../../../src/dreaming/research/DreamLeaseRegistry.js';

describe('DreamLeaseRegistry', () => {
  it('fences stale, concurrent, and cancelled campaign leases', () => {
    const registry = new DreamLeaseRegistry();
    const first = registry.issue('campaign-1');
    expect(() => registry.issue('campaign-1')).toThrow('DREAM_LEASE_ALREADY_ACTIVE');
    registry.assertActive('campaign-1', first);
    registry.cancel('campaign-1', first);
    expect(() => registry.assertActive('campaign-1', first))
      .toThrow('DREAM_LEASE_STALE_OR_INACTIVE');
    const second = registry.issue('campaign-1');
    expect(second.fencingSequence).toBe(first.fencingSequence + 1);
    expect(() => registry.assertActive('campaign-1', first))
      .toThrow('DREAM_LEASE_STALE_OR_INACTIVE');
  });

  it('resumes an active production lease across CLI process restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'dream-leases-'));
    const file = join(root, 'leases.json');
    try {
      const firstRegistry = new DreamLeaseRegistry(file);
      const first = firstRegistry.resumeOrIssue('campaign-1');
      const restarted = new DreamLeaseRegistry(file);
      const resumed = restarted.resumeOrIssue('campaign-1');
      expect(resumed).toEqual(first);
      restarted.assertActive('campaign-1', first);
      restarted.cancel('campaign-1', first);
      const afterCancel = new DreamLeaseRegistry(file);
      expect(() => afterCancel.assertActive('campaign-1', first))
        .toThrow('DREAM_LEASE_STALE_OR_INACTIVE');
      expect(afterCancel.resumeOrIssue('campaign-1').fencingSequence)
        .toBe(first.fencingSequence + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
