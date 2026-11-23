import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CREATIVE_PRINCIPLE_MANIFEST,
  CREATIVE_PRINCIPLE_MANIFEST_SCHEMA,
  FORM_TYPOGRAPHY_ROWS,
  INTERACTION_A11Y_SOURCE_ROWS,
  compileCreativeThesis,
  detectProjectionSourceDrift,
  projectCreativePrinciple,
  resolveCreativePrinciple,
  creativeThesisPromptContext,
  embedCreativeThesisIdentity,
  validateCreativeThesis,
  validateCreativePrincipleContract,
  validateFormTypographyManifest,
} from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('canonical creative intelligence', () => {
  it('pins the W8-09 vocabulary order and literal source digests', () => {
    expect(INTERACTION_A11Y_SOURCE_ROWS.map((row) => row.name)).toEqual([
      'Keyboard Operation', 'Focus Visibility', 'Focus Order', 'Semantic Naming', 'Semantic State', 'Reduced Motion',
      'Mouse Drag', 'Touch Swipe', 'Tap', 'Hover', 'Pinch', 'Click', 'Focus Ring', 'ARIA Live Region',
      'Screen Reader Bypass', 'Form Submit', 'Checkbox Toggle', 'Color Independence', 'Cognitive Load', 'Multi-Modal Input',
    ]);
    expect(INTERACTION_A11Y_SOURCE_ROWS.map((row) => row.sourceDigest)).toEqual([
      '00b83768bbdd98b70b427d60023697ae78f9006c45bf6be284e2013c5191c300',
      'c7dd4349bdc8c77882dc6e885dfcf5820a7556c98f9ca8b7e0c9dd25c11844f3',
      '5a401e2f36be18c91d6eea9f3375bc5f691ef1b225c4ec9c5ed540ac9b0a370b',
      '7d2bdbc8eed48de09d4cdd0139f749ef63ed9f2476987cefc21a1141f7ee0981',
      'ad6eaf6c76dece1e322bf31035c5082de2c4bae596e4d712adc2aadabbf88c82',
      'c9fc2b1a91e5a2274d488c9f4c7f46a49b2d8a67deaacfb29ac20616eceaeee1',
      'b53efeb7726c97721b5de0a0729ff861c9dea6d3a9f2186957ad8d201fb93106',
      '25490a24d72f10098b27dd013be6f60899843093b48ded10ee215b3f4535eb94',
      'ca2924617340b9164898e90630a098671677112ec55393c4066cd205841c3ae4',
      'd3cf263cd91906878bdad5cba8180f74383dbf21414694adc2eba61cbf5a3425',
      '01969d343c7b91f4b214b9dc18a75ec4f19d56a99d282f4f0d6169f81574e75b',
      '8d6e2eccf42e7852158e70e76797cdb5ea9020388816c52cccba9bd95a4f4a3f',
      'd16b897f3c8a9450dc6269157516b56b7b6b8cc023809a5c3350a26dac614909',
      'ed02ef1be1278a0cd04b43205b3903f957f7c74049110cab37853ae11eabaf0e',
      '3bc1f39494c0bc6484be90069ced1fdfa48f445bb5feef0ec6926e6c43788c57',
      '9d561e3c5c67115e3d0f63e0cbef34e822881c265723fb6d5bc5c1a3e71cc581',
      '27b25c3563436206096e320c5930fadca3aa793385c3007fd41d0d988ff99a39',
      'c0933097c9a8184bb361a654099a0ca5f47e2fc814d960604214ceb39f4a2ff4',
      '99fe83d121a2527573030f97e1bc2afc98d8f31935b4e969ae890030a5dd406a',
      'c9f51c2344ca733c94ed63b581bdf119061c3deaa9da36087eae9d5f949a7686',
    ]);
  });

  it('freezes every discovered form and typography row with a terminal disposition', () => {
    expect(Object.isFrozen(FORM_TYPOGRAPHY_ROWS)).toBe(true);
    expect(validateFormTypographyManifest(FORM_TYPOGRAPHY_ROWS).length).toBe(8);
    expect(FORM_TYPOGRAPHY_ROWS.map((row) => row.disposition)).toEqual([
      'supported', 'supported', 'supported', 'supported', 'supported', 'historical', 'historical', 'unsupported',
    ]);
    expect(FORM_TYPOGRAPHY_ROWS.filter((row) => row.disposition === 'supported')
      .every((row) => row.scenarioCoverage.length > 0 && row.reachability.createEntryPoints.length > 0)).toBe(true);
    expect(FORM_TYPOGRAPHY_ROWS.filter((row) => row.disposition !== 'supported')
      .every((row) => row.reachability.createEntryPoints.length === 0 && row.boundedRevision.maxAttempts === 0)).toBe(true);
  });

  it('accepts the complete supported contract and resolves aliases', () => {
    const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts.contrast;
    expect(validateCreativePrincipleContract(contract)).toEqual(contract);
    expect(resolveCreativePrinciple('juxtaposition')?.identity.id).toBe('contrast');
    expect(resolveCreativePrinciple('CONTRAST')?.identity.id).toBe('contrast');
  });

  it('rejects a contract with a missing required field', () => {
    const incomplete = { ...CREATIVE_PRINCIPLE_MANIFEST.contracts.contrast } as Record<string, unknown>;
    delete incomplete.theory;
    expect(() => validateCreativePrincipleContract(incomplete)).toThrow(/theory/);
  });

  it('projects deterministically and detects projection/source drift', () => {
    const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts.contrast;
    const first = projectCreativePrinciple(contract);
    expect(first).toBe(projectCreativePrinciple(contract));
    expect(detectProjectionSourceDrift(contract, first).drift).toBe(false);
    expect(detectProjectionSourceDrift(contract, `${first}\nchanged`).drift).toBe(true);
    expect(CREATIVE_PRINCIPLE_MANIFEST.schema).toBe(CREATIVE_PRINCIPLE_MANIFEST_SCHEMA);
  });

  it('returns a cited, example-free thesis for an ordinary-language brief', () => {
    const thesis = compileCreativeThesis('A quiet scene that moves from restraint into a luminous release.');
    expect(thesis.disposition).toBe('supported');
    expect(thesis.exampleFree).toBe(true);
    expect(thesis.principles[0].contractIdentity.principleId).toBe('contrast');
    expect(thesis.citations[0].contractVersion).toBe(1);
    expect(thesis.citations[0].locator).toContain('src/brain/comprehensive-artistic-knowledge.ts');
    expect(JSON.stringify(thesis)).not.toMatch(/for example|e\.g\.|for instance/i);
  });

  it('selects supported form and typography rows with evidence and a bounded revision', () => {
    const thesis = compileCreativeThesis('A restrained typographic field opens into a legible focal release.');
    expect(thesis.formTypography!.selected.map((row) => row.rowId)).toEqual([
      'form-visual-hierarchy', 'typography-hierarchy', 'typography-spacing',
    ]);
    expect(thesis.formTypography!.rationale).toContain('typography');
    expect(thesis.formTypography!.declaredTargets.length).toBe(3);
    expect(thesis.formTypography!.boundedRevision.maxAttempts).toBe(1);
  });

  it('keeps declared form/typography targets distinct from observed render-gate evidence', () => {
    const thesis = compileCreativeThesis('A restrained typographic field opens into a legible focal release.');
    // Declared targets are explicit, named design targets — they are NOT measurements.
    const targets = thesis.formTypography!.declaredTargets;
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => typeof t.rowId === 'string' && typeof t.metric === 'string' && typeof t.target === 'string')).toBe(true);
    expect(targets.map((t) => t.metric)).toEqual([
      'focal-to-supporting scale ratio',
      'heading-to-body scale ratio',
      'body line spacing',
    ]);
    // Honest revision contract: the trigger names the render-gate luminance path,
    // not the (unmeasured) declared targets.
    const trigger = thesis.formTypography!.boundedRevision.trigger.toLowerCase();
    expect(trigger).toMatch(/render-gate|luminance/);
    expect(trigger).not.toMatch(/misses?\s+(its\s+)?target/);
    // Prompt context labels these as DECLARED, not as measurements.
    const ctx = creativeThesisPromptContext(thesis);
    expect(ctx).toContain('formTypographyDeclaredTargets=');
    expect(ctx.toLowerCase()).not.toContain('measurableEvidence');
    expect(ctx.toLowerCase()).not.toContain('measurable evidence');
  });

  it('records an unsupported disposition without silently substituting a principle', () => {
    const thesis = compileCreativeThesis('Use the chiaroscuro principle for this study.');
    expect(thesis.disposition).toBe('unsupported');
    expect(thesis.unsupported[0].requested).toBe('chiaroscuro');
    expect(thesis.principles.some((principle) => principle.disposition === 'unsupported')).toBe(true);
  });

  it('rejects incomplete and tampered thesis material before prompt context can crash', () => {
    const thesis = compileCreativeThesis('A restrained field opens into luminous release.');
    const incomplete = structuredClone(thesis) as Record<string, unknown>;
    delete incomplete.perceptualEmotionalArc;
    expect(() => validateCreativeThesis(incomplete)).toThrow(/perceptualEmotionalArc/);

    const tampered = structuredClone(thesis);
    tampered.citations[0].locator = 'src/elsewhere.ts#Contrast';
    expect(() => validateCreativeThesis(tampered)).toThrow(/canonical|citation|correspondence/i);
    expect(() => creativeThesisPromptContext(thesis)).not.toThrow();
  });

  it('migrates a prior-v1 thesis (no formTypography) into the canonical shape', () => {
    const modern = compileCreativeThesis('A restrained field opens into luminous release.');
    // Simulate a prior-v1 thesis persisted before `formTypography` existed.
    const priorV1 = structuredClone(modern) as Record<string, unknown>;
    delete priorV1.formTypography;
    // Validation must accept even an immutable prior-v1 payload without changing
    // the caller-owned object. The returned value carries the canonical default.
    const frozenPriorV1 = Object.freeze(priorV1);
    const migrated = validateCreativeThesis(frozenPriorV1) as { formTypography?: { declaredTargets: unknown[] } };
    expect(frozenPriorV1).not.toHaveProperty('formTypography');
    expect(migrated.formTypography).toEqual(expect.objectContaining({ declaredTargets: expect.arrayContaining([expect.any(Object)]) }));
    expect(migrated.formTypography!.declaredTargets.length).toBeGreaterThan(0);
    // A field-level tampering (deleting perceptualEmotionalArc) is still rejected
    // — migration only fills formTypography; it does not loosen other required fields.
    const brokenV1 = structuredClone(priorV1) as Record<string, unknown>;
    delete brokenV1.briefDigest;
    expect(() => validateCreativeThesis(brokenV1)).toThrow(/briefDigest/);
  });

  it('reaches production composition through the coordinator with one identity', async () => {
    const result = await new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() }).compose({
      layers: [{ domain: 'html', prompt: 'focal field', code: '<div>focal</div>' }],
    }, { requestKey: 'principle-production-reachability', entryPoint: 'cli-compose' });
    const thesis = result.creativeRun.creativeThesis!;
    expect(result.creativeThesis?.thesisId).toBe(thesis.thesisId);
    expect(result.html).toContain(`sinter-creative-thesis-id" content="${thesis.thesisId}`);
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
  }, 60_000);

  it('fails closed before provider reservation for an unsupported principle', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
    await expect(coordinator.start({ entryPoint: 'studio-session', prompt: 'Use chiaroscuro principle' })).rejects.toThrow(/unsupported/);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('normalizes frozen-row separators and fails closed before reservation without partial-alias false positives', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
    await expect(coordinator.start({ entryPoint: 'studio-session', prompt: 'Use HSB HSL controls.' })).rejects.toThrow(/unsupported/);
    expect(reserve).not.toHaveBeenCalled();

    expect(compileCreativeThesis('Use HSB controls for a quiet field.').disposition).toBe('supported');
  });

  it('exposes form and typography rationale/declared-targets through a real no-spend Create artifact', async () => {
    // Hermetic: the measured-frame gate launches a real browser; it is not under test here.
    vi.stubEnv('SINTER_COMPOSITE_GATE', '0');
    const result = await new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() }).compose({
      title: 'Readable release',
      layers: [{ domain: 'html', prompt: 'typographic hierarchy with focal release', code: '<div>Readable release</div>' }],
    }, { requestKey: 'form-typography-production-reachability', entryPoint: 'cli-compose' });
    expect(result.creativeThesis?.formTypography?.selected[0].rowId).toBe('form-visual-hierarchy');
    expect(result.html).toContain('sinter-form-typography-rationale');
    expect(result.html).toContain('sinter-form-typography-provenance');
    expect(result.html).toContain('sinter-form-typography-excluded');
    expect(result.creativeThesis?.formTypography?.selected[0].sourceLocator).toContain('COMPOSITION/Visual Hierarchy');
    // Renamed meta honestly labels these as declared targets.
    expect(result.html).toContain('sinter-form-typography-declared-targets');
    expect(result.html).not.toContain('sinter-form-typography-evidence');
    expect(result.html).toContain('sinter-form-typography-revision-max" content="1"');
    expect(result.creativeEvidence?.selectedRows).toEqual(['form-visual-hierarchy', 'typography-hierarchy', 'typography-spacing']);
    // Honest evidence separation: declaredTargets is the plan's declared list;
    // gateEvidence is undefined here because the render gate is disabled.
    expect(result.creativeEvidence?.declaredTargets[0].metric).toBe('focal-to-supporting scale ratio');
    expect(result.creativeEvidence?.declaredTargets.length).toBe(3);
    expect(result.creativeEvidence?.gateEvidence).toBeUndefined();
  });
});

