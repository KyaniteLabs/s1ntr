import { describe, it, expect, vi } from 'vitest';
import {
  normalizeRegressionDomain,
  runGenerationRegression,
  inferRegressionBaseUrl,
} from '../../../src/quality/GenerationRegressionHarness.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SVGGenerator } from '../../../src/generators/svg/SVGGenerator.js';

describe('GenerationRegressionHarness', () => {
  it('keeps the HyperFrames engine available through the public API', async () => {
    const api = await import('../../../src/index.js');
    const { HyperFramesGenerator } = await import('../../../src/generators/hyperframes/HyperFramesGenerator.js');
    expect(api.HyperFramesGenerator).toBe(HyperFramesGenerator);
  });

  it('rejects a retired domain at the CLI before resolving a provider', () => {
    const script = fileURLToPath(new URL('../../../scripts/quality/generate-wrap-evaluate.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, 'fixture', 'fixture', 'revideo'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported regression domain: revideo');
  });

  it('saves the SVG generator output as a vector artifact', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>';
    const generate = vi.spyOn(SVGGenerator.prototype, 'generate').mockResolvedValue(svg);
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'svg-regression-'));
    try {
      const result = await runGenerationRegression({ domain: 'svg', provider: 'ollama', model: 'fixture', outputRoot });
      expect(path.basename(result.rawArtifactPath)).toBe('raw.svg');
      expect(readFileSync(result.rawArtifactPath, 'utf8')).toBe(svg);
    } finally {
      generate.mockRestore();
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  describe('normalizeRegressionDomain', () => {
    it('rejects retired export engines', () => {
      for (const engine of ['revideo', 'hyperframes']) {
        expect(() => normalizeRegressionDomain(engine)).toThrow(/unsupported regression domain/i);
      }
    });

    it('preserves all valid domains', () => {
      const domains = ['p5', 'glsl', 'three', 'strudel', 'hydra', 'tone', 'html', 'ascii', 'svg'] as const;
      domains.forEach((d) => {
        expect(normalizeRegressionDomain(d)).toBe(d);
      });
    });
  });

  describe('inferRegressionBaseUrl', () => {
    it('infers LM Studio base URL', () => {
      expect(inferRegressionBaseUrl('lmstudio')).toBe('http://localhost:1234/v1');
    });

    it('infers Ollama base URL', () => {
      expect(inferRegressionBaseUrl('ollama')).toBe('http://localhost:11434');
    });

    it('infers MiniMax base URL', () => {
      expect(inferRegressionBaseUrl('minimax')).toBe('https://api.minimax.io/anthropic');
    });

    it('infers GLM base URL', () => {
      expect(inferRegressionBaseUrl('glm')).toBe('https://api.z.ai/api/anthropic');
    });

    it('infers Kimi base URL', () => {
      expect(inferRegressionBaseUrl('kimi')).toBe('https://api.kimi.com/coding/v1');
    });

    it('prefers explicit base URL over provider default', () => {
      expect(inferRegressionBaseUrl('lmstudio', 'http://custom:9999/v1')).toBe('http://custom:9999/v1');
    });

    it('prefers explicit base URL even for unknown provider', () => {
      expect(inferRegressionBaseUrl('unknown-provider', 'http://custom:8080')).toBe('http://custom:8080');
    });

    it('throws for unknown provider without explicit base URL', () => {
      expect(() => inferRegressionBaseUrl('nonexistent-provider')).toThrow('Unknown provider');
    });
  });
});
