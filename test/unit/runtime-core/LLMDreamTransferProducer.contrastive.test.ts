import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LLMDreamTransferProducer,
  TRANSFER_CONTROL_MARKERS,
  TRANSFER_DEPTH_CUE_VOCAB,
  TRANSFER_TREATMENT_MARKERS,
  transferArmInstructions,
} from '../../../src/runtime-core/ProductionDreamHostAdapters.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const okSource = JSON.stringify({
  id: 't1',
  source: '<canvas id="c"></canvas><script>/* local */</script>',
  layerIds: ['layer-a'],
  domains: ['html'],
});

describe('LLMDreamTransferProducer contrastive A+', () => {
  it('transferArmInstructions pins control markers and forbids multi-layer depth', () => {
    const text = transferArmInstructions(null);
    expect(text).toContain(TRANSFER_CONTROL_MARKERS.NO_FINDING);
    expect(text).toContain(TRANSFER_CONTROL_MARKERS.OVERRIDE_DEPTH);
    expect(text).toContain('WITHOUT multi-layer occlusion');
    expect(text).not.toContain(TRANSFER_TREATMENT_MARKERS.FINDING_BOUND);
  });

  it('transferArmInstructions pins treatment markers and cue vocabulary', () => {
    const token = digest('finding');
    const text = transferArmInstructions(token);
    expect(text).toContain(TRANSFER_TREATMENT_MARKERS.FINDING_BOUND);
    expect(text).toContain(TRANSFER_TREATMENT_MARKERS.DEPTH_CUES);
    expect(text).toContain(TRANSFER_DEPTH_CUE_VOCAB[0]);
    expect(text).toContain(TRANSFER_DEPTH_CUE_VOCAB[1]);
    expect(text).toContain(`findingDigest=${token}`);
  });

  it('control produce uses control markers and null findingDigest (AC1)', async () => {
    const client = { generate: vi.fn().mockResolvedValue({ success: true, code: okSource }) };
    await new LLMDreamTransferProducer(client as never).produce({
      holdout: 'demand nested depth membranes and parallax shells',
      contextDigest: digest('ctx-c'),
      findingDigest: null,
    });
    const [system, user] = client.generate.mock.calls[0] as [string, string];
    const blob = `${system} ${user}`;
    expect(blob).toContain(TRANSFER_CONTROL_MARKERS.NO_FINDING);
    expect(blob).toContain(TRANSFER_CONTROL_MARKERS.OVERRIDE_DEPTH);
    expect(blob).toContain('self-contained playable HTML source');
    expect(user).toContain('"findingDigest":null');
    expect(user).toContain('"armAssignment":"control"');
    expect(blob).not.toContain(TRANSFER_TREATMENT_MARKERS.FINDING_BOUND);
  });

  it('treatment produce uses treatment markers and findingDigest token (AC2)', async () => {
    const finding = digest('finding-token');
    const client = { generate: vi.fn().mockResolvedValue({ success: true, code: okSource }) };
    await new LLMDreamTransferProducer(client as never).produce({
      holdout: 'demand nested depth membranes and parallax shells',
      contextDigest: digest('ctx-t'),
      findingDigest: finding,
    });
    const [system, user] = client.generate.mock.calls[0] as [string, string];
    const blob = `${system} ${user}`;
    expect(blob).toContain(TRANSFER_TREATMENT_MARKERS.FINDING_BOUND);
    expect(blob).toContain(TRANSFER_TREATMENT_MARKERS.DEPTH_CUES);
    expect(blob).toContain(TRANSFER_DEPTH_CUE_VOCAB[0]);
    expect(blob).toContain(TRANSFER_DEPTH_CUE_VOCAB[1]);
    expect(user).toContain(finding);
    expect(user).toContain('"armAssignment":"treatment"');
    expect(blob).not.toContain(TRANSFER_CONTROL_MARKERS.NO_FINDING);
  });

  it('still rejects invalid candidate shape', async () => {
    const client = {
      generate: vi.fn().mockResolvedValue({
        success: true,
        code: JSON.stringify({ id: 'x', source: '', layerIds: [], domains: [] }),
      }),
    };
    await expect(new LLMDreamTransferProducer(client as never).produce({
      holdout: 'h', contextDigest: digest('1'), findingDigest: null,
    })).rejects.toThrow('DREAM_TRANSFER_CANDIDATE_INVALID');
  });
});
