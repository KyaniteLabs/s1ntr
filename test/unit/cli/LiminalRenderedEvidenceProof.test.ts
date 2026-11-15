import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRenderedEvidenceProof } from '../../../src/cli/LiminalRenderedEvidenceProof.js';

// undici (HTTP agent used by the provider layer this CLI transitively imports) is a network boundary; the proof makes zero calls.
vi.mock('undici', () => ({ Agent: class {} }));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rendered-proof-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runRenderedEvidenceProof', () => {
  it('runs the fixed command and reports zero external calls', async () => {
    const out = await runRenderedEvidenceProof(root);
    expect(out.externalCalls).toEqual({ network: 0, browser: 0, provider: 0, metered: 0 });
    expect(out.command).toMatchObject({
      kind: 'generate-candidate',
      idempotencyKey: 'wave8-rendered-evidence-zero-call-proof-v1',
      domain: 'p5',
      renderAuthorization: 'test-fake',
      rendererIdentity: 'fake-renderer/v1',
    });
  });

  it('freezes the command, the result envelope and the call counts', async () => {
    const out = await runRenderedEvidenceProof(root);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.command)).toBe(true);
    expect(Object.isFrozen(out.externalCalls)).toBe(true);
  });

  it('persists the journal and artifacts under the given root', async () => {
    await runRenderedEvidenceProof(root);
    expect(existsSync(join(root, 'operation-journal.json'))).toBe(true);
    expect(readdirSync(join(root, 'artifacts')).length).toBeGreaterThan(0);
  });

  it('is idempotent: a second run on the same root returns the same command and result status', async () => {
    const first = await runRenderedEvidenceProof(root);
    const second = await runRenderedEvidenceProof(root);
    expect(second.command).toEqual(first.command);
    expect((second.result as { status?: string }).status).toBe((first.result as { status?: string }).status);
  });

  it('keeps separate roots independent', async () => {
    const other = mkdtempSync(join(tmpdir(), 'rendered-proof-b-'));
    try {
      await runRenderedEvidenceProof(root);
      expect(existsSync(join(other, 'operation-journal.json'))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
