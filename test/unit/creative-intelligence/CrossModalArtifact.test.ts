import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CROSS_MODAL_CONTRACTS,
  CROSS_MODAL_MANIFEST,
  buildCrossModalArtifact,
  closeCrossModalManifest,
  deriveCrossModalTimingSamples,
  validateCrossModalRuntimeReceipt,
  type CrossModalContract,
  type CrossModalManifestRow,
  type CrossModalRuntimeReceipt,
} from '../../../src/creative-intelligence/CrossModalArtifact.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import {
  CreativeRunCoordinator,
  MemoryCreativeRunPersistence,
} from '../../../src/creative-run/CreativeRunCoordinator.js';

const BRIEF = 'A luminous field whose motion responds to a musical pulse and one accessible control.';

function replaceRow(id: string, patch: Partial<CrossModalManifestRow>): CrossModalManifestRow[] {
  return CROSS_MODAL_MANIFEST.map((row) => row.id === id ? { ...row, ...patch } : row);
}

function executeArtifactHtml(
  html: string,
  durationSeconds = 4,
  virtualConsole?: VirtualConsole,
): JSDOM {
  return new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get: () => durationSeconds,
      });
    },
  });
}

describe('frozen cross-modal and emergence manifest', () => {
  it('closes exactly the three bounded terminal denominators', () => {
    const closure = closeCrossModalManifest();
    expect(CROSS_MODAL_MANIFEST).toHaveLength(8);
    expect(closure.disposition).toEqual({ total: 8, dispositioned: 8, closed: true });
    expect(closure.supported).toEqual({
      total: 4,
      contractValid: 4,
      runtimeReachable: 4,
      scenarioCovered: 4,
      closed: true,
    });
    expect(closure.excluded).toEqual({ total: 4, unreachable: 4, closed: true });
    expect(closure.scope).toBe('frozen-wave-8-cross-modal-manifest-only');
    expect(closure.claim).toContain('no universal artistic mastery');
  });

  it('keeps every excluded row unreachable', () => {
    for (const row of CROSS_MODAL_MANIFEST.filter((candidate) => candidate.disposition !== 'supported')) {
      expect(row.contractId, row.id).toBeNull();
      expect(row.runtimePath, row.id).toBeNull();
      expect(row.scenarioIds, row.id).toEqual([]);
    }
  });

  it('rejects an undispositioned or duplicate manifest row', () => {
    const undispositioned = replaceRow('audio-reactivity', {
      disposition: 'missing' as CrossModalManifestRow['disposition'],
    });
    expect(() => closeCrossModalManifest(undispositioned)).toThrow(/undispositioned/);
    expect(() => closeCrossModalManifest([
      ...CROSS_MODAL_MANIFEST,
      CROSS_MODAL_MANIFEST[0]!,
    ])).toThrow(/duplicate row/);
  });

  it('rejects an invalid supported contract', () => {
    const invalid = {
      ...CROSS_MODAL_CONTRACTS,
      'audio-visual-reactivity': {
        ...CROSS_MODAL_CONTRACTS['audio-visual-reactivity'],
        observableIds: [],
      } as CrossModalContract,
    };
    expect(() => closeCrossModalManifest(CROSS_MODAL_MANIFEST, invalid)).toThrow(/validity denominator/);
  });

  it('rejects a supported row that is unreachable or scenario-uncovered', () => {
    expect(() => closeCrossModalManifest(replaceRow('audio-reactivity', {
      runtimePath: null,
    }))).toThrow(/runtime-reachability denominator/);
    expect(() => closeCrossModalManifest(replaceRow('audio-reactivity', {
      scenarioIds: [],
    }))).toThrow(/scenario-coverage denominator/);
  });

  it('rejects an excluded row that becomes reachable', () => {
    expect(() => closeCrossModalManifest(replaceRow('video-processing', {
      runtimePath: 'src/creative-intelligence/CrossModalArtifact.ts#buildCrossModalArtifact',
    }))).toThrow(/excluded-unreachability denominator/);
  });
});

