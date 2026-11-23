/**
 * SECURITY NOTICE: All API keys in this file are FAKE test values.
 */

import { describe, it, expect, beforeAll, afterEach, test } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { startFakeProvider, fakeProviderEnv, runSinterAsync, goodJudgeReply, LIVELY_HTML } from '../helpers/fakeProviderServer.ts';

const cliPath = path.join(process.cwd(), 'bin/sinter');

// Sol L3-18: the LM Studio endpoint is a fake OpenAI-compatible loopback server (same pattern as the governed-Create e2e),
// so these assertions always run; nothing depends on a model being loaded on this host.

describe('CLI Integration Tests', () => {
  let testOutputDir;
  const TEST_TIMEOUT = 45000;

  beforeAll(() => {
    testOutputDir = path.join(process.cwd(), 'test-cli-output');
  });

  afterEach(async () => {
    try { await fs.rm(testOutputDir, { recursive: true, force: true }); } catch {}
  });

  describe('CLI Invocation and Flags', () => {
    test('should show help', async () => {
      const result = await runCLI(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('USAGE:');
    }, 10000);

    test('should show version', async () => {
      const result = await runCLI(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sinter');
    }, 10000);

    test('should show provider setup help without starting generation', async () => {
      const result = await runCLI(['provider', 'help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sinter Provider Setup');
      expect(result.stdout).toContain('GLM_API_KEY');
      expect(result.stdout).not.toContain('Generating: provider help');
    }, 10000);

    test('should generate against a fake LM Studio endpoint: saved files and a persisted decision', async () => {
      const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-lmstudio-'));
      try {
        const env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
        const result = await runSinterAsync(['--prompt', 'simple blue circle', '--domain', 'html', '--output', testOutputDir, '--max-iterations', '1'], env);
        if (result.status !== 0) console.log('[DEBUG]', result.out.slice(-1500));
        expect(result.status).toBe(0);
        expect(fake.generated.length).toBeGreaterThan(0);   // the model endpoint really was called
        expect(fake.judged.length).toBeGreaterThan(0);      // and judged: acceptance is not a banner
        expect(result.out).toMatch(/Signed receipt: [0-9a-f]{64}/);
        const produced = await fs.readdir(testOutputDir);
        expect(produced.length).toBeGreaterThan(0);
      } finally { await fake.close(); await fs.rm(work, { recursive: true, force: true }); }
    }, 300000);

    test('--mode live-music --prompt "ambient" --output <dir> produces files in output dir (fake endpoint)', async () => {
      const strudel = 's("bd sd").slow(2)';
      const fake = await startFakeProvider({ generate: () => strudel, judge: () => goodJudgeReply(0.8) });
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-lmstudio-'));
      try {
        const env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
        const result = await runSinterAsync(['--mode', 'live-music', '--prompt', 'ambient', '--output', testOutputDir], env);
        if (result.status !== 0) console.log('[DEBUG]', result.out.slice(-1500));
        expect(result.status).toBe(0);
        expect(fake.generated.length).toBeGreaterThan(0);
        expect(result.out).toMatch(/strudel|hydra|\.js|\.tidal/);
        const files = await fs.readdir(testOutputDir);
        expect(files.length).toBeGreaterThan(0);
        expect(files.some(f => /strudel\.(js|tidal)/i.test(f) || /hydra\.js/i.test(f))).toBe(true);
      } finally { await fake.close(); await fs.rm(work, { recursive: true, force: true }); }
    }, 300000);
  });
});

async function runCLI(args) {
  return new Promise((resolve) => {
    const cliProcess = spawn('node', [cliPath, ...args], {
      env: {
        ...process.env,
        // Provider is no longer used - baseUrl + model is all that's needed
        LIMINAL_LLM_BASE_URL: 'http://localhost:1234/v1',
        LIMINAL_LLM_MODEL: 'qwen3.5-9b'  // Use actual model name from LM Studio
      }
    });
    let stdout = '';
    let stderr = '';
    cliProcess.stdout.on('data', (d) => stdout += d);
    cliProcess.stderr.on('data', (d) => stderr += d);
    cliProcess.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    setTimeout(() => { cliProcess.kill(); resolve({ exitCode: -1, stdout, stderr: 'timeout' }); }, 45000);
  });
}
