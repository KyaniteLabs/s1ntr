import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('bin/sinter');
const built = existsSync(resolve('dist/cli/LiminalProductionGenerate.js'));

// `best-of` re-invoked each child with only the prompt and --domain, so tournament
// pieces ran untaught and ignored --max-provider-calls and -o. This runs the REAL
// spawned path (parent -> real child CLI). An invalid --teach scope makes the child
// fail in parseTeachScope before any provider call, so the child's own stderr proves
// it received the flag; no transport is touched.
describe.skipIf(!built)('sinter best-of forwards generation flags to its children', () => {
  it('delivers --teach, --max-provider-calls and a per-variant -o to a real child', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'best-of-fwd-'));
    const out = join(cwd, 'out');
    const run = spawnSync('node', [cli, 'best-of', '2', 'fixture prompt', '--teach', 'bogus-scope',
      '--max-provider-calls', '1', '-o', out], {
      cwd, encoding: 'utf8', timeout: 120000,
      // Default-seat guard: no config and no credentials, so even a fall-through cannot reach a provider.
      env: { ...process.env, HOME: cwd, SINTER_CONFIG_PATH: join(cwd, 'no-default-seat.json'),
        MINIMAX_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '' },
    });
    const text = `${run.stdout}${run.stderr}`;
    expect(text).toContain('Error: --teach requires one of: visual, motion (got "bogus-scope")');
    // Both variants' children received --teach (each failed on it, not on a provider).
    expect(text.match(/Error: --teach requires one of/g)?.length).toBeGreaterThanOrEqual(2);
    expect(run.status).toBe(4);
  }, 150000);
});

// Observable, log-independent proof for the other two flags, against a FAKE local provider
// (no real seat: HOME + SINTER_CONFIG_PATH point at a throwaway config whose every role is the
// fake server). One governed generation makes 2 transport attempts when uncapped (create +
// evaluate); with --max-provider-calls 1 a child stops after exactly 1 and exits with
// TRANSPORT_ATTEMPT_CAP_EXHAUSTED. So N=2 children capped at 1 produce exactly 2 requests
// server-side (4 if the cap were dropped), and each variant's artifacts land under its own -o.
describe.skipIf(!built)('sinter best-of --max-provider-calls and -o reach each child (fake provider)', () => {
  it('caps every child at one provider call and gives each variant its own output dir', async () => {
    const posts: string[] = [];
    const code = 'let t=0;\nfunction setup(){createCanvas(400,400);noStroke();}\n'
      + 'function draw(){background(20);t+=0.02;for(let i=0;i<12;i++){fill(120+i*10,80,200-i*8);'
      + 'circle(200+cos(t+i)*120,200+sin(t*1.3+i)*120,30+i*3);}}';
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST') posts.push(String(req.url));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'gpt-4o',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '```js\n' + code + '\n```' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    try {
      const port = (server.address() as AddressInfo).port;
      const home = mkdtempSync(join(tmpdir(), 'best-of-cap-'));
      const out = join(home, 'out');
      const seat = { provider: 'openai', model: 'gpt-4o', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fake' };
      const configPath = join(home, 'config.json');
      writeFileSync(configPath, JSON.stringify({ roles: { generator: seat, evaluator: seat, harness: seat }, providers: {}, fallbacks: {} }));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SINTER_CONFIG_PATH: configPath,
        LIMINAL_ALLOW_LOCALHOST_LLM: 'true', LIMINAL_ALLOW_LOCALHOST: 'true',
        MINIMAX_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GLM_API_KEY: '', ZAI_API_KEY: '' };
      delete env.VITEST; delete env.NODE_ENV; // the test runner's markers change CLI behavior
      await new Promise<void>(done => {
        const child = spawn('node', [cli, 'best-of', '2', 'fake provider prompt', '--domain', 'p5',
          '--max-provider-calls', '1', '-o', out], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.resume(); child.stderr.resume();
        child.on('close', () => done());
      });
      expect(posts).toHaveLength(2);
      for (const v of ['variant-1', 'variant-2']) {
        expect(existsSync(join(out, v, 'artifacts')), `${v} artifacts dir`).toBe(true);
      }
    } finally {
      server.close();
    }
  }, 280000);
});
