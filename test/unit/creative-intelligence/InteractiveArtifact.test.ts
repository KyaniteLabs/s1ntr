import { describe, expect, it } from 'vitest';

import {
  assertInteractiveArtifactIdentity,
  BOUNDED_REVISION_MAX,
  buildInteractiveArtifact,
  buildInteractiveArtifactFromBrief,
  compileCreativeThesis,
  CREATIVE_THESIS_SCHEMA,
  inspectInteractiveArtifactIdentity,
  INTERACTIVE_ARTIFACT_SCHEMA,
  INTERACTIVE_ARTIFACT_VERSION,
  INTERACTION_A11Y_BOUNDED_REVISION_MAX,
  validateCreativeThesis,
} from '../../../src/creative-intelligence/index.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';

function builtFor(brief: string, requestedPrinciples?: readonly string[]) {
  return buildInteractiveArtifactFromBrief(brief, { runtimeSeed: 'proof', requestedPrinciples });
}

// Helper: keyword-presence detection for tests that want to bind multiple
// W8-09 contracts through a single brief. Words are matched against the
// supported principle keys.
function requestedPrinciplesFromBrief(brief: string): readonly string[] {
  const found: string[] = [];
  if (/keyboard|tab|operable/i.test(brief)) found.push('keyboard-operation');
  if (/focus visibility|focus indicator|focus ring|visible focus/i.test(brief)) found.push('focus-visibility');
  if (/focus order|tab order|reading order/i.test(brief)) found.push('focus-order');
  if (/semantic naming|aria-label|labelled|accessible name/i.test(brief)) found.push('semantic-naming');
  if (/semantic state|aria-pressed|aria-expanded|aria-selected|aria-disabled/i.test(brief)) found.push('semantic-state');
  if (/reduced motion|prefers-reduced-motion|vestibular/i.test(brief)) found.push('reduced-motion');
  return [...new Set(found)];
}

function extractMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

