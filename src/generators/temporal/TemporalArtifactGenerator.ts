import {
  buildTemporalArtifact,
  type TemporalArtifact,
  type TemporalArtifactOptions,
} from '../../creative-intelligence/temporal/TemporalArtifact.js';

export interface TemporalArtifactGenerationSeam {
  generate(options: TemporalArtifactOptions): TemporalArtifact;
}

/** Deterministic, no-provider generator for contract-governed temporal work. */
export class TemporalArtifactGenerator implements TemporalArtifactGenerationSeam {
  generate(options: TemporalArtifactOptions): TemporalArtifact {
    return buildTemporalArtifact(options);
  }
}
