import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');

const TRACE_PREFIX = 'SINTER_TRACE_MODULE_LOADS=';
const PURE_COMMAND_FORBIDDEN_MODULES = ['src/index', 'puppeteer', 'Renderer', 'PreviewServer', 'LLMClient'];

function parseModuleTrace(stderr: string): string[] {
  const traceLine = stderr.split('\n').find(line => line.startsWith(TRACE_PREFIX));
  if (!traceLine) throw new Error(`Missing ${TRACE_PREFIX} diagnostic`);
  return JSON.parse(traceLine.slice(TRACE_PREFIX.length));
}
describe('sinter CLI error handling', () => {
  it('names unknown top-level flags', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, '--bogus-flag-vz31'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
        },
      });
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain('Unknown option: --bogus-flag-vz31');
      expect(err.stderr).toContain('Run "sinter --help" for usage');
    }
  });

  it.each([
    ['--max-iterations', 'abc', '--max-iterations', 'positive integer'],
    ['-m', '-5', '--max-iterations', 'positive integer'],
    ['--swarm-rounds', '1.5', '--swarm-rounds', 'positive integer'],
    ['--slots', '0', '--slots', 'positive integer'],
    ['--interval', 'Infinity', '--interval', 'positive integer'],
    ['--confidence-threshold', '1.01', '--confidence-threshold', '0 to 1'],
    ['--magnitude', 'NaN', '--magnitude', '0 to 1'],
  ])('rejects invalid numeric flag %s=%s', async (flag, value, displayedFlag, acceptedForm) => {
    try {
      await execFileAsync(process.execPath, [binPath, flag, value, '--help'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
        },
      });
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain(displayedFlag);
      expect(err.stderr).toContain(acceptedForm);
    }
  });

  it.each([
    '--max-iterations',
    '--swarm-rounds',
    '--slots',
    '--interval',
    '--confidence-threshold',
    '--magnitude',
  ])('rejects a missing value for %s', async (flag) => {
    try {
      await execFileAsync(process.execPath, [binPath, flag], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
        },
      });
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain(flag);
    }
  });

  it.each([
    ['--max-iterations', '1'],
    ['--swarm-rounds', '1'],
    ['--slots', '1'],
    ['--interval', '1'],
    ['--confidence-threshold', '0'],
    ['--confidence-threshold', '1'],
    ['--magnitude', '0'],
    ['--magnitude', '1'],
  ])('accepts numeric boundary %s=%s', async (flag, value) => {
    const { stderr } = await execFileAsync(process.execPath, [binPath, flag, value, '--help'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOTENV_CONFIG_QUIET: 'true',
      },
    });

    expect(stderr).not.toContain(`Invalid value for ${flag}`);
  });

  it('rejects unknown generate providers before generation starts', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-bad-provider-home-'));
    try {
      await execFileAsync(
        process.execPath,
        [binPath, 'generate', 'qa provider typo should not run', '--provider', 'bogus-verifier-x7t2m9', '--max-iterations', '1'],
        {
          cwd: repoRoot,
          timeout: 8_000,
          env: scrubProviderEnv({
            ...process.env,
            HOME: home,
            NODE_ENV: 'test',
            DOTENV_CONFIG_QUIET: 'true',
          }),
        },
      );
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(`${err.stdout}\n${err.stderr}`).not.toContain('Generating:');
      expect(err.stderr).toContain('Unknown --provider "bogus-verifier-x7t2m9"');
      expect(err.stderr).toContain('Valid providers:');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 10_000);

  it('rejects mutable provider overrides before generation starts', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-missing-key-home-'));
    try {
      await execFileAsync(
        process.execPath,
        [binPath, 'generate', 'qa missing key should not call network', '--provider', 'glm', '--max-iterations', '1'],
        {
          cwd: repoRoot,
          timeout: 8_000,
          env: scrubProviderEnv({
            ...process.env,
            HOME: home,
            NODE_ENV: 'test',
            DOTENV_CONFIG_QUIET: 'true',
          }),
        },
      );
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(`${err.stdout}\n${err.stderr}`).not.toContain('Generating:');
      expect(err.stderr).toContain('GOVERNED_GENERATE_FLAGS_UNSUPPORTED');
      expect(err.stderr).toContain('--provider/--model/--base-url/--api-key');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails closed when provider status reads a corrupt user config', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-corrupt-config-home-'));
    const configPath = path.join(home, '.sinter', 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{"providers": {oops', 'utf-8');

    try {
      const failure = await execFileAsync(process.execPath, [binPath, 'provider', 'status'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
        },
      }).then(() => null, (error: { code?: number; stdout?: string; stderr?: string }) => error);

      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain(`${configPath} is not valid JSON`);
      expect(failure?.stderr).toContain('Refusing to run with defaults');
      expect(String(failure?.stdout ?? '')).not.toContain('Sinter provider readiness:');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('rejects non-numeric serve ports without creating a socket path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-bad-port-cwd-'));
    const badPort = 'verifyport-x7q3';
    try {
      await execFileAsync(process.execPath, [binPath, 'serve', badPort], {
        cwd,
        timeout: 8_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
        },
      });
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain(`Invalid port: ${badPort}`);
      expect(err.stderr).toContain('Use a number from 0 to 65535');
      await expect(fs.stat(path.join(cwd, badPort))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  it('handles database/filesystem failures in preferences command gracefully without stack trace', async () => {
    // Create a temp file to act as a blocked project root directory
    const tempFile = path.join(repoRoot, 'test-sinter-blocked-root');
    await fs.writeFile(tempFile, 'dummy content');

    try {
      await execFileAsync(process.execPath, [binPath, 'preferences', 'stats'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          SINTER_PROJECT_ROOT: tempFile,
        },
      });
      // Should have failed
      expect.fail('Expected command to fail');
    } catch (err: any) {
      // It should have failed with exit code 1
      expect(err.code).toBe(1);
      // It should print a clean Error: message without a raw stack trace
      expect(err.stderr).toContain('Error:');
      expect(err.stderr).not.toContain('at Module._resolveFilename');
      expect(err.stderr).not.toContain('at Object.<anonymous>');
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  });

  it('handles uncaught exceptions/rejections gracefully at the process level', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'self-improve', 'gauntlet'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          // Force import failure by passing a non-existent path as root or other mock settings
          // (runSelfImprovementGauntlet dynamically imports and will fail if files/modules are not resolved)
          SINTER_PROJECT_ROOT: '/non-existent-path-to-force-failure',
        },
      });
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain('Error:');
      expect(err.stderr).not.toContain('at Module._resolveFilename');
    }
  });
});