describe('W8-09 deterministic interactive artifact', () => {
  it('compiles a supported W8-09 thesis and binds the chosen principle IDs', () => {
    const built = builtFor('Apply keyboard operation to a calm interactive scene.');
    expect(built.thesis.disposition).toBe('supported');
    expect(built.trace.identity.thesisId).toBe(built.thesis.thesisId);
    expect(built.trace.identity.principleIds).toContain('keyboard-operation');
  });

  it('emits exactly one artifact digest that binds thesis + principles + runtime + revisions', () => {
    const built = builtFor('Apply keyboard operation, focus visibility, and reduced motion.',
      requestedPrinciplesFromBrief('Apply keyboard operation, focus visibility, and reduced motion.'));
    const html = built.html;
    const digest = extractMeta(html, 'sinter-interactive-artifact-digest');
    expect(digest).toBe(built.trace.identity.artifactDigest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(html).toContain(`sinter-creative-thesis-id" content="${built.thesis.thesisId}`);
    expect(html).toContain(`sinter-interactive-artifact-principle-ids" content="keyboard-operation,focus-visibility,reduced-motion"`);
    expect(html).toContain(`sinter-interactive-artifact-runtime" content="proof"`);
    expect(html).toContain(`sinter-interactive-artifact-revisions" content="0"`);
  });

  it('produces identical identity for the same brief and runtime seed', () => {
    const left = builtFor('Apply keyboard operation.').trace.identity;
    const right = builtFor('Apply keyboard operation.').trace.identity;
    expect(left).toEqual(right);
  });

  it('changes the artifact digest when the runtime seed changes but keeps identity contract fields stable', () => {
    const a = buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'run-a' });
    const b = buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'run-b' });
    expect(a.trace.identity.artifactDigest).not.toBe(b.trace.identity.artifactDigest);
    expect(a.trace.identity.thesisId).toBe(b.trace.identity.thesisId);
    expect(a.trace.identity.principleIds).toEqual(b.trace.identity.principleIds);
  });

  it('reaches a deterministic state path with at least one input -> prior -> next step per principle', () => {
    const built = buildInteractiveArtifactFromBrief('Apply keyboard operation, focus visibility, focus order, semantic naming, semantic state, and reduced motion.', {
      runtimeSeed: 'full',
      requestedPrinciples: requestedPrinciplesFromBrief('Apply keyboard operation, focus visibility, focus order, semantic naming, semantic state, and reduced motion.'),
    });
    expect(built.trace.steps.length).toBeGreaterThanOrEqual(4);
    for (const step of built.trace.steps) {
      expect(typeof step.input).toBe('string');
      expect(step.input.length).toBeGreaterThan(0);
      expect(typeof step.priorState).toBe('string');
      expect(typeof step.nextState).toBe('string');
    }
    const observations = new Set(built.trace.steps.map((s) => `${s.priorState}->${s.nextState}`));
    // The trace must not collapse to a single state — there must be observable
    // transitions for keyboard / focus / state input events.
    expect(observations.size).toBeGreaterThanOrEqual(3);
  });

  it('enforces the bounded-revision maximum across the supported / cohort', () => {
    expect(INTERACTION_A11Y_BOUNDED_REVISION_MAX).toBe(1);
    expect(BOUNDED_REVISION_MAX).toBe(1);
    const built = buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'bounded', revisionsApplied: 1 });
    expect(built.trace.identity.revisionsApplied).toBe(1);
    expect(built.html).toContain('Bounded revisions applied: 1 / 1');
    expect(built.html).toContain('data-revision-treatment="clarified-state-feedback"');
    const baseline = buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'bounded' });
    expect(built.html).not.toBe(baseline.html);
    // Anything above 1 must throw — aesthetic scoring cannot waive the bound.
    expect(() => buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'bounded', revisionsApplied: 2 })).toThrow(/bounded revision/);
    // Negative revisions must also throw (input validation).
    expect(() => buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'bounded', revisionsApplied: -1 })).toThrow();
  });

  it('refuses an unsupported thesis (fails closed before artifact build)', () => {
    const unsupported = compileCreativeThesis('Use multi-modal input for navigation.');
    expect(unsupported.disposition).toBe('unsupported');
    expect(() => buildInteractiveArtifact(unsupported, { runtimeSeed: 'no-spend' })).toThrow(/supported Creative Thesis/);
  });

  it('round-trips identity through inspectInteractiveArtifactIdentity without launching a browser', () => {
    const built = builtFor('Apply keyboard operation, semantic naming, and reduced motion.',
      requestedPrinciplesFromBrief('Apply keyboard operation, semantic naming, and reduced motion.'));
    const observed = inspectInteractiveArtifactIdentity(built.html);
    expect(observed).toEqual(built.trace.identity);
    expect(observed.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.principleIds).toEqual(expect.arrayContaining(['keyboard-operation', 'semantic-naming', 'reduced-motion']));
    expect(observed.runtimeId).toBe('runtime-proof');
    expect(observed.revisionsApplied).toBe(0);
  });

  it('produces the W8-09 accessibility bindings as meta-tag identities, not DOM measurements', () => {
    // The brief explicitly forbids fabricating DOM/browser measurements. Every
    // accessibility binding must come from deterministic identity parsing.
    const brief = 'Apply keyboard operation, focus visibility, semantic naming, semantic state, and reduced motion.';
    const built = builtFor(brief, requestedPrinciplesFromBrief(brief));
    expect(extractMeta(built.html, 'sinter-interactive-artifact-schema')).toBe(INTERACTIVE_ARTIFACT_SCHEMA);
    expect(extractMeta(built.html, 'sinter-interactive-artifact-version')).toBe(String(INTERACTIVE_ARTIFACT_VERSION));
    expect(extractMeta(built.html, 'sinter-creative-thesis-schema')).toBe(CREATIVE_THESIS_SCHEMA);
    expect(extractMeta(built.html, 'sinter-interactive-artifact-bounded-revision-max')).toBe(String(BOUNDED_REVISION_MAX));
    // Strict identity binding: re-running the inspect must match the recorded trace.
    expect(() => assertInteractiveArtifactIdentity(built.html, built.trace.identity)).not.toThrow();
  });

  it('rejects identity drift when the expected identity does not match the rendered artifact', () => {
    const built = builtFor('Apply keyboard operation.');
    const tampered = { ...built.trace.identity, revisionsApplied: 1 };
    expect(() => assertInteractiveArtifactIdentity(built.html, tampered)).toThrow(/identity mismatch/);
  });

  it('rejects mutation of the canonical rendered body', () => {
    const built = builtFor('Apply keyboard operation.');
    const mutated = built.html.replace('Primary action', 'Mutated action');
    expect(() => assertInteractiveArtifactIdentity(mutated, built.trace.identity)).toThrow(/canonical rendered body/);
  });

  it('emits real deterministic handlers for the evidenced transitions and hard accessibility floors', () => {
    const built = builtFor('Apply keyboard operation.');
    expect(built.html).toContain("primary.addEventListener('click'");
    expect(built.html).toContain("secondary.addEventListener('click'");
    expect(built.html).toContain("document.addEventListener('keydown'");
    expect(built.html).toContain('aria-label="Activate primary subject"');
    expect(built.html).toContain('aria-pressed="false"');
    expect(built.html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(built.trace.steps.map((step) => step.input)).toEqual([
      'primary.click', 'secondary.click', 'document.keydown:Escape',
    ]);
  });

  it('runs the bounded artifact builder through CreativeRunCoordinator with no-spend reservation', async () => {
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const handle = await coordinator.start({ entryPoint: 'studio-session', prompt: 'Apply keyboard operation and reduced motion.' });
    expect(handle.creativeThesis?.disposition).toBe('supported');
    expect(handle.readiness.source).toBe('synthetic-no-spend');

    // Validate that the thesis identity survives the coordinator round-trip and
    // still re-validates as canonical.
    expect(() => validateCreativeThesis(handle.creativeThesis!)).not.toThrow();
  });

  it('creates the executable artifact through the production coordinator/orchestrator seam', async () => {
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const result = await coordinator.createInteractiveArtifact(
      'Apply keyboard operation and reduced motion.',
      { runtimeSeed: 'product-path', revisionsApplied: 1 },
    );
    expect(result.creativeRun.record.status).toBe('completed');
    expect(result.trace.identity.runtimeId).toBe('runtime-product-path');
    expect(() => assertInteractiveArtifactIdentity(result.html, result.trace.identity)).not.toThrow();
    expect(result.html).toContain("primary.addEventListener('click'");
  });

  it('atomically permits only one interaction revision per request key', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const coordinator = new CreativeRunCoordinator({ persistence });
    const options = { requestKey: 'bounded-revision-request' };

    const baseline = await coordinator.createInteractiveArtifact(
      'Apply keyboard operation.',
      { runtimeSeed: 'baseline', revisionsApplied: 0 },
      options,
    );
    expect(baseline.creativeRun.record.interactionRevisionsApplied).toBe(0);
    expect((await coordinator.read(options.requestKey))?.record.interactionRevisionsApplied).toBe(0);

    const results = await Promise.allSettled([
      coordinator.createInteractiveArtifact(
        'Apply keyboard operation.',
        { runtimeSeed: 'revision-a', revisionsApplied: 1 },
        options,
      ),
      coordinator.createInteractiveArtifact(
        'Apply keyboard operation.',
        { runtimeSeed: 'revision-b', revisionsApplied: 1 },
        options,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/already been consumed/) }),
    });
    expect((await coordinator.read(options.requestKey))?.record).toMatchObject({
      interactionRevisionsApplied: 1,
      status: 'completed',
    });
  });
});
