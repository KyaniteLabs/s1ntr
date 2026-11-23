/**
 * Group C proofs for errors, constants, utils and shared through the REAL spawned binary.
 * Each failing run must exit non-zero with a plain operator-facing message (no stack trace as the verdict).
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { P5_CDN } from '../../src/constants/index.js';
import { formatMicCaptureError } from '../../src/shared/micPermission.js';
import { ConfigError } from '../../src/errors/index.js';

vi.setConfig({ testTimeout: 280_000 });
let work: string; let fake: FakeProvider;
let failing: { url: string; mode: { v: '401' | 'junk' }; close: () => Promise<void> };
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'organ-err-c-'));
  fake = await startFakeProvider();
  const mode = { v: '401' as '401' | 'junk' };
  const srv = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/models')) return res.end('{"data":[]}');
      if (mode.v === '401') { res.statusCode = 401; return res.end('{"error":{"message":"bad key"}}'); }
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'I cannot help with that.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  failing = { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, mode,
    close: () => new Promise<void>(r => { srv.close(() => r()); srv.closeAllConnections?.(); }) };
});
afterAll(async () => { await fake.close(); await failing.close(); rmSync(work, { recursive: true, force: true }); });

const envFor = (n: string, extra: NodeJS.ProcessEnv = {}) => ({
  ...fakeProviderEnv(fake, { home: path.join(work, `h-${n}`), stateRoot: path.join(work, `s-${n}`) }),
  LIMINAL_LLM_BASE_URL: failing.url, ...extra,
});
const gen = (n: string, domain = 'html') => ['generate', '-o', path.join(work, `o-${n}`), '--domain', domain, 'a quiet harbor'];
const lastLine = (out: string) => out.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';

describe('errors: each failure class exits non-zero with a plain message', () => {
  it('missing key (config)', async () => {
    const env = { ...envFor('nokey') }; delete env.LIMINAL_LLM_API_KEY; delete env.LIMINAL_LLM_BASE_URL; delete env.LIMINAL_LLM_MODEL;
    const r = await runSinterAsync(gen('nokey'), env);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Missing API key for \w+\. Set \w+_API_KEY or run: sinter provider set-key/);
  });
  it('provider rejects the key (LLM generation error)', async () => {
    failing.mode.v = '401';
    const r = await runSinterAsync(gen('401'), envFor('401'));
    expect(r.status).toBe(1);
    expect(lastLine(r.out)).toMatch(/^.*Error: LLM generation failed: OpenAI API error 401/);
  });
  it('model returns prose, not a piece (validation error)', async () => {
    failing.mode.v = 'junk';
    const r = await runSinterAsync(gen('junk'), envFor('junk'));
    expect(r.status).toBe(1);
    expect(lastLine(r.out)).toMatch(/Error: LIMINAL_GENERATION_INVALID:html:HTML document must start with/);
  });
  it('unknown medium (validation error naming the valid ones)', async () => {
    const r = await runSinterAsync(gen('bogus', 'bogusmedium'), envFor('bogus'));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--domain "bogusmedium" is not available for generate\. Valid: p5, three/);
  });
  it('corrupt user config file (persistence error) names the file and the parse problem', async () => {
    const home = path.join(work, 'h-corrupt'); mkdirSync(path.join(home, '.sinter'), { recursive: true });
    writeFileSync(path.join(home, '.sinter', 'config.json'), '{ not json');
    const r = await runSinterAsync(gen('corrupt'), { ...envFor('corrupt'), HOME: home });
    expect(r.status).toBe(1);
    expect(lastLine(r.out)).toMatch(/^Error: USER_CONFIG_INVALID: .*config\.json: Expected property name/);
  });
  it('typed errors carry their code (ConfigError)', () => {
    const e = new ConfigError('bad', 'k');
    expect(e).toBeInstanceOf(Error); expect(e.code).toMatch(/^ERR_/);
  });
});

describe('constants + utils + shared: used through the spawned CLI', () => {
  it('constants: the p5 CDN constant is the script the generated page loads', async () => {
    const p5 = await startFakeProvider({ generate: () => 'function setup(){createCanvas(400,400);}\nfunction draw(){background(20);circle(200,200,100);}' + '\n// pad '.repeat(30) });
    try {
      const out = path.join(work, 'o-p5');
      await runSinterAsync(['generate', '-o', out, '--domain', 'p5', 'a quiet harbor'], fakeProviderEnv(p5, { home: path.join(work, 'h-p5'), stateRoot: path.join(work, 's-p5') }));
      const files: string[] = []; const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
      walk(out);
      expect(files.some(f => /\.html?$/.test(f) && readFileSync(f, 'utf8').includes(P5_CDN)), files.join(',')).toBe(true);
    } finally { await p5.close(); }
  });
  it('utils/Logger + atomicWrite: log level changes what the binary prints; output lands with no temp leftovers', async () => {
    const base = fakeProviderEnv(fake, { home: path.join(work, 'h-log'), stateRoot: path.join(work, 's-log') });
    const quiet = await runSinterAsync(gen('log-q'), { ...base, LIMINAL_LOG_LEVEL: 'warn' });
    const loud = await runSinterAsync(gen('log-l'), { ...base, LIMINAL_LOG_LEVEL: 'debug', HOME: path.join(work, 'h-log2'), SINTER_LIMINAL_RUNTIME_ROOT: path.join(work, 's-log2') });
    const tagged = (o: string) => o.split('\n').filter(l => /^\[[A-Za-z]+\] /.test(l) && !l.startsWith('[CLI]')).length;
    expect(tagged(loud.out)).toBeGreaterThan(tagged(quiet.out));
    expect(quiet.out).not.toMatch(/PromptHistory\] Failed to load history/); // first run, no history file: silent
    const names = readdirSync(path.join(work, 'o-log-l'), { recursive: true }).map(String);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(n => /\.tmp|\.partial|~$/.test(n))).toEqual([]);
  });
  it('shared/micPermission: the plain message the bridge shows when the mic is denied', () => {
    expect(formatMicCaptureError(new Error('Permission denied'))).not.toMatch(/\bat \w+.*\.ts/);
    expect(formatMicCaptureError(new Error('Permission denied'))).not.toBe(formatMicCaptureError(new Error('other thing')));
  });
});
