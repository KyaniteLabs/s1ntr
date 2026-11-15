/**
 * inspectGrokOidcAuth — nested OIDC + expiry for wave2 preflight.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectGrokOidcAuth } from '../../../scripts/rotation/grok-auth.mjs';

describe('inspectGrokOidcAuth', () => {
  let dir: string;
  let authPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));
    authPath = path.join(dir, 'auth.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts nested auth.x.ai entry with key and future expires_at', () => {
    const exp = new Date(Date.now() + 3 * 3_600_000).toISOString();
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai::test-id': {
          key: 'xai-test-key-not-real',
          expires_at: exp,
          auth_mode: 'oidc',
          create_time: new Date().toISOString(),
        },
      }),
    );
    const r = inspectGrokOidcAuth({ authPath, env: {}, minTtlMs: 3_600_000 });
    expect(r.ok).toBe(true);
    expect(r.keySource).toBe('grok-oidc');
    expect(r.detail).toMatch(/hoursLeft=/);
    expect(r.hoursLeft).toBeGreaterThan(2);
  });

  it('fails when OIDC expired and no env key', () => {
    const exp = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai::old': {
          key: 'xai-old',
          expires_at: exp,
          auth_mode: 'oidc',
        },
      }),
    );
    const r = inspectGrokOidcAuth({ authPath, env: {}, minTtlMs: 3_600_000 });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/hoursLeft=/);
  });

  it('falls back to env key when OIDC expired', () => {
    const exp = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai::old': { key: 'xai-old', expires_at: exp },
      }),
    );
    const r = inspectGrokOidcAuth({
      authPath,
      env: { XAI_API_KEY: 'env-key' },
      minTtlMs: 3_600_000,
    });
    expect(r.ok).toBe(true);
    expect(r.keySource).toBe('env');
  });

  it('missing auth.json without env is not ok', () => {
    const r = inspectGrokOidcAuth({
      authPath: path.join(dir, 'nope.json'),
      env: {},
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/missing/);
  });
});
