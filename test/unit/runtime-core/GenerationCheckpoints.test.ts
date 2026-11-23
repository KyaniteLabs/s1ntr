import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FileGenerationCheckpointStore } from '../../../src/runtime-core/GenerationCheckpoints.js';
import { createLiminalProductionEffects } from '../../../src/runtime-core/LiminalProductionEffects.js';

vi.mock('../../../src/generators/DomainTeaching.js', () => ({ buildDomainTeaching: () => '' }));

// A premium seat spent 13.5 minutes on a first answer, then the repair call
// timed out and the whole run failed with the first answer thrown away. Each
// completed provider reply is saved before the next call; a rerun resumes.

const source = `<p>not an svg</p>`;
const repaired = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#4ee6c8"/></svg>`;

function effectsWith(generate: ReturnType<typeof vi.fn>, checkpoints: FileGenerationCheckpointStore,
  seat: Record<string, unknown> = {}) {
  return createLiminalProductionEffects({
    generator: { getConfig: () => ({ provider: 'fake', model: 'generator', ...seat }), generate } as never,
    evaluator: {} as never, renderer: {} as never,
    generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    checkpoints,
  });
}
const request = () => ({ identity: 'fake/generator', domain: 'svg', prompt: 'Layered parallax',
  startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) });

describe('generation checkpoints', () => {
  it('a failed repair keeps the first reply, and the rerun resumes from it without re-asking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    const first = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockRejectedValueOnce(new Error('cli:codex timed out after 900000 ms'));
    await expect(effectsWith(first, store).generate(request())).rejects.toThrow('timed out');
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(1);

    const second = vi.fn().mockResolvedValueOnce({ success: true, code: repaired });
    const artifact = await effectsWith(second, store).generate(request());
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][1]).toContain('svg');
    expect(artifact.source).toBe(repaired);
    expect(JSON.parse(artifact.provenance).acceptedFrom).toBe('repair');
  });

  it('clears its checkpoints once the generation succeeds, so a new run samples fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    const generate = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(generate, store).generate(request());
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('never saves a failed or empty reply, and a different prompt never reuses a checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    const generate = vi.fn().mockResolvedValue({ success: false, code: '', error: 'token cap' });
    await expect(effectsWith(generate, store).generate(request())).rejects.toThrow();
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(0);

    const saving = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockRejectedValueOnce(new Error('transport down'));
    await expect(effectsWith(saving, store).generate(request())).rejects.toThrow('transport down');
    const other = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(other, store).generate({ ...request(), prompt: 'A different brief' });
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('a corrupt checkpoint is ignored, not trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    await store.save('k', { kind: 'primary', identity: 'fake/generator', code: 'x', savedAt: 'now' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'k.json'), '{not json');
    await expect(store.load('k')).resolves.toBeNull();
  });

  // Sol G05: the same provider/model label under a changed endpoint or thinking budget is a different request.
  it.each([
    ['endpoint', { baseUrl: 'http://127.0.0.1:1111/v1' }, { baseUrl: 'http://127.0.0.1:2222/v1' }],
    ['thinking', { thinking: { enabled: true, budgetTokens: 1000 } }, { thinking: { enabled: false } }],
    ['max tokens', { maxTokens: 2000 }, { maxTokens: 9000 }],
  ])('a changed %s never reuses the old reply', async (_name, before, after) => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    const first = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockRejectedValueOnce(new Error('timed out'));
    await expect(effectsWith(first, store, before).generate(request())).rejects.toThrow('timed out');

    const second = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(second, store, after).generate(request());
    expect(second).toHaveBeenCalledTimes(2); // the primary was asked again under the new settings
  });

  it('identical settings still resume (the checkpoint feature is intact)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-ckp-'));
    const store = new FileGenerationCheckpointStore(dir);
    const seat = { baseUrl: 'http://127.0.0.1:1111/v1', maxTokens: 2000 };
    const first = vi.fn().mockResolvedValueOnce({ success: true, code: source }).mockRejectedValueOnce(new Error('timed out'));
    await expect(effectsWith(first, store, seat).generate(request())).rejects.toThrow('timed out');
    const second = vi.fn().mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(second, store, seat).generate(request());
    expect(second).toHaveBeenCalledTimes(1);
  });
});
