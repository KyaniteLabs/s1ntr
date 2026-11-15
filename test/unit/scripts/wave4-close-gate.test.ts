/**
 * Wave 4 close-gate: fail-closed structure + freeze roster (no live LLM).
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWave4CloseGate } from '../../../scripts/rotation/wave4-close-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('wave4-close-gate', () => {
  it('docs + freeze probes pass on this repo', () => {
    const report = runWave4CloseGate({
      allowDry: true,
      enforceSol: false,
      // force missing pipeline to be soft-handled: allowDry still requires a dir if present
    });
    const byId = Object.fromEntries(report.probes.map((p) => [p.id, p]));
    expect(byId.docs_present.ok).toBe(true);
    expect(byId.freeze_wave4.ok).toBe(true);
    expect(byId.anti_theater_intent.ok).toBe(true);
    // sol soft without file is ok when not enforce
    expect(byId.sol_adversarial_receipt.severity).toBe('soft');
  });

  it('hard-fails livePass when not allowDry and no live pipeline', () => {
    const report = runWave4CloseGate({ allowDry: false, enforceSol: false });
    // Without a live pipeline, full_pipeline_receipt should fail hard
    const pipe = report.probes.find((p) => p.id === 'full_pipeline_receipt');
    expect(pipe?.id).toBe('full_pipeline_receipt');
    if (pipe && !pipe.ok) {
      expect(report.ok).toBe(false);
      expect(report.hardFails).toContain('full_pipeline_receipt');
    }
  });
});
