import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';
import {
  compileCreativeThesis,
  CREATIVE_PRINCIPLE_MANIFEST,
  detectProjectionSourceDrift,
  INTERACTION_A11Y_DISPOSITION_MATRIX,
  INTERACTION_A11Y_SOURCE_ROWS,
  interactionAccessibilityDispositionFor,
  projectCreativePrinciple,
  resolveCreativePrinciple,
  validateCreativePrincipleContract,
  validateCreativeThesis,
} from '../../../src/creative-intelligence/index.js';

const EXPECTED_INTERACTION_A11Y_ROW_COUNT = 20 as const;

// Six W8-09 supported contracts are promoted from the INTERACTION_A11Y matrix.
// W8-05 contrast / color-harmony / focal-point / negative-space / rhythm are
// preserved; this test must stay consistent with the W8-05 manifest.
const SUPPORTED_PRINCIPLE_IDS = [
  'contrast',
  'color-harmony',
  'focal-point',
  'negative-space',
  'rhythm',
  'keyboard-operation',
  'focus-visibility',
  'focus-order',
  'semantic-naming',
  'semantic-state',
  'reduced-motion',
] as const;

const W8_09_SUPPORTED_PRINCIPLE_IDS = [
  'keyboard-operation',
  'focus-visibility',
  'focus-order',
  'semantic-naming',
  'semantic-state',
  'reduced-motion',
] as const;

const SUPPORTED_INTERACTION_ROW_NAMES = [
  'Keyboard Operation',
  'Focus Visibility',
  'Focus Order',
  'Semantic Naming',
  'Semantic State',
  'Reduced Motion',
] as const;

const HISTORICAL_INTERACTION_ROW_NAMES = [
  'Mouse Drag',
  'Touch Swipe',
  'Tap',
  'Hover',
  'Pinch',
  'Click',
  'Focus Ring',
  'ARIA Live Region',
  'Screen Reader Bypass',
  'Form Submit',
  'Checkbox Toggle',
] as const;

const UNSUPPORTED_INTERACTION_ROW_NAMES = [
  'Color Independence',
  'Cognitive Load',
  'Multi-Modal Input',
] as const;

function expectedSourceDigest(name: string, description: string, keywords: readonly string[]): string {
  return createHash('sha256').update(`interaction|${name}|${description}|[${keywords.join(',')}]`).digest('hex');
}

