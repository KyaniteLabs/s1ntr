import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  briefDigest,
  mandateKey,
  claimMandate,
  releaseMandate,
  isActiveClaimStale,
  resolveMandateTtlMs,
} from '../../../scripts/rotation/diagnose-mandate-dedup.mjs';

describe('diagnose-mandate-dedup (#472)', () => {
  let dir: string;
  let ledger: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mandate-'));
    ledger = join(dir, 'ledger.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mandateKey is stable for same parts', () => {
    const a = mandateKey({
      wave: 50,
      round: 0,
      lane: 'L1',
      model: 'gpt-5.6-sol',
      brief: 'hello',
      tip: 'abc123',
    });
    const b = mandateKey({
      wave: 50,
      round: 0,
      lane: 'L1',
      model: 'gpt-5.6-sol',
      briefDigest: briefDigest('hello'),
      tip: 'abc123',
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('mandateKey changes when lane or brief changes', () => {
    const base = { wave: 1, round: 0, model: 'm', tip: 't', brief: 'b' };
    expect(mandateKey({ ...base, lane: 'L1' })).not.toBe(mandateKey({ ...base, lane: 'L2' }));
    expect(mandateKey({ ...base, lane: 'L1', brief: 'b1' })).not.toBe(
      mandateKey({ ...base, lane: 'L1', brief: 'b2' }),
    );
  });

  it('claimMandate dedups second claim of same key', () => {
    const key = mandateKey({ wave: 1, round: 0, lane: 'L1', model: 'm', brief: 'x', tip: 't' });
    const first = claimMandate(ledger, key, { lane: 'L1' });
    expect(first.claimed).toBe(true);
    expect(first.dedup_hit).toBe(false);
    const second = claimMandate(ledger, key, { lane: 'L1' });
    expect(second.claimed).toBe(false);
    expect(second.dedup_hit).toBe(true);
    expect(existsSync(ledger)).toBe(true);
    const body = JSON.parse(readFileSync(ledger, 'utf8'));
    expect(body.entries[key].status).toBe('active');
  });

  it('releaseMandate allows re-claim', () => {
    const key = mandateKey({ wave: 2, round: 1, lane: 'L3', model: 'g', brief: 'z', tip: 't' });
    expect(claimMandate(ledger, key).claimed).toBe(true);
    expect(releaseMandate(ledger, key).released).toBe(true);
    expect(claimMandate(ledger, key).claimed).toBe(true);
  });
});

describe('diagnose-mandate-dedup CLI', () => {
  it('claim CLI exits 3 on dedup hit', async () => {
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'mandate-cli-'));
    const ledger = join(dir, 'l.json');
    const key = mandateKey({ wave: 9, round: 0, lane: 'L1', model: 'm', brief: 'cli', tip: 'tip' });
    const first = spawnSync(
      'node',
      ['scripts/rotation/diagnose-mandate-dedup.mjs', 'claim', '--ledger', ledger, '--key', key],
      { encoding: 'utf8' },
    );
    expect(first.status).toBe(0);
    const second = spawnSync(
      'node',
      ['scripts/rotation/diagnose-mandate-dedup.mjs', 'claim', '--ledger', ledger, '--key', key],
      { encoding: 'utf8' },
    );
    expect(second.status).toBe(3);
    const rel = spawnSync(
      'node',
      ['scripts/rotation/diagnose-mandate-dedup.mjs', 'release', '--ledger', ledger, '--key', key],
      { encoding: 'utf8' },
    );
    expect(rel.status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('mandate TTL / stale reclaim', () => {
  let dir: string;
  let ledger: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mandate-ttl-'));
    ledger = join(dir, 'ledger.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh active claim still dedups', () => {
    const key = mandateKey({ wave: 1, round: 0, lane: 'L1', model: 'm', brief: 'ttl', tip: 't' });
    const now = Date.now();
    expect(claimMandate(ledger, key, {}, { nowMs: now, ttlMs: 60_000 }).claimed).toBe(true);
    const second = claimMandate(ledger, key, {}, { nowMs: now + 1_000, ttlMs: 60_000 });
    expect(second.claimed).toBe(false);
    expect(second.dedup_hit).toBe(true);
    expect(second.expired).toBe(false);
  });

  it('stale active claim can be reclaimed (no false-green forever)', () => {
    const key = mandateKey({ wave: 1, round: 0, lane: 'L2', model: 'm', brief: 'stale', tip: 't' });
    const now = Date.now();
    expect(claimMandate(ledger, key, {}, { nowMs: now, ttlMs: 10_000 }).claimed).toBe(true);
    const reclaim = claimMandate(ledger, key, {}, { nowMs: now + 11_000, ttlMs: 10_000 });
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.dedup_hit).toBe(false);
    expect(reclaim.expired).toBe(true);
    expect(reclaim.entry?.reclaimedAfterExpiry).toBe(true);
  });

  it('isActiveClaimStale helper', () => {
    const now = 1_000_000;
    expect(isActiveClaimStale({ status: 'active', claimedAt: new Date(now - 5_000).toISOString() }, now, 10_000)).toBe(
      false,
    );
    expect(isActiveClaimStale({ status: 'active', claimedAt: new Date(now - 15_000).toISOString() }, now, 10_000)).toBe(
      true,
    );
    expect(isActiveClaimStale({ status: 'released', claimedAt: new Date(now - 15_000).toISOString() }, now, 10_000)).toBe(
      false,
    );
    expect(resolveMandateTtlMs(42)).toBe(42);
  });
});