describe('deterministic cross-modal artifact', () => {
  it('builds one playable four-role graph with causal handoffs', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF, artifactId: 'causal-work' });
    expect(artifact.graph.nodes.map((node) => node.id)).toEqual([
      'interaction-role', 'audio-role', 'motion-role', 'visual-role',
    ]);
    expect(artifact.plan.schedule).toEqual([
      'interaction-role', 'audio-role', 'motion-role', 'visual-role',
    ]);
    expect(artifact.plan.usage).toEqual({ nodes: 4, edges: 0, providerCalls: 0 });
    expect(artifact.graph.controls?.map((control) => control.id)).toEqual([
      'interaction-to-audio',
      'interaction-to-visual',
      'audio-energy-to-motion',
      'motion-phase-to-visual',
    ]);
    expect(artifact.graph.bridges).toEqual([
      { id: 'audio-to-visual-clock', fromIslandId: 'audio-island', toIslandId: 'visual-island', mode: 'sample' },
    ]);
  });

  it('binds actual changed values and coherent timestamps to the exact artifact', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    expect(artifact.evidence.artifactDigest).not.toBe(artifact.artifactDigest);
    expect(artifact.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.evidence.graphDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.evidence.schedule).toEqual(artifact.plan.schedule);
    expect(artifact.evidence.audioArtifactDigest).toBe(artifact.audioArtifact.evidence.artifactDigest);
    expect(artifact.evidence.thesisId).toBe(artifact.thesis.thesisId);
    expect(artifact.evidence.observables).toHaveLength(6);
    expect(artifact.evidence.observables.every((observable) => observable.changed
      && observable.before !== observable.after)).toBe(true);
    expect(artifact.evidence.durationMs).toBe(4_000);
    expect(artifact.evidence.timingSamples).toHaveLength(16);
    expect(artifact.evidence.timingSamples[8]?.timeMs).toBe(2_000);
    expect(artifact.evidence.timingSamples.at(-1)).toMatchObject({
      tick: 15,
      timeMs: 3_750,
      windowEndMs: 4_000,
      motionPhase: 1,
    });
    for (const sample of artifact.evidence.timingSamples) {
      expect(sample.audioEnergy).toBeGreaterThanOrEqual(0);
      expect(sample.audioEnergy).toBeLessThanOrEqual(1);
      expect(sample.visualRadius).toBeCloseTo(24 + sample.audioEnergy * 0.35 * 48 + sample.motionPhase * 8, 2);
    }
  });

  it('renders playable audio, semantic interaction, and executable causal mappings', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    expect(artifact.html).toContain('data:audio/wav;base64,');
    expect(artifact.html).toContain(`data-audio-artifact-digest="${artifact.audioArtifact.evidence.artifactDigest}"`);
    expect(artifact.html).toContain('aria-pressed="false"');
    expect(artifact.html).toContain('id="sinter-cross-modal-runtime-spec"');
    expect(artifact.html).toContain('id="sinter-cross-modal-runtime-receipt"');
    expect(artifact.html).not.toContain('tick%samples.length');
    expect(artifact.html).toContain('id="sinter-cross-modal-evidence"');

    const dom = executeArtifactHtml(artifact.html);
    const receiptNode = dom.window.document.querySelector('#sinter-cross-modal-runtime-receipt');
    const receipt = JSON.parse(receiptNode?.textContent ?? '') as CrossModalRuntimeReceipt;
    expect(validateCrossModalRuntimeReceipt(artifact, receipt)).toEqual(artifact.evidence.runtimeReceipt);

    (dom.window.document.querySelector('button') as HTMLButtonElement).click();
    const activeReceipt = JSON.parse(receiptNode?.textContent ?? '') as CrossModalRuntimeReceipt;
    expect(validateCrossModalRuntimeReceipt(artifact, activeReceipt).handoffs.map((handoff) => handoff.controlId)).toEqual([
      'interaction-to-audio', 'audio-energy-to-motion', 'interaction-to-visual', 'motion-phase-to-visual',
    ]);
    expect(activeReceipt.handoffs.find((handoff) => handoff.controlId === 'audio-energy-to-motion')?.value)
      .toBeGreaterThan(receipt.handoffs.find((handoff) => handoff.controlId === 'audio-energy-to-motion')?.value ?? 0);
    expect(activeReceipt.handoffs.find((handoff) => handoff.controlId === 'motion-phase-to-visual')?.value)
      .toBeGreaterThan(receipt.handoffs.find((handoff) => handoff.controlId === 'motion-phase-to-visual')?.value ?? 0);
    const audio = dom.window.document.querySelector('audio') as HTMLAudioElement;
    expect(audio.volume).toBe(0.8);
    expect(dom.window.document.querySelector('circle')?.getAttribute('fill')).toBe('hsl(260 80% 55%)');
    audio.currentTime = 3.99;
    audio.dispatchEvent(new dom.window.Event('timeupdate'));
    const endingReceipt = JSON.parse(receiptNode?.textContent ?? '') as CrossModalRuntimeReceipt;
    expect(validateCrossModalRuntimeReceipt(artifact, endingReceipt)).toMatchObject({
      tick: 15,
      timeMs: 3_750,
      windowEndMs: 4_000,
    });
    audio.currentTime = 4;
    audio.dispatchEvent(new dom.window.Event('timeupdate'));
    expect(validateCrossModalRuntimeReceipt(
      artifact,
      JSON.parse(receiptNode?.textContent ?? '') as CrossModalRuntimeReceipt,
    ).tick).toBe(15);
    dom.window.close();
  });

  it('fails closed when graph execution is reordered or a causal handoff is bypassed', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const receipt = artifact.evidence.runtimeReceipt;
    const reordered = {
      ...receipt,
      schedule: [...receipt.schedule].reverse(),
      started: [...receipt.started].reverse(),
      completed: [...receipt.completed].reverse(),
    };
    expect(() => validateCrossModalRuntimeReceipt(artifact, reordered)).toThrow(/artifact-bound graph execution/);

    const bypassed = {
      ...receipt,
      controls: receipt.controls.filter((id) => id !== 'audio-energy-to-motion'),
      handoffs: receipt.handoffs.filter((handoff) => handoff.controlId !== 'audio-energy-to-motion'),
    };
    expect(() => validateCrossModalRuntimeReceipt(artifact, bypassed)).toThrow(/artifact-bound graph execution/);
  });

  it.each([
    ['reordered schedule',
      '"schedule":["interaction-role","audio-role","motion-role","visual-role"]',
      '"schedule":["audio-role","interaction-role","motion-role","visual-role"]'],
    ['bypassed control', '"id":"audio-energy-to-motion"', '"id":"audio-energy-bypassed"'],
    ['non-finite handoff input', '"audioEnergy":1', '"audioEnergy":null'],
    ['duration mismatch', '"durationMs":4000', '"durationMs":3750'],
  ])('fails the emitted runtime for a %s', (_label, before, after) => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const runtimeErrors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));
    const tamperedHtml = artifact.html.replace(before, after);
    expect(tamperedHtml).not.toBe(artifact.html);
    expect(tamperedHtml).not.toContain('"status":"completed"');

    const dom = executeArtifactHtml(tamperedHtml, 4, virtualConsole);
    const receipt = JSON.parse(dom.window.document
      .querySelector('#sinter-cross-modal-runtime-receipt')?.textContent ?? '{}') as { status?: string };
    expect(receipt.status).toBe('failed');
    expect(runtimeErrors.join(' ')).toContain('Uncaught');
    dom.window.close();
  });

  it('fails with one authoritative receipt when the interaction button is missing', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const runtimeErrors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));
    const html = artifact.html.replace(
      '<button type="button" aria-pressed="false">Intensify audiovisual response</button>',
      '',
    );
    const dom = executeArtifactHtml(html, 4, virtualConsole);
    const receipts = dom.window.document.querySelectorAll('#sinter-cross-modal-runtime-receipt');
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]?.textContent ?? '{}')).toMatchObject({
      status: 'failed',
      reason: 'Cross-modal runtime is missing a required DOM node',
    });
    expect(runtimeErrors.join(' ')).toContain('Uncaught');
    dom.window.close();
  });

  it('fails with one authoritative receipt for an infinite media duration', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const runtimeErrors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));
    const dom = executeArtifactHtml(artifact.html, Number.POSITIVE_INFINITY, virtualConsole);
    const receipts = dom.window.document.querySelectorAll('#sinter-cross-modal-runtime-receipt');
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]?.textContent ?? '{}')).toMatchObject({
      status: 'failed',
      reason: 'Cross-modal media duration is non-finite or non-positive',
    });
    expect(runtimeErrors.join(' ')).toContain('Uncaught');
    dom.window.close();
  });

  it.each([
    ['NaN metadata', Number.NaN],
    ['zero duration', 0],
  ])('never completes a graph tick for %s', (_label, duration) => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const virtualConsole = new VirtualConsole();
    const dom = executeArtifactHtml(artifact.html, duration, virtualConsole);
    const audio = dom.window.document.querySelector('audio') as HTMLAudioElement;
    audio.dispatchEvent(new dom.window.Event('loadedmetadata'));
    const receipt = JSON.parse(dom.window.document
      .querySelector('#sinter-cross-modal-runtime-receipt')?.textContent ?? '{}');
    expect(receipt).toMatchObject({
      status: 'failed',
      reason: 'Cross-modal media duration is non-finite or non-positive',
    });
    dom.window.close();
  });

  it('fails the emitted runtime outside the exact governed playback duration', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const runtimeErrors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));
    const dom = executeArtifactHtml(artifact.html, 4, virtualConsole);
    const audio = dom.window.document.querySelector('audio') as HTMLAudioElement;
    const receiptNode = dom.window.document.querySelector('#sinter-cross-modal-runtime-receipt');
    expect(JSON.parse(receiptNode?.textContent ?? '{}')).toMatchObject({ status: 'completed' });

    audio.currentTime = 4.001;
    audio.dispatchEvent(new dom.window.Event('timeupdate'));
    expect(JSON.parse(receiptNode?.textContent ?? '{}')).toMatchObject({
      status: 'failed',
      reason: 'Audio time is outside governed PCM duration',
    });
    expect(runtimeErrors.join(' ')).toContain('Uncaught');
    dom.window.close();
  });

  it('rejects governed-duration drift instead of stretching or looping evidence', () => {
    const artifact = buildCrossModalArtifact({ brief: BRIEF });
    const driftedAudio = {
      ...artifact.audioArtifact,
      evidence: {
        ...artifact.audioArtifact.evidence,
        observed: {
          ...artifact.audioArtifact.evidence.observed,
          durationSeconds: 3.75,
        },
      },
    };
    expect(() => deriveCrossModalTimingSamples(driftedAudio)).toThrow(/duration drifted/);
  });

  it('is deterministic for the same brief and changes identity for a new brief', () => {
    const first = buildCrossModalArtifact({ brief: BRIEF });
    const replay = buildCrossModalArtifact({ brief: BRIEF });
    const changed = buildCrossModalArtifact({ brief: `${BRIEF} Make the release more restrained.` });
    expect(replay.artifactDigest).toBe(first.artifactDigest);
    expect(replay.html).toBe(first.html);
    expect(changed.artifactDigest).not.toBe(first.artifactDigest);
  });

  it('hashes an explicit source-candidate binding without inventing one for legacy callers', () => {
    const unbound = buildCrossModalArtifact({ brief: BRIEF });
    const first = buildCrossModalArtifact({
      brief: BRIEF, sourceCandidateArtifactDigest: '0'.repeat(16),
    });
    const second = buildCrossModalArtifact({
      brief: BRIEF, sourceCandidateArtifactDigest: '1'.repeat(16),
    });
    expect(unbound.sourceCandidateArtifactDigest).toBeNull();
    expect(first.html).toBe(second.html);
    expect(first.artifactDigest).not.toBe(second.artifactDigest);
  });

  it('accepts a non-music product thesis when audio is not the sealed product principle', () => {
    // Path B: visual/contrast product campaigns must still emit cross-modal
    // owner-review evidence without forcing generation onto music-dynamics.
    const productThesis = compileCreativeThesis(
      'A distinct sealed creative thesis for temporal-candidate-1: concept-0-1, structure-1, time-phase-1.',
    );
    expect(productThesis.principles[0]?.principleId).not.toMatch(/^music-/);
    const artifact = buildCrossModalArtifact({
      brief: productThesis.intendedExperienceMeaning,
      thesis: productThesis,
      sourceCandidateArtifactDigest: 'a'.repeat(64),
    });
    expect(artifact.thesis.thesisId).toBe(productThesis.thesisId);
    expect(artifact.thesis.principles[0]?.principleId).toBe(productThesis.principles[0]?.principleId);
    expect(artifact.audioArtifact.evidence.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.html).toContain('data:audio/wav;base64,');
  });

  it('fails before producing an artifact when a denominator is open', () => {
    const uncovered = replaceRow('cross-domain-crossover', { scenarioIds: [] });
    expect(() => buildCrossModalArtifact({ brief: BRIEF, manifest: uncovered })).toThrow(/scenario-coverage/);
  });

  it('runs through the coordinator without provider reservation', async () => {
    const reserveProvider = vi.fn(async () => ({ id: 'must-not-run', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider,
    });
    const result = await coordinator.composeCrossModal({ brief: BRIEF, requestKey: 'cross-modal-product-path' });
    expect(reserveProvider).not.toHaveBeenCalled();
    expect(result.creativeRun.record.status).toBe('completed');
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
    expect(result.creativeRun.creativeThesis?.thesisId).toBe(result.crossModalArtifact.thesis.thesisId);
    expect(result.html).toBe(result.crossModalArtifact.html);
  });

});