describe('sinter CLI lazy pure-command imports', () => {
  it.each([
    { name: 'list', args: ['list'] },
    { name: '--recent', args: ['--recent', '1'] },
    { name: '--favorites', args: ['--favorites'] },
    { name: 'fs artifacts', args: ['fs', 'artifacts'] },
  ])('$name bypasses generation runtime modules', async ({ args }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-lazy-cli-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-lazy-cli-cwd-'));
    try {
      const { stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
          SINTER_TRACE_MODULE_LOADS: '1',
        },
      });

      const trace = parseModuleTrace(stderr);
      for (const forbidden of PURE_COMMAND_FORBIDDEN_MODULES) {
        expect(trace.some(modulePath => modulePath.includes(forbidden))).toBe(false);
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('generation commands still load runtime dependencies', async () => {
    try {
      await execFileAsync(process.execPath, [binPath, 'generate', 'trace runtime imports', '--provider', 'bogus-trace-provider'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
          SINTER_TRACE_MODULE_LOADS: '1',
        },
      });
      expect.fail('Expected command to fail');
    } catch (err: any) {
      expect(err.stderr).toContain(`${TRACE_PREFIX}[`);
      expect(err.stderr).toContain('better-sqlite3');
    }
  });
});

function scrubProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'GLM_API_KEY',
    'MINIMAX_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'KIMI_API_KEY',
    'MOONSHOT_API_KEY',
    'LIMINAL_LLM_API_KEY',
    'SINTER_LLM_API_KEY',
    'LIMINAL_LLM_BASE_URL',
    'SINTER_LLM_BASE_URL',
    'LIMINAL_LLM_PROVIDER',
    'SINTER_LLM_PROVIDER',
  ]) {
    delete copy[key];
  }
  return copy;
}