describe('embedCreativeThesisIdentity (non-mutating provenance)', () => {
  // Use a brief that selects multiple rows so cssProperties would have covered
  // body/main/h1/h2 in the prior global-style implementation.
  const thesis = compileCreativeThesis('A typographic field with focal hierarchy and negative-space contrast.');

  it('does not inject any global <style> that would mutate generated artwork', () => {
    const html = '<!DOCTYPE html><html><head><title>art</title></head><body><main>art</main></body></html>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    expect(embedded).not.toMatch(/<style[^>]*data-sinter-form-typography/i);
    expect(embedded).not.toMatch(/<style[^>]*>[\s\S]*?(?:^|[\s{])(?:body|main|h1|h2)\s*\{/i);
  });

  it('places metas inside an existing <head> and never before the doctype', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body><main>art</main></body></html>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    const doctypeIdx = embedded.indexOf('<!DOCTYPE');
    const headIdx = embedded.indexOf('<head');
    const firstMetaIdx = embedded.indexOf('<meta name="sinter-');
    expect(doctypeIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeGreaterThan(doctypeIdx);
    expect(firstMetaIdx).toBeGreaterThan(headIdx);
  });

  it('synthesizes a valid <head> when the document has an <html> root but no <head>', () => {
    const html = '<!DOCTYPE html><html><body><main>art</main></body></html>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    const doctypeIdx = embedded.indexOf('<!DOCTYPE');
    const headIdx = embedded.indexOf('<head>');
    const headCloseIdx = embedded.indexOf('</head>');
    const bodyIdx = embedded.indexOf('<body');
    expect(headIdx).toBeGreaterThan(doctypeIdx);
    expect(headCloseIdx).toBeGreaterThan(headIdx);
    expect(bodyIdx).toBeGreaterThan(headCloseIdx);
    expect(embedded.slice(headIdx, headCloseIdx)).toContain('sinter-form-typography-declared-targets');
  });

  it('inserts a <head> after a lone doctype (no html/head) rather than before it', () => {
    const html = '<!DOCTYPE html><body><main>art</main></body>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    expect(embedded.indexOf('<!DOCTYPE')).toBe(0);
    expect(embedded.indexOf('<head>')).toBeGreaterThan(embedded.indexOf('<!DOCTYPE'));
    expect(embedded.indexOf('sinter-form-typography-declared-targets')).toBeGreaterThan(embedded.indexOf('<head>'));
  });

  it('wraps a body-only input with a valid html/head structure', () => {
    const html = '<body><main>art</main></body>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    expect(embedded.startsWith('<html><head>')).toBe(true);
    expect(embedded.indexOf('</head>')).toBeLessThan(embedded.indexOf('<body'));
    expect(embedded.slice(embedded.indexOf('<body'), embedded.indexOf('</body>'))).not.toContain('<meta');
  });

  it('promotes a pure fragment to a valid minimal document', () => {
    const html = '<div>standalone art</div>';
    const embedded = embedCreativeThesisIdentity(html, thesis);
    expect(embedded.startsWith('<!DOCTYPE html><html><head>')).toBe(true);
    expect(embedded).toContain('sinter-form-typography-declared-targets');
    expect(embedded).toContain('<div>standalone art</div>');
    expect(embedded.indexOf('</head>')).toBeLessThan(embedded.indexOf('<body'));
    expect(embedded.slice(embedded.indexOf('<body'), embedded.indexOf('</body>'))).not.toContain('<meta');
    expect(embedded).toContain('data-creative-thesis-id=');
  });
});
