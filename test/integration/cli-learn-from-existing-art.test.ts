/** The CLI inventories legacy art and routes only intact, signed Creates to project stores. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 290_000, hookTimeout: 290_000 });

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv;
let runs: string; let proj: string; let home: string; let ldir: string; let likes: string;
const sources: Record<string, string> = {};

interface Spec { id: string; at: string; score: number; accepted: boolean; withProjection?: boolean }
const specs: Spec[] = [
  { id: 'p1-orbit', at: '2026-11-01T10:00:00Z', score: 0.8, accepted: true },
  { id: 'p2-grey', at: '2026-11-02T10:00:00Z', score: 0, accepted: false },
  { id: 'p3-bloom', at: '2026-11-03T10:00:00Z', score: 0.85, accepted: true },
  { id: 'p4-held', at: '2026-11-04T10:00:00Z', score: 0.9, accepted: true },
  { id: 'p5-legacy', at: '2026-11-05T10:00:00Z', score: 0, accepted: false, withProjection: false },
];

function makePiece(s: Spec): void {
  const dir = path.join(runs, 'seatA', s.id); const code = `<!-- ${s.id} -->\n<canvas></canvas><script>/* ${s.id} */</script>\n`;
  sources[s.id] = sha(code);
  const art = path.join(dir, 'artifacts', sha(`art-${s.id}`));
  mkdirSync(art, { recursive: true });
  writeFileSync(path.join(art, 'source.txt'), code); writeFileSync(path.join(art, 'late-frame.png'), 'png');
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model_key: 'seatA', model: 'fake-model', prompt_id: s.id, domain: 'html', finished_utc: s.at, rc: 0 }));
  if (s.withProjection === false) return;
  const evaluation = s.accepted
    ? { score: s.score, confidence: 0.9, failureClass: 'none', reasoning: 'ok', degraded: false, identityValid: true, evaluatorIdentity: 'fake', evidenceDigest: sha('e'), admissionEligible: true, rejectionReasons: [] }
    : { score: 0, degraded: true, failureClass: 'infra', identityValid: true, evaluatorIdentity: 'fake', evidenceDigest: null, admissionEligible: false, rejectionReasons: ['evaluation-degraded'] };
  const result = { operationId: `op-${s.id}`, lineageId: `ln-${s.id}`, domain: 'html', roles: { generator: 'fake/model', evaluator: 'fake/judge', harness: 'h', studio: 's' },
    artifacts: { sourceDigest: sources[s.id], playableDigest: sha('p'), provenanceDigest: sha('v') }, evidence: { status: 'rendered' }, evaluation, attempts: { consumed: 1, maximum: 2 },
    receipt: { schema: 'sinter.liminal-authority-receipt', artifactDigest: sha(`artifact-${s.id}`), learningEligible: false } };
  writeFileSync(path.join(dir, 'product-projections.json'), JSON.stringify({ [`production-create:${s.id}`]: { kind: 'create', result } }));
}

const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const tree = (d: string): string[] => { const out: string[] = []; const w = (x: string): void => { for (const e of readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) w(f); else out.push(f); } }; if (existsSync(d)) w(d); return out.sort(); };
const snapshot = (d: string): string => sha(tree(d).map(f => `${f}:${sha(readFileSync(f, 'utf8'))}`).join('\n'));
const digest = (extra: string[] = []) => runSinterAsync(['learn-from-existing-art', '--root', runs, '--project-root', proj, '--home', home, '--learning-dir', ldir, '--likes', likes, '--freeze-holdout-percent', '0', ...extra], env, work);

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-digest-'));
  runs = path.join(work, 'runs'); proj = path.join(work, 'proj'); home = path.join(work, 'home'); ldir = path.join(work, 'learning'); likes = path.join(work, 'likes.jsonl');
  for (const d of [runs, proj, home, ldir]) mkdirSync(d, { recursive: true });
  fake = await startFakeProvider({ judge: () => goodJudgeReply(0.8) });
  env = fakeProviderEnv(fake, { home, stateRoot: path.join(work, 'state') });
  for (const s of specs) makePiece(s);
  writeFileSync(path.join(ldir, 'holdout-prompts.txt'), 'p4-held\n');
  appendFileSync(likes, JSON.stringify({ seat: 'seatA', id: 'p3-bloom', vote: 'up', at: '2026-11-06T00:00:00Z' }) + '\n');
  appendFileSync(likes, JSON.stringify({ seat: 'seatA', id: 'p5-legacy', vote: 'down', at: '2026-11-06T00:01:00Z' }) + '\n');
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

interface Report {
  pieces: number;
  organs: Record<string, { written: number; wouldWrite: number; notApplicable: number; alreadyDone: number }>;
}

function report(stdout: string): Report {
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

describe('learn-from-existing-art', () => {
  it('previews unsigned inventory without writing or spending a provider call', async () => {
    const before = snapshot(work);
    const run = await digest(['--dry-run', '--json', '--with-model-calls']);
    expect(run.status, run.out).toBe(0);
    expect(report(run.stdout)).toMatchObject({ pieces: 5, organs: {
      corpus: { wouldWrite: 5 }, archive: { wouldWrite: 0 }, 'compost-add': { wouldWrite: 0 },
    } });
    expect(report(run.stdout)).toMatchObject({ notes: expect.arrayContaining([
      expect.stringContaining('Model-assisted replay is unavailable'),
    ]) });
    expect(snapshot(work)).toBe(before);
    expect(fake.calls).toHaveLength(0);
  });

  it('stores unsigned projections and votes as inventory and replays idempotently', async () => {
    const before = snapshot(runs);
    const first = await digest(['--json']);
    expect(first.status, first.out).toBe(0);
    const inventory = lines(path.join(ldir, 'digest', 'inventory.jsonl')).map(line => JSON.parse(line));
    expect(inventory.map(row => row.prompt_id)).toEqual(specs.map(spec => spec.id));
    expect(inventory.find(row => row.prompt_id === 'p4-held')).toMatchObject({ holdout: true });
    expect(inventory.every(row => row.admission_eligible === false && !row.create_key)).toBe(true);
    expect(tree(proj)).toEqual([]);
    expect(existsSync(path.join(ldir, 'corpus.jsonl'))).toBe(false);
    expect(existsSync(path.join(ldir, 'source-votes.jsonl'))).toBe(false);
    const stored = snapshot(ldir);
    const again = await digest(['--json']);
    expect(again.status, again.out).toBe(0);
    expect(report(again.stdout).organs.corpus).toMatchObject({ written: 0, alreadyDone: 5 });
    expect(snapshot(ldir)).toBe(stored);
    expect(snapshot(runs)).toBe(before);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses symlink write destinations inside scanned artwork before any write', async () => {
    const alias = path.join(work, 'inside-scanned-art');
    symlinkSync(runs, alias, 'dir');
    const before = snapshot(runs);
    const result = await digest(['--learning-dir', path.join(alias, 'future'), '--freeze-holdout-percent', '10']);
    expect(result.status, result.out).toBe(1);
    expect(result.stderr).toContain('resolves inside scanned art');
    expect(snapshot(runs)).toBe(before);
  });

  it.skipIf(process.env.RUN_SIGNED_DIGEST_PROOF !== '1')('replays a signed Create and refuses its tampered bytes', async () => {
    const stateRoot = path.join(work, 'state');
    const signedRuns = path.join(work, 'signed-runs');
    const signedRun = path.join(signedRuns, 'seatA', 'verified');
    const target = path.join(work, 'verified-project');
    const learning = path.join(work, 'verified-learning');
    const args = ['learn-from-existing-art', '--root', signedRuns, '--state-root', stateRoot,
      '--project-root', target, '--learning-dir', learning, '--home', home, '--json'];
    const valid = await runSinterAsync(['generate', '-o', signedRun, '--domain', 'html',
      'An orbit with changing colours and two shapes'], env, work);
    expect(valid.status, valid.out.slice(-700)).toBe(0);
    writeFileSync(path.join(signedRun, 'manifest.json'), JSON.stringify({ model_key: 'seatA',
      prompt_id: 'signed', domain: 'html', finished_utc: '2026-11-06T00:00:00Z' }));
    const source = tree(signedRun).find(file => file.endsWith('/source.txt'))!;
    expect(readFileSync(source, 'utf8')).toContain('<html');
    const beforeDigest = fake.calls.length;
    const offline = { HOME: home, PATH: env.PATH };
    const before = [snapshot(signedRuns), snapshot(stateRoot), snapshot(home)];
    const preview = await runSinterAsync([...args, '--dry-run'], offline, work);
    expect(preview.status, preview.out).toBe(0);
    expect(report(preview.stdout).organs.archive.wouldWrite).toBe(1);
    expect(tree(target)).toEqual([]);
    expect(tree(learning)).toEqual([]);
    expect([snapshot(signedRuns), snapshot(stateRoot), snapshot(home)]).toEqual(before);
    const aliasedProject = path.join(work, 'aliased-project');
    const aliasedStore = path.join(aliasedProject, '.sinter');
    mkdirSync(aliasedStore, { recursive: true });
    for (const child of ['governed-records', 'refs']) {
      const link = path.join(aliasedStore, child);
      symlinkSync(signedRuns, link, 'dir');
      const refused = await runSinterAsync([...args, '--project-root', aliasedProject], offline, work);
      expect(refused.status, refused.out).toBe(1);
      expect(refused.stderr).toContain('resolves inside scanned art');
      expect(tree(learning)).toEqual([]);
      expect(snapshot(signedRuns)).toBe(before[0]);
      rmSync(link);
    }
    const aliasedHome = path.join(work, 'aliased-home');
    mkdirSync(path.join(aliasedHome, '.sinter'), { recursive: true });
    symlinkSync(signedRuns, path.join(aliasedHome, '.sinter', 'lineage'), 'dir');
    const refusedLineage = await runSinterAsync([...args, '--home', aliasedHome], offline, work);
    expect(refusedLineage.status, refusedLineage.out).toBe(1);
    expect(refusedLineage.stderr).toContain('resolves inside scanned art');
    expect(snapshot(signedRuns)).toBe(before[0]);
    expect(tree(learning)).toEqual([]);
    const accepted = await runSinterAsync(args, offline, work);
    expect(accepted.status, accepted.out).toBe(0);
    expect(report(accepted.stdout).organs.archive.written).toBe(1);
    expect(report(accepted.stdout).organs.gallery.written).toBe(1);
    expect(tree(target).some(file => file.endsWith('governed-best.json'))).toBe(true);
    const lineageDir = path.join(home, '.sinter', 'lineage');
    const firstLineage = snapshot(lineageDir);
    const otherProject = path.join(work, 'second-project');
    const otherHome = path.join(work, 'second-home');
    const [galleryProject] = readdirSync(path.join(target, 'gallery'));
    const galleryVersion = path.join(otherProject, 'gallery', galleryProject, 'v1.js');
    mkdirSync(galleryVersion, { recursive: true });
    const incomplete = await runSinterAsync([...args, '--project-root', otherProject], offline, work);
    expect(incomplete.status, incomplete.out).toBe(2);
    expect(report(incomplete.stdout).organs.gallery.failed).toBe(1);
    expect(report(incomplete.stdout).organs.archive.written).toBe(1);
    rmSync(galleryVersion, { recursive: true });
    const secondProject = await runSinterAsync([...args, '--project-root', otherProject], offline, work);
    expect(secondProject.status, secondProject.out).toBe(0);
    expect(report(secondProject.stdout).organs.archive.alreadyDone).toBe(1);
    expect(report(secondProject.stdout).organs.gallery.written).toBe(1);
    const listed = await runSinterAsync(['gallery', 'list'], { ...offline, SINTER_PROJECT_ROOT: otherProject }, work);
    expect(listed.out).toContain(galleryProject);
    expect(snapshot(lineageDir)).toBe(firstLineage);
    expect(tree(otherHome)).toEqual([]);
    const secondHome = await runSinterAsync([...args, '--home', otherHome], offline, work);
    expect(secondHome.status, secondHome.out).toBe(0);
    expect(report(secondHome.stdout).organs.fitness.written).toBe(1);
    expect(report(secondHome.stdout).organs.lineage.written).toBe(1);
    expect(report(secondHome.stdout).organs.archive.alreadyDone).toBe(1);
    expect(tree(path.join(otherHome, '.sinter', 'lineage'))).toHaveLength(1);
    expect(tree(otherHome).some(file => file.endsWith('fitness-observations.jsonl'))).toBe(true);
    const promptHoldout = path.join(work, 'prompt-only-holdout.txt');
    writeFileSync(promptHoldout, 'unbound-prompt-id\n');
    const promptPreview = await runSinterAsync([...args, '--dry-run', '--holdout-prompts', promptHoldout], offline, work);
    expect(promptPreview.status, promptPreview.out).toBe(0);
    expect(report(promptPreview.stdout).organs.archive).toMatchObject({ wouldWrite: 0, alreadyDone: 0 });
    const sourceHoldout = path.join(work, 'source-holdout.txt');
    writeFileSync(sourceHoldout, sha(readFileSync(source, 'utf8')) + '\n');
    const held = await runSinterAsync([...args, '--dry-run', '--holdout-files', sourceHoldout], offline, work);
    expect(held.status, held.out).toBe(0);
    expect(report(held.stdout).organs.archive).toMatchObject({ wouldWrite: 0, alreadyDone: 0 });
    writeFileSync(source, LIVELY_HTML + '<!-- changed after the receipt -->');
    const rejected = await runSinterAsync([...args, '--dry-run'], env, work);
    expect(rejected.status, rejected.out).toBe(0);
    expect(report(rejected.stdout).organs.archive).toMatchObject({ wouldWrite: 0, alreadyDone: 0 });
    expect(fake.calls).toHaveLength(beforeDigest);
  });
});
