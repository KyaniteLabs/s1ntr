import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRescueCommand } from '../../../src/cli/RescueCli.js';

const GOOD_P5 = 'function setup() {\n  createCanvas(400, 400);\n}\nfunction draw() {\n  background(20);\n  noStroke();\n  fill(255, 120, 40);\n  ellipse(200, 200, 80, 80);\n  fill(40, 120, 255);\n  rect(100, 100, 60, 60);\n}\n';
const BROKEN_P5 = 'function setup() {\n  createCanvas(400, 400);\n  background(20;\n';

describe('runRescueCommand', () => {
  let dir: string;
  let home: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rescue-cli-'));
    home = mkdtempSync(join(tmpdir(), 'rescue-home-'));
    logs = [];
    errors = [];
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function pool(files: Record<string, string>): string {
    const p = join(dir, 'rejects');
    mkdirSync(p, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(p, name), body);
    return p;
  }

  it('exits 1 with a usage line when the rejects path does not exist', async () => {
    const missing = join(dir, 'nope');
    await expect(runRescueCommand([missing])).rejects.toThrow('exit:1');
    expect(errors).toEqual([`usage: sinter rescue <rejects-dir|file> [--no-llm] — no such path: ${missing}`]);
  });

  it('classifies a pool mechanically with --no-llm and writes the report without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = pool({
      'a-good.js': GOOD_P5,
      'b-fenced.txt': '```js\n' + GOOD_P5 + '```\n',
      'c-empty.js': '   \n',
      'd-broken.js': BROKEN_P5,
    });
    await runRescueCommand([p, '--no-llm']);

    expect(fetchMock).not.toHaveBeenCalled();
    const byFile = (name: string) => logs.find(l => l.startsWith(name)) ?? '';
    expect(byFile('a-good.js')).toMatch(/^a-good\.js\s+p5\s+false-kill\s+— saved at raw$/);
    expect(byFile('b-fenced.txt')).toMatch(/^b-fenced\.txt\s+p5\s+false-kill\s+— saved at raw$/);
    expect(byFile('c-empty.js')).toMatch(/^c-empty\.js\s+p5\s+no-code\s+— empty$/);
    expect(byFile('d-broken.js')).toMatch(/^d-broken\.js\s+p5\s+genuinely-dead\s+— /);
    expect(logs).toContain('\npool=4  false-kill=2  recovered=0  llm-salvage=0  dead=1  no-code=1');
    expect(logs).toContain('FALSE-KILL RATE (salvageable share of rejects): 50% — genuinely-dead share 50%');

    const reportPath = join(p, 'rescue', 'rescue-report.json');
    expect(logs[logs.length - 1]).toBe(`\nsalvaged code + full report: ${reportPath}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.total).toBe(4);
    expect(report.falseKillRate).toBe(0.5);
    expect(existsSync(join(p, 'rescue', 'a-good.false-kill.js'))).toBe(true);
    expect(existsSync(join(p, 'rescue', 'd-broken.genuinely-dead.js'))).toBe(false);
  });

  it('accepts a single reject file as a pool of one', async () => {
    const p = pool({ 'only.js': GOOD_P5, 'ignored.js': BROKEN_P5 });
    await runRescueCommand([join(p, 'only.js'), '--no-llm']);
    expect(logs).toContain('\npool=1  false-kill=1  recovered=0  llm-salvage=0  dead=0  no-code=0');
  });

  it('attempts one LLM repair through the configured seat (fetch stubbed) and counts the salvage', async () => {
    mkdirSync(join(home, '.sinter'), { recursive: true });
    writeFileSync(join(home, '.sinter', 'config.json'), JSON.stringify({
      roles: { harness: { baseUrl: 'https://llm.example.invalid/v1', model: 'test-model', apiKey: 'k' } },
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ choices: [{ message: { content: GOOD_P5 } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = pool({ 'broken.js': BROKEN_P5 });
    await runRescueCommand([p]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.invalid/v1/chat/completions');
    expect(logs).toContain('\npool=1  false-kill=0  recovered=0  llm-salvage=1  dead=0  no-code=0');
  });

  it('leaves the piece dead when no seat is configured (no config file, no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = pool({ 'broken.js': BROKEN_P5 });
    await runRescueCommand([p]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toContain('\npool=1  false-kill=0  recovered=0  llm-salvage=0  dead=1  no-code=0');
  });

  it('--sweep scans failure records without the LLM when --no-llm is set', async () => {
    mkdirSync(join(home, '.sinter', 'failures'), { recursive: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runRescueCommand(['--sweep', '--no-llm']);
    expect(logs[0]).toBe('[rescue-sweep] scanned=0 salvaged=0 dead=0 falseKillRate=0% skipped=0');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
