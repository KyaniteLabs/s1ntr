import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Governed `sinter generate --domain custom`, spawned for real against a fake OpenAI-compatible
// provider: the model is asked for the SINTER-META-DESCRIPTOR comment, and the descriptor it
// emits reaches medium.json (the one file every run writes), so a wall card can say what medium
// S1NTR invented instead of "custom".
const repoRoot = join(import.meta.dirname, '../..');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DESCRIPTOR = {
  name: 'lsystem-fern', runtime: 'canvas', libraries: [] as string[], renderTarget: '#mount',
  notes: 'a bracketed L-system grown on a 2D canvas',
};
const PAGE = `<!--SINTER-META-DESCRIPTOR ${JSON.stringify(DESCRIPTOR)}-->
<!DOCTYPE html><html><head><meta charset="utf-8"><title>fern</title><style>html,body{margin:0;background:#111}</style></head>
<body><canvas id="mount" width="640" height="360"></canvas><script>
const c=document.getElementById('mount').getContext('2d');let t=0;
function draw(){c.fillStyle='rgba(17,17,17,.2)';c.fillRect(0,0,640,360);c.strokeStyle='hsl('+(t%360)+',70%,60%)';
c.beginPath();c.moveTo(320,360);c.lineTo(320+80*Math.sin(t/40),160);c.stroke();t++;requestAnimationFrame(draw)}draw();
</script></body></html>`;

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 170_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

describe.skipIf(!chrome)('governed custom generate (spawned CLI, fake provider)', () => {
  it('asks for the descriptor and records it in medium.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sinter-custom-desc-'));
    dirs.push(dir);
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        bodies.push(raw);
        const wantsPage = !/evaluat|judge|score/i.test(raw.slice(0, 600));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'fake', object: 'chat.completion', model: 'fake',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
            content: wantsPage ? PAGE : '{"score":0.7,"reasoning":"fake judge"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const seat = { provider: 'openai', model: 'mimo-v2.6-pro', baseUrl: `http://localhost:${port}/v1`, apiKey: 'fake-key', maxTokens: 8000 };
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ roles: { generator: seat, harness: seat, studio: seat, evaluator: seat } }), { mode: 0o600 });
    const out = join(dir, 'out');
    const env = { ...process.env, HOME: dir, SINTER_CONFIG_PATH: configPath, NODE_ENV: 'production', LIMINAL_ALLOW_LOCALHOST_LLM: 'true',
      SINTER_LIMINAL_RUNTIME_ROOT: join(dir, 'state'), PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chrome! };
    const run1 = await run(['bin/sinter', 'generate', '--domain', 'custom', '-o', out,
      '--max-provider-calls', '2', 'a fern grown by a bracketed L-system'], env);

    // the instruction reached the model
    expect(bodies.some((b) => b.includes('SINTER-META-DESCRIPTOR'))).toBe(true);
    // the descriptor survived into the artifact and into medium.json
    const artifacts = join(out, 'artifacts');
    const hash = readdirSync(artifacts)[0];
    expect(hash, `${run1.stdout}\n${run1.stderr}`).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(artifacts, hash, 'source.txt'), 'utf8')).toContain('<!--SINTER-META-DESCRIPTOR');
    const medium = JSON.parse(readFileSync(join(artifacts, hash, 'medium.json'), 'utf8'));
    expect(medium.descriptor).toEqual(DESCRIPTOR);
    expect(medium.medium_line).toContain('lsystem-fern');
    expect(medium.medium_line).not.toContain('no descriptor');
  }, 180_000);
});
