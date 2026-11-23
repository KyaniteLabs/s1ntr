/**
 * Organ: `--teach` activated knowledge.  A signed active snapshot in the knowledge root must land in the generator's
 * brief; the same run without it, with a wrong scope, or with an inactive (rolled back) snapshot must not.
 * The snapshot is a fixture whose digest and signature are checked by the production verifier before it is used.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileActivatedKnowledgeStore, verifyActivatedKnowledgeSnapshot, type ActivatedKnowledgeSnapshot }
  from '../../src/dreaming/research/DreamKnowledgeActivation.js';
import { runOrganGeneration, type OrganRun } from './harness.js';

const KEY = 'organ-e2e-knowledge-secret';
const MARKER = 'ORGAN_TEACH_RULE_7f3a: keep the focal form off-centre and let one colour carry the motion.';
const stable = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
const hex = (c: string) => c.repeat(64);

function snapshot(scope: string): ActivatedKnowledgeSnapshot {
  const body = { schema: 'sinter.activated-creative-knowledge' as const, schemaVersion: 1 as const, status: 'active' as const,
    admissionDigest: hex('a'), admissionDigests: [hex('a')], repetitions: 1, independentStudyDigests: [hex('b')],
    transferEvidenceDigests: [hex('c')], contraindications: [], compilerRuleVersion: 1, principleIds: ['off-centre'],
    compilerRules: [MARKER], scope: [scope], policyDigest: hex('d') };
  const snapshotDigest = createHash('sha256').update(stable(body)).digest('hex');
  return { ...body, snapshotDigest, signature: createHmac('sha256', KEY).update(snapshotDigest).digest('hex') };
}

const roots: string[] = [];
const runs: OrganRun[] = [];
async function taught(opts: { scope: string; teachScope: string; rollback?: boolean }) {
  const knowledgeRoot = await mkdtemp(path.join(os.tmpdir(), 'organ-knowledge-')); roots.push(knowledgeRoot);
  const snap = snapshot(opts.scope);
  expect(verifyActivatedKnowledgeSnapshot(snap, KEY)).toBe(true);        // the fixture is what production accepts
  const store = new FileActivatedKnowledgeStore(path.join(knowledgeRoot, 'activated-knowledge.json'));
  store.save(snap); if (opts.rollback) store.rollback(snap.snapshotDigest, 'organ test');
  const r = await runOrganGeneration({ teachScope: opts.teachScope, knowledgeRoot }); runs.push(r); return r;
}
const seen = (r: OrganRun) => `${r.systemPrompt}\n${r.userPrompt}`;

afterAll(async () => { for (const r of runs) await r.cleanup(); for (const d of roots) await rm(d, { recursive: true, force: true }); });

describe('organ: --teach activated knowledge', () => {
  it('an active snapshot in scope lands in the generator brief and the receipt carries an empirical context digest', async () => {
    const r = await taught({ scope: 'html', teachScope: 'html' });
    expect(seen(r)).toContain(MARKER);
    const receipt = (r.result as unknown as { result: { receipt: { empiricalContextDigests: string[]; disabledTeachingReaders: string[] } } }).result.receipt;
    expect(receipt.empiricalContextDigests.length).toBeGreaterThan(0);
    // Governed generation reads ONLY activated knowledge and doctrine. These organs are disabled in it by design, so they
    // may feed briefs only at the batch layer (guidance.py). Enabling one in-engine must update this list and add its test.
    expect([...receipt.disabledTeachingReaders].sort()).toEqual(['compost-seed-bank', 'dream-queue', 'guidance-engine', 'harness-memory',
      'map-elites', 'quality-archive', 'semantic-art-memory']);
  }, 180_000);

  it('perturbation: no snapshot for the scope means the rule is absent', async () => {
    const r = await taught({ scope: 'music', teachScope: 'html' });
    expect(seen(r)).not.toContain(MARKER);
  }, 180_000);

  it('a rolled-back snapshot teaches nothing', async () => {
    const r = await taught({ scope: 'html', teachScope: 'html', rollback: true });
    expect(seen(r)).not.toContain(MARKER);
  }, 180_000);
});
