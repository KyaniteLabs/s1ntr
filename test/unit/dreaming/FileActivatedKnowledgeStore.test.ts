import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileActivatedKnowledgeStore, type ActivatedKnowledgeSnapshot }
  from '../../../src/dreaming/research/DreamKnowledgeActivation.js';
import { resolveKnowledgeRoot } from '../../../src/runtime-core/ProductionLiminalRuntime.js';
import { parseTeachScope } from '../../../src/cli/LiminalProductionGenerate.js';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const snap = (n: number, scope: string[]): ActivatedKnowledgeSnapshot => ({
  schema: 'sinter.activated-creative-knowledge', schemaVersion: 1, status: 'active',
  admissionDigest: hex(1000 + n), admissionDigests: [], repetitions: 1,
  independentStudyDigests: [], transferEvidenceDigests: [], contraindications: [],
  compilerRuleVersion: 1, principleIds: ['p'], compilerRules: ['r'], scope,
  policyDigest: hex(1), snapshotDigest: hex(n), signature: 'x' }) as never;
const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'knowledge-')), 'activated-knowledge.json');

describe('FileActivatedKnowledgeStore ordering and scope', () => {
  it('orders by activation sequence, not by digest or key order', () => {
    const store = new FileActivatedKnowledgeStore(tmp());
    store.save(snap(9, ['visual'])); store.save(snap(2, ['visual'])); store.save(snap(5, ['visual']));
    expect(store.latestActive('visual')?.snapshotDigest).toBe(hex(5));
    store.rollback(hex(5), 'bad');
    expect(store.latestActive('visual')?.snapshotDigest).toBe(hex(2));
  });
  it('matches scope exactly, never as a substring', () => {
    const store = new FileActivatedKnowledgeStore(tmp());
    store.save(snap(1, ['visual-extended'])); store.save(snap(2, ['motion']));
    expect(store.latestActive('visual')).toBeUndefined();
    expect(store.latestActive('vis')).toBeUndefined();
    expect(store.latestActive('motion')?.snapshotDigest).toBe(hex(2));
  });
  it('keeps a known-good snapshot and proves rollback restores it', () => {
    const store = new FileActivatedKnowledgeStore(tmp());
    store.save(snap(1, ['visual'])); store.save(snap(2, ['visual']));
    store.rollback(hex(2), 'regression');
    expect(store.latestActive('visual')?.snapshotDigest).toBe(hex(1));
    expect(store.read(hex(2))?.snapshotDigest).toBe(hex(2));
    expect(store.isActive(hex(2))).toBe(false);
  });
});

describe('FileActivatedKnowledgeStore concurrency', () => {
  it('loses no snapshot when several processes save at once', () => {
    const file = tmp();
    const script = path.join(path.dirname(file), 'worker.ts');
    writeFileSync(script, `
      import { FileActivatedKnowledgeStore } from ${JSON.stringify(path.resolve('src/dreaming/research/DreamKnowledgeActivation.ts'))};
      const [file, base] = [process.argv[2], Number(process.argv[3])];
      const store = new FileActivatedKnowledgeStore(file);
      for (let i = 0; i < 8; i++) {
        const n = base + i;
        store.save({ schema: 'sinter.activated-creative-knowledge', schemaVersion: 1, status: 'active',
          admissionDigest: String(n).padStart(64, '0'), admissionDigests: [], repetitions: 1,
          independentStudyDigests: [], transferEvidenceDigests: [], contraindications: [],
          compilerRuleVersion: 1, principleIds: ['p'], compilerRules: ['r'], scope: ['visual'],
          policyDigest: '1'.repeat(64), snapshotDigest: n.toString(16).padStart(64, '0'), signature: 'x' });
      }`);
    const procs = [100, 200, 300, 400].map(base => spawnSync(
      path.resolve('node_modules/.bin/tsx'), [script, file, String(base)], { encoding: 'utf8' }));
    for (const p of procs) expect(p.status, p.stderr).toBe(0);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(state.snapshots)).toHaveLength(32);
  }, 60_000);
  it('fails loudly on a fresh lock and breaks a stale one', () => {
    const file = tmp(); const lock = `${file}.lock`;
    mkdirSync(lock);
    const store = new FileActivatedKnowledgeStore(file, { lockTimeoutMs: 150 });
    expect(() => store.save(snap(1, ['visual']))).toThrow('KNOWLEDGE_STORE_LOCKED');
    const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
    store.save(snap(1, ['visual']));
    expect(store.isActive(hex(1))).toBe(true);
  });
});

describe('knowledge root and --teach validation', () => {
  it('resolves option, then env, then run root; rejects relative paths', () => {
    expect(resolveKnowledgeRoot({ knowledgeRoot: '/a' }, { SINTER_LIMINAL_KNOWLEDGE_ROOT: '/b' }, '/r')).toBe('/a');
    expect(resolveKnowledgeRoot({}, { SINTER_LIMINAL_KNOWLEDGE_ROOT: '/b' }, '/r')).toBe('/b');
    expect(resolveKnowledgeRoot({}, {}, '/r')).toBe('/r');
    expect(() => resolveKnowledgeRoot({}, { SINTER_LIMINAL_KNOWLEDGE_ROOT: 'rel' }, '/r'))
      .toThrow('LIMINAL_KNOWLEDGE_ROOT_NOT_ABSOLUTE');
  });
  it('accepts only visual|motion for --teach', () => {
    expect(parseTeachScope('visual')).toBe('visual');
    expect(parseTeachScope('motion')).toBe('motion');
    for (const bad of [undefined, '', '--json', 'audio', 'vis']) {
      expect(() => parseTeachScope(bad)).toThrow(/--teach/);
    }
  });
});

describe('FileActivatedKnowledgeStore lock ownership', () => {
  it('never removes a lock that another process now owns', () => {
    const file = tmp();
    const store = new FileActivatedKnowledgeStore(file);
    const lock = `${file}.lock`;
    (store as any).withLock(() => {
      // Simulate another process breaking our (stale) lock and taking it.
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), 'someone-else');
    });
    expect(readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('someone-else');
  });
  it('breaks a genuinely stale lock exactly once and proceeds', () => {
    const file = tmp(); const lock = `${file}.lock`;
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), 'dead');
    const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
    const store = new FileActivatedKnowledgeStore(file);
    store.save(snap(1, ['visual']));
    expect(store.latestActive('visual')?.snapshotDigest).toBe(hex(1));
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(path.dirname(file)).filter(name => name.includes('.stale-'))).toEqual([]);
  });
  it('leaves a fresh lock alone and times out instead of breaking it', () => {
    const file = tmp(); const lock = `${file}.lock`;
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), 'live-holder');
    const store = new FileActivatedKnowledgeStore(file, { lockTimeoutMs: 50 });
    expect(() => store.save(snap(1, ['visual']))).toThrow('KNOWLEDGE_STORE_LOCKED');
    expect(readFileSync(path.join(lock, 'owner'), 'utf8')).toBe('live-holder');
  });
});
