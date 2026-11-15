import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  COLOR_COMPOSITION_DISPOSITION_MATRIX,
  COLOR_COMPOSITION_SOURCE_ROWS,
  CREATIVE_PRINCIPLE_MANIFEST,
  compileCreativeThesis,
  detectProjectionSourceDrift,
  principleDispositionFor,
  projectCreativePrinciple,
  resolveCreativePrinciple,
  validateCreativePrincipleContract,
  validateCreativeThesis,
} from '../../../src/creative-intelligence/CreativeIntelligence.js';

// 16 color rows + 14 composition rows from the frozen knowledge base.
const FROZEN_ROW_COUNT = 30;
const EXPECTED_SOURCE_DIGESTS = [
  '6f852544860a0b25fa0bfc29cd97d22c6ddea35856dcc8bf72434de7990d374d', 'b278f3935c15a4fca96d023940d5beec46909268cd15f8389ef464eb0225c1c7',
  '2333209313a8201e80d71349442f5e9e9532afae23066bf5d33b03ef21009557', '2ac6ae2bc862f0e3f52ee5223bc8dae4af6e5b0b175692352fbc17be940585af',
  '64260758fb0ab1a4e89cb190771506564ad3efb8dd4ffd008bba155a1d689f9e', '9a5c4a94fa7b8883f9cec7354528769a8684901a723af9a94ae60c646973a178',
  '585ed9045fc37b36098ea348260c292b919d0bebef355d9339e399b7ff375ede', '5e7453d3eefd34045827ba72e7e92c58d08b0bb37d2194eeb3037d46e50a78eb',
  'dc131496cf05f77baa50b3eb90045e4f5b48206f737273124df08e72953fb691', '1b4d31ec44571c01c57ecc496406e188c43deece8488f766a09aa8660e7ce454',
  'c6b0a89efcba965323658f0285dbcf643d3fd51b407747bf77def7f8eec3421e', '8361d9241e0a8cbe69f46bce591648f225fc618b0462e77f38036f73930af491',
  'f35a2074de32159d648811604ac93f1425629e7c187e7d26b9a74f904e58b1ba', 'b0ba4f91a5bf49f62dcea7f79626d91da448c38e73493f8e6d1afb37d6a3ac78',
  '83088c7af3222313b4a3645cead7375d6e844f19c64434ec8c1f668990dbab1f', '29ecb5a3bd24ffdf01127a74a9b446667b72cb9645292ce969a0d699eb06b2e8',
  'b60da0e75ae1ec66ea4c355b405fc82ee75815cde00e00375da090800cfa0417', 'eba1a7b5ab2c1fedd6fc875bfdccf0b37a84c4541e105344dffda57422f927aa',
  '0c9a77e00be45f60c5d95e3f7430303337c7e79d16779203a3788cae2f0420c0', 'df6582df1fdb5fb42afff3c21654c4d9374fa69c23b22fc5a1421cb399f7347e',
  'c3ce8bcc2c4f59f31ad7ea7e8711cbeccc49d017510e9fc406d0b25c148a0ddd', '88253f62c8fa8f99d4805b86d0c92cf27c58c6a651e8bbca364dbc436308a990',
  '1c3b6c5f78a4d154dfd86f9e0afe61b66b3a3b78da12c7a905854a3dafd3790d', '9d43cea1142513cd4b6f32141fec27004c2f5e86d8cbc422b1e00b3939146967',
  'a3dcf1b57ffa72d51a0cd0f48e0eccdeb44f7f1e31980277fab8bbaf73ec13ff', '06d55024d61e26f9dc7b4966efdda7979198f9e71297a3edbcf0181425f9a422',
  'fac1b9833d8f6be0bbe9a146254f25875d9c0b787472273dece1ad47b440ae1c', '94fac6dfece3bef22df542b0a588358ac41c406aef3f6a5541e317492f379b6b',
  'cc47f9c15b2065e2d7d9ac6adfbda9edf7178c0a56c46c14669b3e5b67932955', '4dbf1ff89741a3b2fe7e608064a677d092883404ee6ff6349d5a42daa2d2ce61',
] as const;

// Principles the COLOR_COMPOSITION_DISPOSITION_MATRIX promotes to contracts.
const COLOR_COMPOSITION_SUPPORTED_PRINCIPLE_IDS = [
  'color-harmony',
  'focal-point',
  'negative-space',
] as const;

// Principles the broader CREATIVE_PRINCIPLE_MANIFEST supports, including
// contrast (the canonical entry from Wave 8 #672) and rhythm (sourced from
// the design-principles rows, not the color/composition rows).
const SUPPORTED_PRINCIPLE_IDS = [
  'contrast',
  'color-harmony',
  'focal-point',
  'negative-space',
  'rhythm',
] as const;

