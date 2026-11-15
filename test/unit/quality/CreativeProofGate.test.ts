import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateCreativeProof,
  type CreativeProofInput,
} from '../../../src/quality/CreativeProofGate.js';

function proof(overrides: Partial<CreativeProofInput> = {}): CreativeProofInput {
  return {
    schemaVersion: 1,
    domains: [{ name: 'p5', requiredModalities: ['visual'] }],
    evidence: [{
      ref: 'artifact.png',
      kind: 'image',
      modalities: ['visual'],
      sha256: 'a'.repeat(64),
      bytes: 100,
    }],
    verdicts: {
      technical: { status: 'pass', evidenceRefs: ['artifact.png'] },
      coordination: { status: 'not-evaluated', evidenceRefs: [] },
      creativeQuality: { status: 'not-evaluated', evidenceRefs: [] },
    },
    requestedClaims: {
      technicalSuccess: true,
      coordinationImproved: false,
      creativeQualityImproved: false,
    },
    ...overrides,
  };
}

describe('CreativeProofGate', () => {
  it('allows technical success without pretending creative quality was evaluated', () => {
    const result = evaluateCreativeProof(proof());
    expect(result.outcome).toBe('PASS');
    expect(result.claimable.creativeQualityImproved).toBe(false);
  });

  it('rejects a creative-quality claim without an aesthetic evaluation', () => {
    const input = proof();
    input.requestedClaims.creativeQualityImproved = true;
    const result = evaluateCreativeProof(input);
    expect(result.outcome).toBe('FAIL');
    expect(result.violations).toContain('CREATIVE_QUALITY_NOT_PROVEN');
  });

  it('rejects a silent contact sheet for an audiovisual composition', () => {
    const result = evaluateCreativeProof(proof({
      domains: [
        { name: 'p5', requiredModalities: ['visual'] },
        { name: 'tone', requiredModalities: ['audio'] },
      ],
    }));
    expect(result.outcome).toBe('FAIL');
    expect(result.violations).toContain('MISSING_PRESENTATION_AUDIO');
  });

  it('does not let a known audio domain hide its modality', () => {
    const result = evaluateCreativeProof(proof({
      domains: [{ name: 'tone', requiredModalities: ['visual'] }],
    }));
    expect(result.outcome).toBe('FAIL');
    expect(result.violations).toContain('DOMAIN_MODALITY_MISMATCH');
  });

  it('rejects zero-duration audio and image-only interaction claims', () => {
    const input = proof({
      domains: [{ name: 'tone', requiredModalities: ['audio', 'interaction'] }],
      evidence: [{
        ref: 'claimed-audio.png',
        kind: 'image',
        modalities: ['audio', 'interaction'],
        sha256: 'c'.repeat(64),
        bytes: 500,
        durationSeconds: 0,
      }],
      verdicts: {
        technical: { status: 'pass', evidenceRefs: ['claimed-audio.png'] },
        coordination: { status: 'not-evaluated', evidenceRefs: [] },
        creativeQuality: { status: 'not-evaluated', evidenceRefs: [] },
      },
    });
    const result = evaluateCreativeProof(input);
    expect(result.outcome).toBe('FAIL');
    expect(result.missingModalities).toEqual(['audio', 'interaction']);
  });

  it('accepts playable audiovisual evidence and an explicit quality verdict', () => {
    const input = proof({
      domains: [
        { name: 'p5', requiredModalities: ['visual'] },
        { name: 'tone', requiredModalities: ['audio'] },
      ],
      evidence: [{
        ref: 'artifact.mp4',
        kind: 'video',
        modalities: ['visual', 'audio'],
        sha256: 'b'.repeat(64),
        bytes: 1_000,
        durationSeconds: 12,
      }],
      verdicts: {
        technical: { status: 'pass', evidenceRefs: ['artifact.mp4'] },
        coordination: { status: 'pass', evidenceRefs: ['artifact.mp4'] },
        creativeQuality: {
          status: 'pass',
          evidenceRefs: ['artifact.mp4'],
          evaluatorRef: 'review:grok',
          rubricRef: 'rubric:creative-v1',
        },
      },
      requestedClaims: {
        technicalSuccess: true,
        coordinationImproved: true,
        creativeQualityImproved: true,
      },
    });
    expect(evaluateCreativeProof(input).outcome).toBe('PASS');
  });

  describe('substantive evidence (#1316)', () => {
    const artifact = new TextEncoder().encode('real artifact bytes');
    const realDigest = createHash('sha256').update(artifact).digest('hex');
    const withRealEvidence = () => proof({
      evidence: [{
        ref: 'artifact.png',
        kind: 'image',
        modalities: ['visual'],
        sha256: realDigest,
        bytes: artifact.byteLength,
      }],
    });

    it('marks a shape-only PASS as not byte-verified', () => {
      const result = evaluateCreativeProof(proof());
      expect(result.outcome).toBe('PASS');
      expect(result.evidenceBytesVerified).toBe(false);
    });

    it('verifies bytes when a reader is supplied and they match', () => {
      const result = evaluateCreativeProof(withRealEvidence(), {
        readEvidence: ref => (ref === 'artifact.png' ? artifact : null),
      });
      expect(result.outcome).toBe('PASS');
      expect(result.evidenceBytesVerified).toBe(true);
    });

    it('rejects a plausible but fabricated digest', () => {
      const result = evaluateCreativeProof(proof(), { readEvidence: () => artifact });
      expect(result.outcome).toBe('FAIL');
      expect(result.violations).toContain('EVIDENCE_DIGEST_MISMATCH');
      expect(result.evidenceBytesVerified).toBe(false);
    });

    it('rejects a matching digest with a wrong declared length', () => {
      const input = withRealEvidence();
      input.evidence[0].bytes = artifact.byteLength + 1;
      const result = evaluateCreativeProof(input, { readEvidence: () => artifact });
      expect(result.violations).toContain('EVIDENCE_DIGEST_MISMATCH');
    });

    it('treats missing or throwing reads as unreadable evidence', () => {
      expect(evaluateCreativeProof(withRealEvidence(), { readEvidence: () => null }).violations)
        .toContain('EVIDENCE_UNREADABLE');
      const thrown = evaluateCreativeProof(withRealEvidence(), {
        readEvidence: () => { throw new Error('ENOENT'); },
      });
      expect(thrown.outcome).toBe('FAIL');
      expect(thrown.violations).toContain('EVIDENCE_UNREADABLE');
    });

    it('rejects an empty domain list instead of passing vacuously', () => {
      const result = evaluateCreativeProof(proof({ domains: [] }));
      expect(result.outcome).toBe('FAIL');
      expect(result.violations).toContain('NO_DOMAINS');
    });

    it('rejects a domain that requires no modality', () => {
      const result = evaluateCreativeProof(proof({
        domains: [{ name: 'mystery', requiredModalities: [] }],
      }));
      expect(result.outcome).toBe('FAIL');
      expect(result.violations).toContain('EMPTY_DOMAIN_MODALITIES');
    });
  });
});