describe('W8-09 interaction & accessibility manifest', () => {
  it('enumerates every INTERACTION_A11Y row exactly once with stable source digests', () => {
    expect(INTERACTION_A11Y_SOURCE_ROWS).toHaveLength(EXPECTED_INTERACTION_A11Y_ROW_COUNT);
    for (const row of INTERACTION_A11Y_SOURCE_ROWS) {
      const expected = expectedSourceDigest(row.name, row.description, row.keywords);
      expect(row.sourceDigest).toBe(expected);
      expect(row.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(INTERACTION_A11Y_DISPOSITION_MATRIX).toHaveLength(EXPECTED_INTERACTION_A11Y_ROW_COUNT);
    const identities = INTERACTION_A11Y_DISPOSITION_MATRIX.map((entry) => entry.row.name);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('disposes every INTERACTION_A11Y row as supported / historical / unsupported', () => {
    for (const name of SUPPORTED_INTERACTION_ROW_NAMES) {
      const entry = INTERACTION_A11Y_DISPOSITION_MATRIX.find((row) => row.row.name === name);
      expect(entry).toMatchObject({ disposition: 'supported' });
      expect(typeof entry!.principleId).toBe('string');
      expect(entry!.contractDigest).toMatch(/^[a-f0-9]{64}$/);
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[entry!.principleId!];
      expect(contract?.identity.id).toBe(entry!.principleId);
    }
    for (const name of HISTORICAL_INTERACTION_ROW_NAMES) {
      const entry = INTERACTION_A11Y_DISPOSITION_MATRIX.find((row) => row.row.name === name);
      expect(entry).toMatchObject({ disposition: 'historical' });
      expect(entry!.principleId).toBeNull();
      expect(entry!.contractDigest).toBe('');
      expect(typeof entry!.reason).toBe('string');
      expect(entry!.reason!.length).toBeGreaterThan(20);
      expect(resolveCreativePrinciple(name)).toBeUndefined();
    }
    for (const name of UNSUPPORTED_INTERACTION_ROW_NAMES) {
      const entry = INTERACTION_A11Y_DISPOSITION_MATRIX.find((row) => row.row.name === name);
      expect(entry).toMatchObject({ disposition: 'unsupported' });
      expect(entry!.principleId).toBeNull();
      expect(typeof entry!.reason).toBe('string');
      expect(entry!.reason!.length).toBeGreaterThan(20);
      expect(resolveCreativePrinciple(name)).toBeUndefined();
    }
  });

  it('fails closed before provider reservation for an unsupported interaction/a11y principle', async () => {
    const reserve = vi_fn_never_called();
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
    await expect(coordinator.start({ entryPoint: 'studio-session', prompt: 'Use multi-modal input for navigation.' })).rejects.toThrow(/unsupported/);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('fails closed before provider reservation for an historical interaction row', async () => {
    const reserve = vi_fn_never_called();
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
    await expect(coordinator.start({ entryPoint: 'studio-session', prompt: 'Use hover to reveal details.' })).rejects.toThrow(/unsupported|historical/i);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('reserves a supported W8-09 contract through the coordinator with one identity', async () => {
    const result = await new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() }).start({
      entryPoint: 'studio-session',
      prompt: 'Use reduced motion for a calming interactive sketch.',
    });
    expect(result.creativeThesis?.principles[0].principleId).toBe('reduced-motion');
    expect(result.creativeThesis?.disposition).toBe('supported');
    expect(result.readiness.source).toBe('synthetic-no-spend');
  });

  it('preserves the W8-05 color/composition behavior unchanged', () => {
    // W8-05 dispositions that have nothing to do with W8-09 are preserved:
    //   - 'Use chiaroscuro principle for this study.' -> unsupported (no contract substitution)
    //   - 'Use HSB HSL controls.' -> unsupported (fail closed)
    //   - 'Use split-complementary for this work.'   -> unsupported (the longer match wins)
    const chiaroscuro = compileCreativeThesis('Use the chiaroscuro principle for this study.');
    expect(chiaroscuro.disposition).toBe('unsupported');
    expect(chiaroscuro.unsupported[0].requested).toBe('chiaroscuro');

    const hsb = compileCreativeThesis('Use HSB HSL controls.');
    expect(hsb.disposition).toBe('unsupported');
    expect(hsb.unsupported[0].requested).toBe('hsb hsl');

    const split = compileCreativeThesis('Use split-complementary for this work.');
    expect(split.disposition).toBe('unsupported');
    expect(split.unsupported[0].requested).toBe('split complementary');

    // The W8-05 supported contracts remain resolvable.
    expect(resolveCreativePrinciple('contrast')?.identity.id).toBe('contrast');
    expect(resolveCreativePrinciple('focal point')?.identity.id).toBe('focal-point');
    expect(resolveCreativePrinciple('color harmony')?.identity.id).toBe('color-harmony');
    expect(resolveCreativePrinciple('rhythm')?.identity.id).toBe('rhythm');
    expect(resolveCreativePrinciple('negative space')?.identity.id).toBe('negative-space');
  });

  it('maps each supported row to a valid CreativePrincipleContract with measurable evidence', () => {
    for (const id of W8_09_SUPPORTED_PRINCIPLE_IDS) {
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[id];
      expect(typeof contract?.identity.id).toBe('string');
      expect(() => validateCreativePrincipleContract(contract!)).not.toThrow();
      expect(contract!.status).toBe('hard');
      expect(contract!.observablePerceptualEvidence.length).toBeGreaterThanOrEqual(2);
      // Floor contracts are non-waivable: the contract identity must declare intent to fail closed
      // and the revision operators must include a hard target.
      expect(contract!.revisionOperators.length).toBeGreaterThanOrEqual(2);
      const liveDigest = createHash('sha256').update(projectCreativePrinciple(contract!)).digest('hex');
      expect(detectProjectionSourceDrift(contract!, projectCreativePrinciple(contract!)).drift).toBe(false);
      expect(liveDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('exposes a deterministic lookup function over the interaction/a11y disposition matrix', () => {
    const keyboard = interactionAccessibilityDispositionFor('keyboard operation');
    expect(keyboard.disposition).toBe('supported');
    expect(keyboard.principleId).toBe('keyboard-operation');

    const hoverEntry = interactionAccessibilityDispositionFor('hover');
    expect(hoverEntry.disposition).toBe('historical');
    expect(hoverEntry.principleId).toBeNull();

    const cognitiveLoad = interactionAccessibilityDispositionFor('cognitive load');
    expect(cognitiveLoad.disposition).toBe('unsupported');
    expect(cognitiveLoad.principleId).toBeNull();
    expect(cognitiveLoad.reason!.length).toBeGreaterThan(20);

    const unknown = interactionAccessibilityDispositionFor('Never-Heard-Of Principle');
    expect(unknown.disposition).toBe('unsupported');
    expect(unknown.principleId).toBeNull();
    expect(unknown.reason!.length).toBeGreaterThan(20);
  });

  it('attaches identity-bound row ids and reasons to a supported interaction thesis', () => {
    const thesis = compileCreativeThesis('Apply keyboard operation, focus visibility, and reduced motion to a calm interactive scene.');
    expect(thesis.disposition).toBe('supported');
    const identity = thesis.principles[0].contractIdentity;
    expect(typeof identity.principleId).toBe('string');
    expect(identity.contractVersion).toBeGreaterThan(0);
    expect(identity.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
    // The handle stays unique: same brief + same briefDigest + same projectionDigest
    // produces a deterministic thesisId.
    const repeat = compileCreativeThesis('Apply keyboard operation, focus visibility, and reduced motion to a calm interactive scene.');
    expect(repeat.thesisId).toBe(thesis.thesisId);
    expect(() => validateCreativeThesis(thesis)).not.toThrow();
  });
});

// Hook: vi.fn — capture a never-called reservation function for fail-closed tests.
function vi_fn_never_called() {
  return vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
}
