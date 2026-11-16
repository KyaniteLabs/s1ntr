import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../../src/llm/LLMClient.js';
import { createTestReceiptAuthority } from
  '../../src/runtime-core/LiminalCommandService.js';
import { FileLiminalArtifactStore } from
  '../../src/runtime-core/LiminalCommandFilePersistence.js';
import { assertProductionDreamRuntimeOptions, bootstrapProductionDreamRuntime,
  bootstrapProductionLiminalRuntime,
  createProductionLiminalRuntime,
  loadProductionDreamRuntimeOptions, resolveProductionDreamKeys,
  resolveProductionDreamProviderAttemptBudget,
  resolveProductionSourceRefs,
  sealProductionDreamRuntimeOptions } from
  '../../src/runtime-core/ProductionLiminalRuntime.js';
import { assertProductionDreamAdapters, dreamClientIdentity,
  LLMDreamCreativeOperator, LLMDreamTransferProducer } from
  '../../src/runtime-core/ProductionDreamHostAdapters.js';
import { createTestLiminalOwnerReviewAuthority } from
  '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';

const digest = (char: string) => char.repeat(64);

describe('production Liminal runtime bootstrap', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('reserves the complete seven-call Dream discovery and transfer budget', () => {
    expect(resolveProductionDreamProviderAttemptBudget()).toBe(7);
    expect(resolveProductionDreamProviderAttemptBudget('7')).toBe(7);
    expect(() => resolveProductionDreamProviderAttemptBudget('6'))
      .toThrow('DREAM_PRODUCTION_PROVIDER_CAP_INVALID');
    expect(() => resolveProductionDreamProviderAttemptBudget('8'))
      .toThrow('DREAM_PRODUCTION_PROVIDER_CAP_INVALID');
  });

  it('requires one sealed complete Dream host-adapter authority', () => {
    const complete = { budget: { maxCandidates: 1, maxProviderAttempts: 3 },
      template: { campaignId: 'wave-8' }, leaseAuthority: {}, executor: () => ({}),
      leaseAuthorityIdentityDigest: digest('b'), executorIdentityDigest: digest('c'),
      transfer: { producerIdentityDigest: digest('d'), observerIdentityDigest: digest('e'),
        rendererIdentityDigest: digest('f'),
        holdout: { custodyId: 'h', bytes: 'secret', selectorDigest: digest('1'),
        custodianDigest: digest('2'), protocol: {} }, producer: {}, observer: {},
      evaluators: [{ identity: { identityDigest: digest('3'), hostDigest: digest('4') } },
        { identity: { identityDigest: digest('5'), hostDigest: digest('6') } }],
      activationPolicy: { policyDigest: digest('7') }, compound: {
        policy: { policyDigest: digest('8') }, judges: [
          { identityDigest: digest('9') }, { identityDigest: digest('a') }] } } } as never;
    expect(() => sealProductionDreamRuntimeOptions({ ...complete,
      transfer: undefined } as never)).toThrow('DREAM_PRODUCTION_HOST_ADAPTERS_INCOMPLETE');
    const sealed = sealProductionDreamRuntimeOptions(complete);
    expect(() => assertProductionDreamRuntimeOptions(sealed)).not.toThrow();
    expect(() => assertProductionDreamRuntimeOptions({ ...sealed,
      budget: { maxCandidates: 1, maxProviderAttempts: 4 } }))
      .toThrow('DREAM_PRODUCTION_AUTHORITY_INVALID');
    expect(() => assertProductionDreamRuntimeOptions({ ...sealed,
      executorIdentityDigest: digest('0') }))
      .toThrow('DREAM_PRODUCTION_AUTHORITY_INVALID');
  });

  it('keeps activated-knowledge signing independent from holdout encryption', () => {
    expect(resolveProductionDreamKeys('knowledge-key', 'distinct-holdout-key')).toEqual({
      knowledgeSigningKey: 'knowledge-key', holdoutEncryptionKey: 'distinct-holdout-key',
    });
  });

  it('starts the ordinary product runtime without Dream host configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-product-only-'));
    roots.push(root);
    const client = (role: string) => ({ getConfig: () => ({ provider: 'fake-transport',
      model: role, baseUrl: `http://${role}.invalid/v1` }) }) as never;
    const prior = process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    delete process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    try {
      const runtime = await bootstrapProductionLiminalRuntime({ root,
        generator: client('generator'), evaluator: client('evaluator'),
        renderer: { render: vi.fn(), close: vi.fn(async () => undefined) } as never,
        sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
        harnessIdentity: 'fake/harness', studioIdentity: 'fake/studio',
        receiptAuthority: createTestReceiptAuthority('product-only-secret'),
        ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('owner-only-secret'),
        knowledgeSigningKey: 'knowledge-only-secret' });
      expect(runtime.dream).toBeUndefined();
      await runtime.close();
    } finally {
      if (prior) process.env.SINTER_DREAM_HOST_CONFIG_MODULE = prior;
      else delete process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    }
  });

  it('keeps artifact custody at the output root across state-root restarts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-state-'));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'liminal-output-'));
    roots.push(root, artifactRoot);
    const client = (role: string) => ({ getConfig: () => ({ provider: 'fake', model: role }) }) as never;
    const options = { root, artifactRoot, generator: client('generator'),
      evaluator: client('evaluator'), renderer: { close: vi.fn(async () => undefined) } as never,
      sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
      harnessIdentity: 'fake/harness', studioIdentity: 'fake/studio',
      receiptAuthority: createTestReceiptAuthority('split-root-secret'),
      ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('split-owner-secret'),
      knowledgeSigningKey: 'split-knowledge-secret' };
    const getStore = (runtime: Awaited<ReturnType<typeof createProductionLiminalRuntime>>) =>
      Reflect.get(Reflect.get(runtime.createAuthority, 'options'), 'artifacts') as FileLiminalArtifactStore;
    const artifact = { source: '<svg/>', playable: '<html/>', provenance: 'signed' };
    const first = await createProductionLiminalRuntime(options);
    await getStore(first).persist('split-operation', artifact);
    await first.close();
    const restarted = await createProductionLiminalRuntime(options);
    expect(await getStore(restarted).read('split-operation')).toEqual(artifact);
    expect(await readFile(path.join(artifactRoot, 'artifacts',
      createHash('sha256').update('split-operation').digest('hex'),
      'source.txt'), 'utf8')).toBe('<svg/>');
    await expect(stat(path.join(root, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.close();
    await expect(createProductionLiminalRuntime({ ...options, artifactRoot: 'relative-output' }))
      .rejects.toThrow('LIMINAL_ARTIFACT_ROOT_NOT_ABSOLUTE');
  });

  it('derives Dream identities from concrete adapters and rejects coupled evaluators', () => {
    const client = (role: string, host: string) => ({ getConfig: () => ({
      provider: 'fake-transport', model: role, baseUrl: host }) }) as never;
    const firstClient = client('evaluator-a', 'http://evaluator-a.invalid/v1');
    const secondClient = client('evaluator-b', 'http://evaluator-b.invalid/v1');
    expect(dreamClientIdentity(firstClient)).not.toEqual(dreamClientIdentity(secondClient));
    const adapter = (llm: never) => ({ identity: dreamClientIdentity(llm),
      compare: vi.fn() });
    const base = { operator: { produce: vi.fn() }, producer: { produce: vi.fn() },
      observer: { observe: vi.fn() }, leaseAuthority: { assertActive: vi.fn() } };
    expect(() => assertProductionDreamAdapters({ ...base,
      evaluators: [adapter(firstClient), adapter(secondClient)] as never })).not.toThrow();
    expect(() => assertProductionDreamAdapters({ ...base,
      evaluators: [adapter(firstClient), adapter(firstClient)] as never }))
      .toThrow('DREAM_PRODUCTION_EVALUATORS_NOT_INDEPENDENT');
  });

  it('requires self-contained offline source from discovery and transfer generators', async () => {
    const generated = JSON.stringify({ baseline: { id: 'base', source: '<canvas/>',
      layerIds: ['base'], domains: ['html'] }, variant: { id: 'variant',
      source: '<canvas/>', layerIds: ['variant'], domains: ['html'],
      changedPaths: ['composition.depth'] } });
    const client = { generate: vi.fn().mockResolvedValue({ success: true, code: generated }) };
    const declaration = { id: 'depth', factor: 'depth', compatibleDomains: ['html'],
      protectedInvariants: ['domain'], structuralDiffRules: ['composition.depth'] } as never;
    await new LLMDreamCreativeOperator(declaration, client as never).produce({
      hypothesis: { id: 'h', statement: 'depth', principle: 'depth',
        expectedEffect: 'more depth' } } as never);
    expect(client.generate.mock.calls[0]?.[5]).toMatchObject({
      jsonMode: true, maxTokens: 8_192,
    });
    client.generate.mockResolvedValueOnce({ success: true, code: JSON.stringify({ id: 'transfer',
      source: '<canvas/>', layerIds: ['transfer'], domains: ['html'] }) });
    await new LLMDreamTransferProducer(client as never).produce({ holdout: 'sealed',
      contextDigest: digest('1'), findingDigest: digest('2') });
    expect(client.generate.mock.calls[1]?.[5]).toMatchObject({
      jsonMode: true, maxTokens: 8_192,
    });
    for (const call of client.generate.mock.calls) {
      expect(`${call[0]} ${call[1]}`).toContain('self-contained playable HTML source');
      expect(`${call[0]} ${call[1]}`).toContain('no external URLs');
      expect(`${call[0]} ${call[1]}`).toContain('Generate every visual element locally');
    }
  });

  it.each([
    '<img src="https://example.invalid/a.png">',
    '<style>body{background:url(//example.invalid/a.png)}</style>',
    '<script>fetch("https://example.invalid/data")</script>',
    '<script>new WebSocket("wss://example.invalid")</script>',
    '<iframe srcdoc="local"></iframe>',
  ])('rejects forbidden Dream source before rendering: %s', async (source) => {
    const discoveryClient = { generate: vi.fn().mockResolvedValue({ success: true,
      code: JSON.stringify({ baseline: { id: 'base', source,
        layerIds: ['base'], domains: ['html'] }, variant: { id: 'variant',
        source: '<canvas/>', layerIds: ['variant'], domains: ['html'],
        changedPaths: ['composition.depth'] } }) }) };
    const declaration = { id: 'depth', factor: 'depth', compatibleDomains: ['html'],
      protectedInvariants: ['domain'], structuralDiffRules: ['composition.depth'] } as never;
    await expect(new LLMDreamCreativeOperator(declaration, discoveryClient as never).produce({
      hypothesis: { id: 'h', statement: 'depth', principle: 'depth',
        expectedEffect: 'more depth' } } as never))
      .rejects.toThrow('DREAM_EXTERNAL_RESOURCE_FORBIDDEN');
    const transferClient = { generate: vi.fn().mockResolvedValue({ success: true,
      code: JSON.stringify({ id: 'transfer', source, layerIds: ['transfer'],
        domains: ['html'] }) }) };
    await expect(new LLMDreamTransferProducer(transferClient as never).produce({
      holdout: 'sealed', contextDigest: digest('1'), findingDigest: digest('2') }))
      .rejects.toThrow('DREAM_EXTERNAL_RESOURCE_FORBIDDEN');
  });

  it('uses exact Forgejo PR event refs before failing missing Dream authority', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'liminal-forgejo-detached-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'));
    const sourceSha = 'a'.repeat(40);
    const mainSha = 'b'.repeat(40);
    await writeFile(path.join(repo, '.git', 'HEAD'), `${sourceSha}\n`);
    const eventPath = path.join(repo, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: {
      head: { sha: sourceSha, ref: 'feature/ref-proof' },
      base: { sha: mainSha, ref: 'main' },
    } }));
    const forgejoKeys = ['FORGEJO_ACTIONS', 'GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME',
      'GITHUB_SHA', 'GITHUB_BASE_REF', 'GITHUB_HEAD_REF'] as const;
    const priorForgejo = Object.fromEntries(forgejoKeys.map(key => [key, process.env[key]]));
    const priorModule = process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    const priorHoldout = process.env.SINTER_DREAM_HOLDOUT_FILE;
    const priorRenderer = process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    delete process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    delete process.env.SINTER_DREAM_HOLDOUT_FILE;
    delete process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST;
    Object.assign(process.env, { FORGEJO_ACTIONS: 'true', GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sourceSha,
      GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'feature/ref-proof' });
    try {
      expect(resolveProductionSourceRefs({ repoRoot: repo })).toEqual({
        sourceHeadSha: sourceSha, canonicalMainSha: mainSha,
        sourceKind: 'forgejo-actions-pull-request',
        sourceHeadSource: 'forgejo-actions-github-sha',
        canonicalMainSource: 'forgejo-event-pull-request-base', eventHeadSha: sourceSha,
      });
      await expect(bootstrapProductionDreamRuntime({ repoRoot: repo })).rejects
        .toThrow('DREAM_PRODUCTION_CONFIG_REQUIRED');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      for (const key of forgejoKeys) {
        const value = priorForgejo[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (priorModule) process.env.SINTER_DREAM_HOST_CONFIG_MODULE = priorModule;
      else delete process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
      if (priorHoldout) process.env.SINTER_DREAM_HOLDOUT_FILE = priorHoldout;
      else delete process.env.SINTER_DREAM_HOLDOUT_FILE;
      if (priorRenderer) process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST = priorRenderer;
      else delete process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST;
    }
  });

  it('fails closed for an ordinary detached checkout without origin/main', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'liminal-detached-no-base-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'));
    await writeFile(path.join(repo, '.git', 'HEAD'), `${'c'.repeat(40)}\n`);
    const prior = process.env.FORGEJO_ACTIONS;
    delete process.env.FORGEJO_ACTIONS;
    try {
      expect(() => resolveProductionSourceRefs({ repoRoot: repo }))
        .toThrow('LIMINAL_PRODUCTION_SOURCE_REFS_UNRESOLVED');
    } finally {
      if (prior === undefined) delete process.env.FORGEJO_ACTIONS;
      else process.env.FORGEJO_ACTIONS = prior;
    }
  });

  it.each([
    ['stale head SHA', { head: { sha: 'd'.repeat(40), ref: 'feature/ref-proof' },
      base: { sha: 'b'.repeat(40), ref: 'main' } }],
    ['substituted head ref', { head: { sha: 'a'.repeat(40), ref: 'other-branch' },
      base: { sha: 'b'.repeat(40), ref: 'main' } }],
    ['substituted base ref', { head: { sha: 'a'.repeat(40), ref: 'feature/ref-proof' },
      base: { sha: 'b'.repeat(40), ref: 'release' } }],
    ['missing head ref', { head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40), ref: 'main' } }],
    ['missing base ref', { head: { sha: 'a'.repeat(40), ref: 'feature/ref-proof' },
      base: { sha: 'b'.repeat(40) } }],
  ])('fails closed for a %s Forgejo PR event', async (_label, pullRequest) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'liminal-forgejo-mismatch-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'));
    const sourceSha = 'a'.repeat(40);
    await writeFile(path.join(repo, '.git', 'HEAD'), `${sourceSha}\n`);
    const eventPath = path.join(repo, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: pullRequest }));
    const forgejoKeys = ['FORGEJO_ACTIONS', 'GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME',
      'GITHUB_SHA', 'GITHUB_BASE_REF', 'GITHUB_HEAD_REF'] as const;
    const prior = Object.fromEntries(forgejoKeys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { FORGEJO_ACTIONS: 'true', GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sourceSha,
      GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'feature/ref-proof' });
    try {
      expect(() => resolveProductionSourceRefs({ repoRoot: repo }))
        .toThrow('LIMINAL_PRODUCTION_SOURCE_REFS_UNRESOLVED');
    } finally {
      for (const key of forgejoKeys) {
        const value = prior[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('loads only a validated absolute Dream host module', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-host-config-')); roots.push(root);
    const modulePath = path.join(root, 'dream-host.mjs');
    await writeFile(modulePath, 'export const dreamRuntimeOptions = {};\n');
    const prior = process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    process.env.SINTER_DREAM_HOST_CONFIG_MODULE = modulePath;
    try {
      await expect(loadProductionDreamRuntimeOptions())
        .rejects.toThrow('DREAM_PRODUCTION_HOST_ADAPTERS_INCOMPLETE');
    } finally {
      if (prior) process.env.SINTER_DREAM_HOST_CONFIG_MODULE = prior;
      else delete process.env.SINTER_DREAM_HOST_CONFIG_MODULE;
    }
  });

  it('fails production bridge construction without the product command port', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new TuiBridgeService()).toThrow('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it('shares durable proposal projections across runtime restarts without effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-runtime-'));
    roots.push(root);
    const renderer = { render: vi.fn(), close: vi.fn(async () => undefined) } as never;
    const generator = new LLMClient({ role: 'generator', provider: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1', model: 'generator-test', apiKey: 'unused' });
    const evaluator = new LLMClient({ role: 'evaluator', provider: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1', model: 'evaluator-test', apiKey: 'unused' });
    const options = { root, renderer, generator, evaluator,
      sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
      harnessIdentity: 'fake/harness', studioIdentity: 'fake/studio',
      receiptAuthority: createTestReceiptAuthority('runtime-test-secret'),
      ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('runtime-owner-secret'),
      knowledgeSigningKey: 'runtime-knowledge-secret',
      dream: { budget: { maxCandidates: 1, maxProviderAttempts: 3 },
        leaseAuthority: { assertActive: vi.fn() }, executor: () => ({}) as never,
        leaseAuthorityIdentityDigest: digest('b'), executorIdentityDigest: digest('c'),
        template: { campaignId: 'wave-8', requiredModalities: ['visual'] as const,
          lease: { token: 'lease', fencingSequence: 1 }, context: {
            knowledgeProfileDigest: digest('1'), operatorDigest: digest('2'),
            policyDigest: digest('3'), rendererEnvironmentDigest: digest('4'),
            evaluatorManifestDigests: [digest('5'), digest('6')],
            transferCommitmentDigest: digest('7') } } } };
    const first = await createProductionLiminalRuntime(options);
    const proposal = { schema: 'sinter.liminal-proposal' as const, schemaVersion: 1 as const,
      idempotencyKey: 'restart-proposal', requestedKind: 'generate-candidate' as const,
      briefDigest: digest('a'), authorityDigest: digest('b') };
    const saved = await first.port.propose('cortex', proposal);
    await first.close();
    const restarted = await createProductionLiminalRuntime(options);
    expect(await restarted.port.projection(proposal.idempotencyKey)).toEqual(saved);
    expect(restarted.dream).toEqual(expect.objectContaining(
      { run: expect.any(Function), projection: expect.any(Function) }));
    expect(renderer.render).not.toHaveBeenCalled();
    await restarted.close();
  });

  it('constructs frozen governed commands from exact refs, identities, and settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-command-builder-'));
    roots.push(root);
    const generator = new LLMClient({ role: 'generator', provider: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1', model: 'generator-test', apiKey: 'unused' });
    const evaluator = new LLMClient({ role: 'evaluator', provider: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1', model: 'evaluator-test', apiKey: 'unused' });
    const runtime = await createProductionLiminalRuntime({ root, generator, evaluator,
      renderer: { render: vi.fn(), close: vi.fn(async () => undefined) } as never,
      rendererIdentity: 'fake/renderer', harnessIdentity: 'fake/harness',
      studioIdentity: 'fake/studio',
      sourceRefs: { sourceHeadSha: 'a'.repeat(40), canonicalMainSha: 'b'.repeat(40) },
      receiptAuthority: createTestReceiptAuthority('command-builder-secret'),
      knowledgeSigningKey: 'builder-knowledge-secret',
      ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('builder-owner-secret') });

    const command = runtime.createCommand({ prompt: 'A precise volumetric study',
      domain: 'three', layers: ['volume', 'light'], maxTransportAttempts: 3 });
    expect(command).toMatchObject({ sourceHeadSha: 'a'.repeat(40),
      canonicalMainSha: 'b'.repeat(40), safeMode: 'governed-production',
      rendererIdentity: 'fake/renderer', maxTransportAttempts: 3,
      sourceBinding: { sourceKind: 'explicit', sourceHeadSource: 'caller',
        canonicalMainSource: 'caller' },
      roles: { generator: 'openai/generator-test', evaluator: 'openai/evaluator-test',
        harness: 'fake/harness', studio: 'fake/studio' } });
    expect(command.authorityPackageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(command)).toBe(true);
    const base = { prompt: 'A precise volumetric study', domain: 'three' as const,
      layers: ['volume', 'light'], maxTransportAttempts: 3 };
    // #1323: same prompt replays one operation; a retry nonce starts a fresh one.
    expect(runtime.createCommand(base).idempotencyKey).toBe(command.idempotencyKey);
    const retryA = runtime.createCommand({ ...base, retryUnknownOutcome: 'nonce-a' });
    const retryB = runtime.createCommand({ ...base, retryUnknownOutcome: 'nonce-b' });
    expect(new Set([command.idempotencyKey, retryA.idempotencyKey, retryB.idempotencyKey]).size)
      .toBe(3);
    expect(retryA.prompt).toBe(command.prompt);
    await expect(Promise.resolve().then(() => runtime.createCommand({
      prompt: 'text', domain: 'nbe' })))
      .rejects.toThrow('LIMINAL_PRODUCTION_DOMAIN_UNSUPPORTED:nbe');
    await runtime.close();
  });

  it('uses explicit authorities and knowledge key without ambient HOME files', async () => {
    const cleanHome = await mkdtemp(path.join(os.tmpdir(), 'liminal-clean-home-'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-explicit-authority-'));
    roots.push(cleanHome, root);
    const priorHome = process.env.HOME;
    process.env.HOME = cleanHome;
    const client = (role: 'generator' | 'evaluator') => ({
      getConfig: () => ({ provider: 'fake-transport', model: role }),
    }) as never;
    try {
      const runtime = await createProductionLiminalRuntime({ root,
        generator: client('generator'), evaluator: client('evaluator'),
        renderer: { render: vi.fn(), close: vi.fn(async () => undefined) } as never,
        sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
        receiptAuthority: createTestReceiptAuthority('receipt-secret'),
        ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('owner-secret'),
        knowledgeSigningKey: 'knowledge-secret' });
      await runtime.close();
      await expect(stat(path.join(cleanHome, '.sinter', 'authority'))).rejects.toMatchObject({
        code: 'ENOENT' });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});
