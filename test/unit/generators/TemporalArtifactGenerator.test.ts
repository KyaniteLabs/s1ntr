import { describe, expect, it } from 'vitest';
import { TemporalArtifactGenerator } from '../../../src/generators/temporal/TemporalArtifactGenerator.js';
import { buildTemporalArtifact } from '../../../src/creative-intelligence/temporal/TemporalArtifact.js';

describe('TemporalArtifactGenerator', () => {
  const brief = 'A time-based rhythm that pulses across the duration with steady beats over time.';

  it('delegates to buildTemporalArtifact deterministically, with no provider involved', () => {
    const viaSeam = new TemporalArtifactGenerator().generate({ brief, artifactId: 'fixed-id' });
    const direct = buildTemporalArtifact({ brief, artifactId: 'fixed-id' });
    expect(viaSeam).toEqual(direct);
  });

  it('is stable across generator instances', () => {
    const a = new TemporalArtifactGenerator().generate({ brief });
    const b = new TemporalArtifactGenerator().generate({ brief });
    expect(a).toEqual(b);
  });

  it('propagates builder contract errors such as more than one revision', () => {
    const revision = { revisionId: 'phase-shift' as const, bound: 1 };
    expect(() => new TemporalArtifactGenerator().generate({ brief, revisionApplications: [revision, revision] }))
      .toThrow('Temporal artifact permits at most one revision');
  });
});
