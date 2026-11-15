import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRotator } from '../../../src/atelier/ModelRotator.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('ModelRotator eligibility', () => {
  it('skips stale lanes and does not advance when every lane is held', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-rotation-'));
    roots.push(root);
    const prompts = join(root, '.omx', 'atelier', 'prompts');
    mkdirSync(prompts, { recursive: true });
    const host = hostname();
    writeFileSync(join(prompts, 'model-rotation.json'), JSON.stringify({ local: { hostname: host, models: [
      { id: 'stale', provider: 'openai', base: 'https://old.example/v1' },
      { id: 'glm-5.3', provider: 'anthropic', base: 'https://api.z.ai/api/anthropic' },
    ] } }));
    const rotator = new ModelRotator(root);
    expect(rotator.nextEligible(new Set())).toBeNull();
    expect(() => readFileSync(join(prompts, 'rotation-state.json'))).toThrow();
    expect(rotator.nextEligible(new Set(['glm-5.3|https://api.z.ai/api/anthropic']))?.modelId).toBe('glm-5.3');
    expect(JSON.parse(readFileSync(join(prompts, 'rotation-state.json'), 'utf8')).waveCount).toBe(1);
  });

  it('drops matrix entries that have no model id or provider', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-rotation-'));
    roots.push(root);
    const prompts = join(root, '.omx', 'atelier', 'prompts');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, 'model-rotation.json'), JSON.stringify({ local: { hostname: hostname(), models: [
      { provider: 'openai', base: 'https://no-id.example/v1' },
      { id: 'no-provider', base: 'https://no-provider.example/v1' },
      { modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' },
    ] } }));
    expect(new ModelRotator(root).lanes()).toEqual([{
      modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic',
      note: undefined, dispatchExecutor: undefined,
    }]);
  });

  it('yields no lanes when the matrix file is not valid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-rotation-'));
    roots.push(root);
    const prompts = join(root, '.omx', 'atelier', 'prompts');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, 'model-rotation.json'), '{not json');
    expect(new ModelRotator(root).lanes()).toEqual([]);
  });
});
