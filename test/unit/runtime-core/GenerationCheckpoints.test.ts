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

const source = `<!doctype html><html><head></head><body>
<div data-composition-id="layers"><div class="clip">Foreground</div></div>
<script>const tl = gsap.timeline({paused:true});
tl.to('.clip', {x:100,duration:2}); window.__timelines = {layers:tl};</script>
</body></html>`;
const repaired = source.replace('</head>', '<script src="/vendor/gsap/3.15.0/gsap.min.js"></script></head>');

function effectsWith(generate: ReturnType<typeof vi.fn>, checkpoints: FileGenerationCheckpointStore) {
  return createLiminalProductionEffects({
    generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
    evaluator: {} as never, renderer: {} as never,
    generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    checkpoints,
  });
}
const request = () => ({ identity: 'fake/generator', domain: 'hyperframes', prompt: 'Layered parallax',
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
    expect(second.mock.calls[0][1]).toContain('HyperFrames must load GSAP');
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
});
