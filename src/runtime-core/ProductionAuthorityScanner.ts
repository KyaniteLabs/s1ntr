import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SENSITIVE_PATTERNS = Object.freeze([
  { kind: 'provider', pattern: /(?:new\s+LLMClient|createProvider)\s*\(/ },
  { kind: 'evaluator', pattern: /evaluator:\s*new\s+LLMClient\s*\(/ },
  { kind: 'renderer', pattern: /(?:HeadlessRenderer\.getInstance|new\s+HeadlessRenderer)\s*\(/ },
  { kind: 'review-writer', pattern: /publishOwnerReviewPacket\s*\(/ },
  { kind: 'review-writer', pattern: /export\s+async\s+function\s+bootstrapProductionLiminalOwnerReviewAuthority\b/ },
  { kind: 'journal', pattern: /new\s+FileLiminalOperationJournal\s*\(/ },
  { kind: 'journal', pattern: /export\s+class\s+FileLiminalOperationJournal\b/ },
  { kind: 'archive', pattern: /new\s+QualityArchive\s*\(/ },
  { kind: 'archive', pattern: /export\s+class\s+QualityArchive\b/ },
  { kind: 'memory', pattern: /new\s+HarnessMemory\s*\(/ },
  { kind: 'memory', pattern: /export\s+class\s+FileOperationalMemoryBoundary\b/ },
  { kind: 'compost', pattern: /new\s+CompostMill\s*\(/ },
  { kind: 'compost', pattern: /export\s+class\s+CompostMill\b/ },
  { kind: 'compost', pattern: /export\s+function\s+deriveCompostProvenance\b/ },
  { kind: 'evolution', pattern: /new\s+(?:MapElites|EvolutionEngine)\s*\(/ },
  { kind: 'evolution', pattern: /export\s+class\s+MapElites\b/ },
  { kind: 'evolution', pattern: /export\s+function\s+createExplorationDecisionAdmission\b/ },
  { kind: 'routing', pattern: /new\s+GeneratorBanditRouter\s*\(/ },
  { kind: 'activation', pattern: /new\s+EvidenceConsolidationCoordinator\s*\(/ },
  { kind: 'activation', pattern: /export\s+class\s+EvidenceConsolidationCoordinator\b/ },
  { kind: 'activation', pattern: /export\s+class\s+CreativeKnowledgeConsolidator\b/ },
  { kind: 'activation', pattern: /export\s+function\s+createCreativeLabelAdmission\b/ },
  { kind: 'source-change', pattern: /new\s+AutoresearchExperimentRunner\s*\(/ },
  { kind: 'source-change', pattern: /export\s+class\s+AutoresearchExperimentRunner\b/ },
  { kind: 'assimilation', pattern: /new\s+(?:ModelAssimilationGauntlet|RoleModelAssimilator)\s*\(/ },
  { kind: 'assimilation', pattern: /export\s+class\s+ModelAssimilationGauntlet\b/ },
  { kind: 'assimilation', pattern: /export\s+(?:async\s+)?function\s+run(?:Live)?ModelAssimilation/ },
  { kind: 'plugin', pattern: /new\s+PluginLoader\s*\(/ },
  { kind: 'scheduler', pattern: /new\s+(?:AutonomousGardener|GardenScheduler)\s*\(/ },
  { kind: 'research-control', pattern: /export\s+class\s+DreamResearchController\b/ },
  { kind: 'doctrine', pattern: /export\s+class\s+AuthoredCreativeDoctrineStore\b/ },
  { kind: 'classification', pattern: /export\s+const\s+classifyDoctrineInput\b/ },
  { kind: 'product-surface', pattern: /export\s+\{[^}]*\b(?:LLMClient|HeadlessRenderer|QualityArchive|HarnessMemory|CompostMill|MapElites|PluginLoader)\b/s },
  { kind: 'product-surface', pattern: /export\s+class\s+LiminalProductCommandPort\b/ },
  { kind: 'product-surface', pattern: /export\s+class\s+CompoundCreateProofPort\b/ },
  { kind: 'product-surface', pattern: /export\s+class\s+TuiBridgeService\b/ },
] as const);

async function filesBelow(root: string, relative = ''): Promise<string[]> {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return filesBelow(root, child);
    return entry.isFile() ? [child] : [];
  }));
  return nested.flat();
}

function executableSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const IMPORT = /(?:from\s*|import\s*\(?|require\s*\()\s*['"]([^'"]+)['"]/g;

function runtimeImports(source: string): string {
  return source
    .replace(/^\s*import\s+type\b[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+type\b[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
}

function isGovernedSafeExport(source: string, specifier: string, resolved: string): boolean {
  if (resolved !== 'src/core/ScoringEngine.ts') return false;
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escaped}['"]`, 'm'));
  if (!match) return false;
  const names = match[1]!.split(',').map(name => name.trim().split(/\s+as\s+/)[0]);
  return names.length === 1 && names[0] === 'scoreRenderedEvidence';
}

async function resolveImport(
  from: string, specifier: string, readSource: (file: string) => Promise<string>,
): Promise<string | null> {
  if (!specifier.startsWith('.')) return null;
  let candidate = path.normalize(path.join(path.dirname(from), specifier));
  if (candidate.startsWith('dist/')) candidate = `src/${candidate.slice(5)}`;
  const candidates = [candidate, candidate.replace(/\.js$/, '.ts'),
    path.join(candidate, 'index.ts')];
  for (const relative of candidates) {
    if (relative.startsWith('..')) continue;
    try {
      await readSource(relative);
      return relative;
    } catch {
      // Try the next source-form candidate.
    }
  }
  return null;
}

async function reachableFiles(root: string, entries: readonly string[]): Promise<{
  files: string[]; readSource: (file: string) => Promise<string>;
}> {
  const sources = new Map<string, Promise<string>>();
  const readSource = (file: string): Promise<string> => {
    let source = sources.get(file);
    if (!source) {
      source = readFile(path.join(root, file), 'utf8');
      sources.set(file, source);
    }
    return source;
  };
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = runtimeImports(await readSource(file));
    seen.add(file);
    const imports = [...source.matchAll(IMPORT)];
    const resolved = await Promise.all(imports.map(match =>
      resolveImport(file, match[1]!, readSource)));
    for (let index = 0; index < imports.length; index++) {
      const target = resolved[index];
      if (target && !seen.has(target)
        && !isGovernedSafeExport(source, imports[index]![1]!, target)) queue.push(target);
    }
  }
  return { files: [...seen], readSource };
}

async function locatorsForFiles(
  root: string, files: readonly string[],
  readSource = (file: string) => readFile(path.join(root, file), 'utf8'),
): Promise<string[]> {
  const locators: string[] = [];
  for (const file of files) {
    const source = executableSource(await readSource(file));
    for (const marker of SENSITIVE_PATTERNS) {
      if (marker.pattern.test(source)) locators.push(`${file}:${marker.kind}`);
    }
  }
  return locators;
}

/** Discover production-reachable effect construction; unknown additions fail registry sealing. */
export async function scanProductionAuthorityLocators(root: string): Promise<readonly string[]> {
  const roots = ['src', 'bin', 'scripts'];
  const files = (await Promise.all(roots.map(async relative => {
    try { return await filesBelow(root, relative); } catch { return []; }
  }))).flat().filter(file => /\.(?:ts|js|mjs)$/.test(file) || file === 'bin/sinter');
  const locators = await locatorsForFiles(root, files);
  try {
    await readdir(path.join(root, '.quality'));
    locators.push('.quality/:projection');
  } catch {
    // An absent projection root is absent authority, not an invented locator.
  }
  return Object.freeze(locators.sort());
}

/** Trace actual source imports from governed entrypoints, excluding unrelated scripts. */
export async function scanProductionEntrypointAuthorityLocators(
  root: string, entries: readonly string[],
): Promise<readonly string[]> {
  const { files, readSource } = await reachableFiles(root, entries);
  return Object.freeze((await locatorsForFiles(root, files, readSource)).sort());
}

/** Direct shipped-surface guard for regressions hidden inside monolithic entrypoints. */
export async function scanShippedEntrypointViolations(root: string): Promise<readonly string[]> {
  const checks = [
    ['bin/sinter', /CreativeJudgmentCalibration|persistCreativeJudgmentProfile/, null],
    ['gui/start.js', /primeProductionRuntime|bootstrapProductionLiminalRuntime/, null],
    ['gui/server.js', /createProductionLiminalRuntime\s*\(|\bRalphLoop\b/,
      /bootstrapProductionLiminalRuntime\s*\(\)/],
    ['src/tui-bridge/TuiBridgeService.ts',
      /GenerationOrchestrator|quickScore|\bRalphLoop\b|streamRalphGeneration|runRetiredLegacyProve/,
      /LEGACY_TUI_DRAFT_RETIRED_USE_GOVERNED_CREATE/],
    ['src/tui-bridge/CommandDispatcher.ts',
      /\bRalphLoop\b|streamRalphGeneration|runRetiredLegacyProve/,
      /streamGovernedProductCreate/],
  ] as const;
  const violations: string[] = [];
  for (const [file, forbidden, required] of checks) {
    const source = executableSource(await readFile(path.join(root, file), 'utf8'));
    if (forbidden?.test(source) || (required && !required.test(source))) {
      violations.push(file);
    }
  }
  return Object.freeze(violations);
}
