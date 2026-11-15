import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  ProductionAuthorityRegistry,
  bootstrapProductionAuthorityRegistry,
  enforceProductionAuthorityEntrypoints,
  productionAuthorityInventory,
} from '../../src/runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionAuthorityLocators, scanProductionEntrypointAuthorityLocators,
  scanShippedEntrypointViolations }
  from '../../src/runtime-core/ProductionAuthorityScanner.js';

describe('production authority registry', () => {
  it('seals the complete declared inventory with one owner per locator', () => {
    const registry = new ProductionAuthorityRegistry(productionAuthorityInventory);
    const receipt = registry.seal(productionAuthorityInventory.map(row => row.locator));

    expect(receipt.status).toBe('sealed');
    expect(receipt.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.locatorCount).toBe(productionAuthorityInventory.length);
    expect(new Set(productionAuthorityInventory.map(row => row.kind))).toEqual(new Set([
      'provider', 'renderer', 'evaluator', 'review-writer', 'journal', 'archive',
      'memory', 'compost', 'evolution', 'routing', 'activation', 'source-change',
      'assimilation', 'plugin', 'scheduler', 'product-surface', 'projection',
      'research-control',
      'doctrine',
      'classification',
    ]));
  });

  it('fails closed for unknown and multiply owned production paths', () => {
    const registry = new ProductionAuthorityRegistry(productionAuthorityInventory);
    expect(() => registry.seal(['src/unknown.ts:provider']))
      .toThrow('UNREGISTERED_PRODUCTION_AUTHORITY_PATH');
    expect(() => new ProductionAuthorityRegistry([
      productionAuthorityInventory[0]!,
      { ...productionAuthorityInventory[0]!, owner: 'forged-owner' },
    ])).toThrow('MULTIPLY_OWNED_PRODUCTION_AUTHORITY_PATH');
    expect(() => bootstrapProductionAuthorityRegistry(['runtime:unknown-writer']))
      .toThrow('UNREGISTERED_PRODUCTION_AUTHORITY_PATH');
  });

  it('requires every migration path to name its ordered migration owner', () => {
    expect(() => new ProductionAuthorityRegistry([{
      ...productionAuthorityInventory[0]!, disposition: 'migration-pending',
      migrationOwner: undefined,
    }])).toThrow('MIGRATION_OWNER_REQUIRED');
  });

  it('cannot relabel legacy or exploratory executors as production authority', () => {
    const legacy = productionAuthorityInventory.find(row =>
      row.owner === 'legacy-role-bound-transport')!;
    const exploratory = productionAuthorityInventory.find(row =>
      row.owner === 'operator-exploration-boundary')!;
    expect(() => new ProductionAuthorityRegistry([
      { ...legacy, disposition: 'authoritative' },
    ])).toThrow('PRODUCTION_AUTHORITY_DISPOSITION_MISLABELED');
    expect(() => new ProductionAuthorityRegistry([
      { ...exploratory, disposition: 'authoritative' },
    ])).toThrow('PRODUCTION_AUTHORITY_DISPOSITION_MISLABELED');
  });

  it('fails production entry census closed for quarantined or exploration paths', () => {
    expect(() => enforceProductionAuthorityEntrypoints(['bin/sinter:provider']))
      .toThrow('PRODUCTION_ENTRY_AUTHORITY_FORBIDDEN:bin/sinter:provider');
    expect(() => enforceProductionAuthorityEntrypoints([
      'scripts/debug-minimax.ts:provider',
    ])).toThrow('PRODUCTION_ENTRY_AUTHORITY_FORBIDDEN:scripts/debug-minimax.ts:provider');
  });

  it('seals all seven organism migrations without dual-write authority', () => {
    const { migration } = bootstrapProductionAuthorityRegistry();
    expect(migration.status).toBe('cutover-complete');
    expect(migration.migratedTickets).toEqual([
      '#798', '#799', '#800', '#801', '#802', '#803', '#804',
    ]);
    expect(productionAuthorityInventory.filter(row => row.disposition === 'migration-pending'))
      .toEqual([]);
    expect(productionAuthorityInventory.filter(row =>
      row.owner.includes('projection') && row.disposition === 'authoritative'))
      .toEqual([]);
  });

  it('fails cutover closed while a bounded migration is unfinished', () => {
    const row = productionAuthorityInventory[0]!;
    const registry = new ProductionAuthorityRegistry([{ ...row,
      disposition: 'migration-pending', migrationOwner: '#804' }]);
    expect(() => registry.sealOrganismMigration())
      .toThrow('ORGANISM_MIGRATION_INCOMPLETE');
  });

  it('fails cutover closed for migrations outside the bounded circulation list', () => {
    const row = productionAuthorityInventory[0]!;
    const registry = new ProductionAuthorityRegistry([{ ...row,
      disposition: 'migration-pending', migrationOwner: '#782' }]);
    expect(() => registry.sealOrganismMigration())
      .toThrow('ORGANISM_MIGRATION_INCOMPLETE');
  });

  it('rejects unregistered provider and renderer construction across production and scripts', async () => {
    const registry = new ProductionAuthorityRegistry(productionAuthorityInventory);
    const root = path.resolve(import.meta.dirname, '../..');
    const discovered = await scanProductionAuthorityLocators(root);
    expect(discovered.length).toBeGreaterThan(20);
    expect(discovered).toEqual(productionAuthorityInventory.map(row => row.locator).sort());
    for (const locator of discovered) expect(() => registry.resolve(locator)).not.toThrow();
    expect(discovered.filter(locator => locator.endsWith(':research-control')))
      .toEqual(['src/dreaming/research/DreamResearchController.ts:research-control']);
    expect(discovered.filter(locator => locator.includes('DreamKnowledgeActivation')))
      .toEqual(['src/dreaming/research/DreamKnowledgeActivation.ts:activation']);
  });

  it('traces the ordinary governed CLI without importing quarantined executors', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const discovered = await scanProductionEntrypointAuthorityLocators(root,
      ['src/cli/LiminalProductionGenerate.ts']);
    expect(discovered).toContain('src/runtime-core/ProductionLiminalRuntime.ts:provider');
    expect(discovered).toContain('src/runtime-core/ProductionLiminalRuntime.ts:renderer');
    expect(discovered).toContain('src/runtime-core/ProductionLiminalRuntime.ts:journal');
    expect(() => enforceProductionAuthorityEntrypoints(discovered)).not.toThrow();
    const registry = new ProductionAuthorityRegistry(productionAuthorityInventory);
    expect(discovered.filter(locator => {
      const disposition = registry.resolve(locator).disposition;
      return disposition === 'quarantined-history' || disposition === 'exploration-only';
    })).toEqual([]);
  });

  it('reads each entrypoint census afresh after source changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-authority-fresh-'));
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'src/entry.ts'),
        "import { provider } from './provider.js';");
      await writeFile(path.join(root, 'src/provider.ts'), 'new LLMClient();');
      expect(await scanProductionEntrypointAuthorityLocators(root, ['src/entry.ts']))
        .toEqual(['src/provider.ts:provider']);
      await writeFile(path.join(root, 'src/provider.ts'), 'const provider = null;');
      expect(await scanProductionEntrypointAuthorityLocators(root, ['src/entry.ts']))
        .toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('traces a side-effect import to its provider authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-authority-side-effect-'));
    try {
      await mkdir(path.join(root, 'src'));
      await writeFile(path.join(root, 'src/entry.ts'), "import './provider.js';");
      await writeFile(path.join(root, 'src/provider.ts'), 'new LLMClient();');
      expect(await scanProductionEntrypointAuthorityLocators(root, ['src/entry.ts']))
        .toEqual(['src/provider.ts:provider']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('visits a shared authority once across cyclic import branches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-authority-branches-'));
    try {
      await mkdir(path.join(root, 'src'));
      await Promise.all([
        writeFile(path.join(root, 'src/entry.ts'),
          "import { left } from './left.js'; import { right } from './right.js';"),
        writeFile(path.join(root, 'src/left.ts'),
          "import { shared } from './shared.js';"),
        writeFile(path.join(root, 'src/right.ts'),
          "import { shared } from './shared.js';"),
        writeFile(path.join(root, 'src/shared.ts'),
          "import { left } from './left.js'; new LLMClient();"),
      ]);
      expect(await scanProductionEntrypointAuthorityLocators(root, ['src/entry.ts']))
        .toEqual(['src/shared.ts:provider']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('guards the actual shipped bin, GUI, and TUI entrypoints', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    expect(await scanShippedEntrypointViolations(root)).toEqual([]);
  });

  it('detects direct and dispatcher-indirect RalphLoop regressions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-entrypoint-scan-'));
    try {
      await Promise.all(['bin', 'gui', 'src/tui-bridge'].map(dir =>
        mkdir(path.join(root, dir), { recursive: true })));
      await Promise.all([
        writeFile(path.join(root, 'bin/sinter'), ''),
        writeFile(path.join(root, 'gui/start.js'), ''),
        writeFile(path.join(root, 'gui/server.js'),
          'bootstrapProductionLiminalRuntime(); RalphLoop.run();'),
        writeFile(path.join(root, 'src/tui-bridge/TuiBridgeService.ts'),
          'const draft = "LEGACY_TUI_DRAFT_RETIRED_USE_GOVERNED_CREATE";'),
        writeFile(path.join(root, 'src/tui-bridge/CommandDispatcher.ts'),
          'streamRalphGeneration();'),
      ]);
      expect(await scanShippedEntrypointViolations(root)).toEqual([
        'gui/server.js', 'src/tui-bridge/CommandDispatcher.ts',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