describe('frozen color and composition manifest disposition', () => {
  it('enumerates every frozen color and composition row exactly once with stable source digests', () => {
    expect(COLOR_COMPOSITION_SOURCE_ROWS).toHaveLength(FROZEN_ROW_COUNT);
    expect(COLOR_COMPOSITION_SOURCE_ROWS.map((row) => row.sourceDigest)).toEqual(EXPECTED_SOURCE_DIGESTS);
    expect(COLOR_COMPOSITION_DISPOSITION_MATRIX).toHaveLength(FROZEN_ROW_COUNT);
    const identities = COLOR_COMPOSITION_DISPOSITION_MATRIX.map((entry) => entry.row.name);
    expect(new Set(identities).size).toBe(identities.length);
    for (const entry of COLOR_COMPOSITION_DISPOSITION_MATRIX) {
      expect(entry.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sourceDigest).toBe(entry.row.sourceDigest);
    }
  });

  it('marks the promoted color/composition rows as supported and points each at a contract', () => {
    for (const id of COLOR_COMPOSITION_SUPPORTED_PRINCIPLE_IDS) {
      const entry = COLOR_COMPOSITION_DISPOSITION_MATRIX.find((row) => row.principleId === id);
      expect(entry).toMatchObject({ disposition: 'supported', principleId: id });
      expect(entry!.reason).toBeUndefined();
      expect(entry!.contractDigest).toMatch(/^[a-f0-9]{64}$/);
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[id];
      expect(contract?.identity.id).toBe(id);
      // The disposition matrix contracts use the canonical contract projection
      // digest; verify it matches the live contract projection digest.
      const liveDigest = createHash('sha256').update(projectCreativePrinciple(contract!)).digest('hex');
      expect(entry!.contractDigest).toBe(liveDigest);
    }
  });
  it('records an immutable reason for every excluded row and marks them unreachable', () => {
    const excluded = COLOR_COMPOSITION_DISPOSITION_MATRIX.filter((row) => row.disposition === 'unsupported');
    expect(excluded.length).toBe(FROZEN_ROW_COUNT - COLOR_COMPOSITION_SUPPORTED_PRINCIPLE_IDS.length);
    for (const entry of excluded) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason!.length).toBeGreaterThan(10);
      expect(entry.principleId).toBeNull();
      expect(entry.contractDigest).toBe('');
      expect(resolveCreativePrinciple(entry.row.name)).toBeUndefined();
    }
  });

  it('ships a frozen, schema-valid contract for each supported principle in the manifest', () => {
    for (const id of SUPPORTED_PRINCIPLE_IDS) {
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[id];
      expect(contract?.identity.id).toBe(id);
      expect(() => validateCreativePrincipleContract(contract)).not.toThrow();
      expect(contract!.identity.id).toBe(id);
    }
  });

  it('projects every supported contract deterministically with no drift', () => {
    for (const id of SUPPORTED_PRINCIPLE_IDS) {
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[id];
      const first = projectCreativePrinciple(contract!);
      const second = projectCreativePrinciple(contract!);
      expect(first).toBe(second);
      const drift = detectProjectionSourceDrift(contract!, first);
      expect(drift.drift).toBe(false);
    }
  });

  it('selects a non-contrast principle when an ordinary-language brief names a different supported principle', () => {
    const focal = compileCreativeThesis('A quiet field that needs a single, unmistakable focal point.');
    expect(focal.disposition).toBe('supported');
    expect(focal.principles[0].contractIdentity.principleId).toBe('focal-point');

    const negative = compileCreativeThesis('A still, breathing room that lets the silence carry.');
    expect(negative.disposition).toBe('supported');
    expect(negative.principles[0].contractIdentity.principleId).toBe('negative-space');

    const rhythm = compileCreativeThesis('A pulse that returns every few seconds, with a slight variation.');
    expect(rhythm.disposition).toBe('supported');
    expect(rhythm.principles[0].contractIdentity.principleId).toBe('rhythm');

    const harmony = compileCreativeThesis('A warm, harmonious palette that holds a single mood.');
    expect(harmony.disposition).toBe('supported');
    expect(harmony.principles[0].contractIdentity.principleId).toBe('color-harmony');
  });

  it('does not reject an explicitly requested supported principle', () => {
    const thesis = compileCreativeThesis('A quiet field with one clear subject.', {
      requestedPrinciples: ['focal-point'],
    });
    expect(thesis.disposition).toBe('supported');
    expect(thesis.unsupported).toEqual([]);
    expect(thesis.principles[0].contractIdentity.principleId).toBe('focal-point');
    expect(validateCreativeThesis(thesis)).toEqual(thesis);
  });

  it('uses explicit request order as the bounded rule for multiple supported principles', () => {
    const thesis = compileCreativeThesis('A quiet field', {
      requestedPrinciples: ['focal-point', 'negative-space'],
    });
    expect(thesis.principles[0].contractIdentity.principleId).toBe('focal-point');
  });

  it('records every excluded color/composition row with an explicit reason and an unsupported disposition', () => {
    const unsupported = compileCreativeThesis('Use complementary, triadic, warm colors, cool colors, gradient, palette, hue, and saturation.');
    expect(unsupported.disposition).toBe('unsupported');
    const requested = unsupported.unsupported.map((entry) => entry.requested).sort();
    expect(requested).toEqual(expect.arrayContaining(['complementary', 'triadic', 'warm colors', 'cool colors', 'gradient', 'palette', 'hue', 'saturation']));
    for (const entry of unsupported.unsupported) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.reason).toMatch(/canonical|recipe|tool|technical|attribute|descriptor|unreachable|disposition|color|composition|frozen|principle/i);
    }
  });

  it('does not double-count a longer frozen row as its shorter suffix', () => {
    const thesis = compileCreativeThesis('Use split-complementary for this work.');
    expect(thesis.unsupported.map((entry) => entry.requested)).toEqual(['split complementary']);
  });

  it('exposes a deterministic lookup function over the frozen disposition matrix', () => {
    const focal = principleDispositionFor('focal-point');
    expect(focal.disposition).toBe('supported');
    expect(focal.principleId).toBe('focal-point');

    const focalTitleCase = principleDispositionFor('Focal Point');
    expect(focalTitleCase.disposition).toBe('supported');
    expect(focalTitleCase.principleId).toBe('focal-point');

    const thirds = principleDispositionFor('Rule of Thirds');
    expect(thirds.disposition).toBe('unsupported');
    expect(thirds.principleId).toBeNull();

    const unknown = principleDispositionFor('Unknown Principle');
    expect(unknown.disposition).toBe('unsupported');
    expect(unknown.principleId).toBeNull();
    expect(unknown.reason!.length).toBeGreaterThan(20);
  });
});
