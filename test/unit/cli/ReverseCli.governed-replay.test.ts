/** Sol G14: replaying the journaled image read must never replay an old brief when --cues/--ref change. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const journal = new Map<string, unknown>();
let visionCalls = 0;
vi.mock('../../../src/cli/LiminalProductionProviderEffect.js', () => ({
  // Same contract as the real journal: first run executes the effect, a repeat key replays the stored result.
  runProductionCliProviderEffect: async (i: { idempotencyKey: string; effect: () => Promise<unknown> }) => {
    if (!journal.has(i.idempotencyKey)) journal.set(i.idempotencyKey, await i.effect());
    return journal.get(i.idempotencyKey);
  },
}));
vi.mock('../../../src/llm/LLMClient.js', () => ({ LLMClient: class { } }));
vi.mock('../../../src/reverse/ArcVision.js', () => ({
  MAX_ARC_IMAGE_BYTES: 10_000_000,
  deriveArcFromImageBytes: async () => {
    visionCalls += 1;
    return { arc: { sections: [{ label: 'rise', t_start: 0, t_end: 10, energy: 0.5 }], cues: [] }, source: 'vision:arc.png',
      sent: { originalWidth: 2, originalHeight: 2, width: 2, height: 2, bytes: 8 } };
  },
}));

const { prepareReverseGoverned } = await import('../../../src/cli/ReverseCli.js');

let dir = '';
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'rev-replay-')); writeFileSync(path.join(dir, 'arc.png'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ t: 2, kind: 'hit' }]));
  writeFileSync(path.join(dir, 'b.json'), JSON.stringify([{ t: 5, kind: 'drop' }])); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('prepareReverseGoverned journals only the vision read', () => {
  it('same image, two cue files: one provider read, two different briefs', async () => {
    const base = { refs: [] as string[], arcPath: path.join(dir, 'arc.png'), duration: 10 };
    const one = await prepareReverseGoverned({ ...base, cuesPath: path.join(dir, 'a.json') }, dir);
    const two = await prepareReverseGoverned({ ...base, cuesPath: path.join(dir, 'b.json') }, dir);
    expect(visionCalls).toBe(1); // the second run replayed the image read
    expect(JSON.stringify(one.brief)).toContain('hit');
    expect(JSON.stringify(two.brief)).toContain('drop');
    expect(JSON.stringify(two.brief)).not.toContain('"hit"');
  });
});
