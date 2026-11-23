/**
 * Dogfood finding 1: after an accepted governed generate, fs artifacts / compost status / gbg / name / taxonomy /
 * rescue / report fitness all printed "nothing". The governed finisher (runProductionCliGenerate) now records the
 * outcome once into the project stores those organs already read. Every assertion runs the real binary.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SinterFS } from '../../src/fs/SinterFS.js';
import { ArchiveEntriesFSAdapter } from '../../src/fs/adapters/ArchiveEntries.js';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 290_000, hookTimeout: 290_000 });

let work: string; let fake: FakeProvider; let naming: http.Server; let judgeScore = 0.8;
let proj: string; let env: NodeJS.ProcessEnv;
const run = (args: string[]) => runSinterAsync(args, env, proj);

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-govrec-'));
  proj = path.join(work, 'proj'); mkdirSync(proj, { recursive: true });
  fake = await startFakeProvider({ judge: () => goodJudgeReply(judgeScore) });
  naming = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ variants: [{ name: 'Lumenfield', availability_score: 0.9, reasoning: 'stub naming engine' }] }));
  });
  await new Promise<void>(r => naming.listen(0, '127.0.0.1', r));
  const namingUrl = `http://127.0.0.1:${(naming.address() as AddressInfo).port}/`;
  env = { ...fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') }),
    ELIXIS_NAMING_URL: namingUrl, ELIXIS_URL: namingUrl, ELIXIS_HOME: path.join(work, 'no-elixis') };
  // one accepted piece, then one the judge rejects
  judgeScore = 0.8;
  const good = await run(['generate', '-o', path.join(work, 'out-good'), '--domain', 'html', 'a slow orbit of colored light']);
  expect(good.status).toBe(0);
  judgeScore = 0.1;
  const bad = await run(['generate', '-o', path.join(work, 'out-bad'), '--domain', 'html', 'a flat grey rectangle']);
  expect(bad.status).toBe(3);
});
afterAll(async () => { await fake.close(); await new Promise(r => naming.close(r)); rmSync(work, { recursive: true, force: true }); });

describe('an accepted governed generate shows up in the organs that read the project', () => {
  it('fs artifacts lists the piece with its ref name', async () => {
    const r = await runSinterAsync(['fs', 'artifacts'], { ...env, SINTER_PROJECT_ROOT: proj }, work);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/generate\/[0-9a-f]{8,}\s+generated-code\s+[0-9a-f]{6,}/);
    expect(r.out).not.toContain('No artifacts found');
  });

  it('makes the exact accepted source available to taste training in a separate process', async () => {
    const store = SinterFS.open(proj);
    const providerCalls = fake.calls.length;
    try {
      const archive = new ArchiveEntriesFSAdapter(store);
      const [entry, ...others] = archive.readAllArchiveEntries();
      expect(others).toHaveLength(0);
      const savedSource = store.readArtifact(entry.artifactRef);
      if (!savedSource) throw new Error('accepted source was missing from the archive');
      expect(entry.qualityScore).toBeCloseTo(0.8);
      expect(entry.creativeLabel).toMatchObject({ trustKind: 'judge-scoring',
        artifactDigest: createHash('sha256').update(savedSource).digest('hex'),
        trainingEvidence: { operationDigest: entry.lineage.artifactId, quality: entry.qualityScore },
        allowedUses: ['evaluator-training'], authorityProof: { authorityTier: 'production' } });
      const trained = await run(['taste', 'train']);
      expect(trained.status).toBe(1);
      expect(trained.out).toContain('no usable preference pairs');

      archive.writeArchiveEntry({ ...entry, qualityScore: 0.99 });
      try {
        const modifiedScore = await run(['taste', 'train']);
        expect(modifiedScore.status).toBe(1);
        expect(modifiedScore.out).toContain('no rendered admitted labels');
      } finally { archive.writeArchiveEntry(entry); }

      const asset = entry.artifactRef.path!;
      writeFileSync(asset, '<html>modified content</html>');
      try {
        const modifiedSource = await run(['taste', 'train']);
        expect(modifiedSource.status).toBe(1);
        expect(modifiedSource.out).toContain('no rendered admitted labels');
      } finally { writeFileSync(asset, savedSource); }
    } finally { store.close(); }
    expect(fake.calls).toHaveLength(providerCalls);
  });

  it('gbg --index indexes the governed piece as a bead', async () => {
    const r = await run(['gbg', '--index']);
    expect(r.out).toMatch(/beads \+1 \(total 1\)/);
  });

  it('taxonomy counts the html domain', async () => {
    const r = await run(['taxonomy', '--json', '--no-write']);
    const start = r.out.indexOf('{');
    const json = JSON.parse(r.out.slice(start, r.out.indexOf('\n}', start) + 2)) as { domains: Record<string, unknown> };
    expect(Object.keys(json.domains)).toContain('html');
  });

  it('name plates the html champion', async () => {
    const r = await run(['name']);
    expect(r.out).toContain('[name] best html -> "Lumenfield"');
  });

  it('report fitness counts both observations (one accepted, one rejected)', async () => {
    const r = await run(['report', 'fitness']);
    expect(r.out).toMatch(/All: 2 total/);
  });

  it('replaying Create leaves observations intact and refuses edited source', async () => {
    const out = path.join(work, 'out-good');
    const args = ['generate', '-o', out, '--domain', 'html', 'a slow orbit of colored light'];
    const count = fake.generated.length;
    const trend = path.join(proj, '.omx', 'atelier', 'lessons', 'trend.jsonl');
    const before = readFileSync(trend, 'utf8');
    const replay = await run(args);
    expect(replay.status, replay.out).toBe(0);
    expect(readFileSync(trend, 'utf8')).toBe(before);
    const source = path.join(out, 'artifacts', readdirSync(path.join(out, 'artifacts'))[0], 'source.txt');
    const original = readFileSync(source);
    writeFileSync(source, 'changed after Create');
    try {
      const edited = await run(args);
      expect(edited.out).toContain('Project record skipped: LIMINAL_ARTIFACT_DIGEST_MISMATCH');
      expect(readFileSync(trend, 'utf8')).toBe(before);
      expect((await run(['report', 'fitness'])).out).toMatch(/All: 2 total/);
      expect(fake.generated).toHaveLength(count);
    } finally { writeFileSync(source, original); }
  });

  it('keeps rejected pieces in rescue diagnostics outside the learning heap', async () => {
    const compost = await run(['compost', 'status']);
    expect(compost.out).toMatch(/Heap files: 0\b/);
    const rescue = await run(['rescue']);
    expect(rescue.out).toMatch(/pool=1\b/);
    expect(readdirSync(path.join(proj, '.omx', 'atelier', 'rejects', 'code')).filter(f => f.endsWith('.txt'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(proj, '.omx', 'atelier', 'governed-best.json'), 'utf8')).html.mean).toBeCloseTo(4, 5);
  });
});
