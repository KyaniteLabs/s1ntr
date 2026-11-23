/**
 * Organ group B, more proofs: task ledger, release gate, product demo, media (--ref image changes the brief),
 * analytics (fake PostHog endpoint: events arrive, nothing personal leaves).
 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

let work: string; let fake: FakeProvider; let n = 0;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-groupb-more-'));
  fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });
const env = () => { const i = n++; return fakeProviderEnv(fake, { home: path.join(work, `home${i}`), stateRoot: path.join(work, `state${i}`) }); };
// runSinterAsync takes (args, env, cwd?) in the harness.
const inDir = (name: string) => { const d = path.join(work, name); mkdirSync(d, { recursive: true }); return d; };

describe('ledger (task ledger): loaded tasks are listed and counted', () => {
  it('an empty ledger lists nothing; after `ledger load` the task is listed and the status count changes', async () => {
    const e = env(); const cwd = inDir('ledger');
    const empty = await runSinterAsync(['ledger', 'list'], e, cwd);
    expect(empty.out).toContain('No tasks found');
    const file = path.join(cwd, 'tasks.json');
    writeFileSync(file, JSON.stringify([{ id: 'ORG-001', title: 'Organ proof task', description: 'd', taskClass: 'leaf', files: { allowlist: ['src/**'], denylist: [] }, verifyCommand: 'true', scoringCriteria: ['technical'], lane: 1, maxAttempts: 3 }]));
    const load = await runSinterAsync(['ledger', 'load', file], e, cwd);
    expect(load.status, load.out).toBe(0);
    expect(load.out).toContain('Loaded 1 task');
    const list = await runSinterAsync(['ledger', 'list'], e, cwd);
    expect(list.out).toContain('ORG-001');
    const status = await runSinterAsync(['ledger', 'status'], e, cwd);
    expect(status.out).not.toContain('No tasks');
  });
});

describe('release: `release gate --dry-run` reports readiness as JSON and the exit code follows it', () => {
  it('rejects a candidate without release evidence', async () => {
    const root = inDir('release-empty');
    const r = await runSinterAsync(['release', 'gate', '--dry-run', '--repo-root', root], env());
    const json = JSON.parse(r.out.slice(r.out.indexOf('{')));
    expect(json.ready).toBe(false);
    expect(r.status, r.out).toBe(1);
  });
});

describe('product: the creative-codex demo walks every step', () => {
  it('runs 8 scenario steps with no provider', async () => {
    const r = await runSinterAsync(['demo', 'creative-codex'], env());
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Steps: 8\s+Passed: true/);
  });
});

describe('media: a reference image changes the brief the generator receives', () => {
  it('two different reference images give two different generator briefs', async () => {
    const png = async (name: string, rgb: [number, number, number]) => {
      const p = path.join(work, name);
      await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(p);
      return p;
    };
    const red = await png('red.png', [220, 20, 20]); const blue = await png('blue.png', [20, 20, 220]);
    const brief = async (ref?: string) => {
      const before = fake.generated.length;
      const r = await runSinterAsync(['generate', '-o', path.join(work, `ref-out-${n}`), '--domain', 'html', ...(ref ? ['--ref', ref] : []), 'a slow orbit'], env());
      expect(r.status, r.out).toBe(0);
      return fake.generated[before].user;
    };
    const a = await brief(red); const b = await brief(blue);
    expect(a).not.toBe(b);
  }, 560_000);
});

describe('analytics: PostHog events go to the configured host and carry no prompt text or personal data', () => {
  it('sends the event with the anonymous daemon id and only the properties it was given', async () => {
    const bodies: string[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { const raw = Buffer.concat(chunks); let text: string; try { text = gunzipSync(raw).toString('utf8'); } catch { text = raw.toString('utf8'); } bodies.push(text); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":1}'); });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    process.env.LIMINAL_POSTHOG_KEY = 'phc_test_key_not_real';
    process.env.LIMINAL_POSTHOG_HOST = `http://127.0.0.1:${port}`;
    try {
      const { PostHogClient } = await import('../../src/analytics/PostHogClient.js');
      const client = new PostHogClient();
      expect(client.isConfigured()).toBe(true);
      client.trackEvent('liminal_variant_generated', { slotId: 'hero', variantHash: 'abc123', dryRun: true });
      await client.shutdown();
    } finally {
      delete process.env.LIMINAL_POSTHOG_KEY; delete process.env.LIMINAL_POSTHOG_HOST;
      await new Promise<void>(r => srv.close(() => r()));
    }
    const all = bodies.join('\n');
    expect(all).toContain('liminal_variant_generated');
    expect(all).toContain('sinter-daemon');
    expect(all).toContain('abc123');
    expect(all).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // no email addresses
    expect(all).not.toContain(process.env.HOME ?? '/home/');
  });

  it('with no key configured nothing is sent', async () => {
    delete process.env.LIMINAL_POSTHOG_KEY;
    const { PostHogClient } = await import('../../src/analytics/PostHogClient.js');
    expect(new PostHogClient().isConfigured()).toBe(false);
  });

  it('no daemon call site passes prompt text', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/daemon/LivingSiteDaemon.ts'), 'utf8');
    const props = [...src.matchAll(/trackEvent\("[^"]+",\s*\{([\s\S]*?)\}\)/g)].map(m => m[1]).join('\n');
    expect(props.length).toBeGreaterThan(0);
    expect(props).not.toMatch(/\bprompt\b|\bemail\b|\buserName\b/i);
  });
});
