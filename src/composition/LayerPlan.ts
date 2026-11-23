import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { DEFAULT_GLOBAL_SETTINGS, type BlendMode, type DomainType } from './types.js';
import type { ComposedLayer, CompositionResult } from './CompositionOrchestrator.js';
import { creativeThesisIdentity, validateCreativeThesis, type CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';

export const LAYER_PLAN_SCHEMA = 'sinter.layer-plan' as const;
export const LAYER_PLAN_VERSION = '1.0' as const;

const SINTER_VERSION = (JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { version: string }).version;

export type SharedLayerDomain =
  | 'p5' | 'glsl' | 'three' | 'hydra' | 'strudel' | 'tone'
  | 'revideo' | 'hyperframes' | 'ascii' | 'textgen' | 'instrument'
  | 'svg' | 'kinetic' | 'nbe' | 'custom';

export interface LayerPlanEntry {
  id: string;
  name: string;
  sourceIndex: number;
  domain: SharedLayerDomain;
  role: 'background' | 'foreground' | 'audio';
  blendMode: BlendMode;
  opacity: number;
  zIndex: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  alpha:
    | { mode: 'embedded' | 'opaque' }
    | {
      mode: 'matte';
      path: string;
      channel: 'alpha' | 'luminance';
      invert?: boolean;
      sha256: string;
    };
  artifact: {
    path: string;
    mimeType: string;
    sha256: string;
  };
  generation: {
    prompt: string;
    generator: DomainType;
    modelProvider?: string;
    modelName?: string;
    generatedAt: string;
  };
}

export interface LayerPlan {
  schema: typeof LAYER_PLAN_SCHEMA;
  schemaVersion: typeof LAYER_PLAN_VERSION;
  id: string;
  title: string;
  canvas: { width: number; height: number; backgroundColor: string };
  provenance: {
    generatedAt: string;
    sinterVersion: string;
    sourceCommit?: string;
    sourceFingerprint?: string;
    creativeIntelligence?: {
      thesisId: string;
      principleId: string;
      contractVersion: number;
      projectionDigest: string;
    };
    /** Complete canonical thesis required for deterministic regeneration. */
    creativeThesis?: CreativeThesis;
  };
  layers: LayerPlanEntry[];
}

const AUDIO_DOMAINS = new Set<DomainType>(['tone', 'music', 'strudel']);
const SHARED_DOMAIN: Record<DomainType, SharedLayerDomain> = {
  p5: 'p5',
  three: 'three',
  shader: 'glsl',
  tone: 'tone',
  music: 'tone',
  strudel: 'strudel',
  hydra: 'hydra',
  ascii: 'ascii',
  video: 'revideo',
  html: 'hyperframes',
  textgen: 'textgen',
  group: 'instrument',
  glsl: 'glsl',
  svg: 'svg',
  kinetic: 'kinetic',
  nbe: 'nbe',
  custom: 'custom',
};

function slug(value: string): string {
  const result = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!result) return 'composition';
  return /^[a-z]/.test(result) ? result : `composition-${result}`;
}

function entryFor(
  layer: ComposedLayer,
  sourceIndex: number,
  zIndex: number,
  generatedAt: string,
): LayerPlanEntry {
  if (!layer.artifactHtml) {
    throw new Error(`Missing runtime artifact for layer ${sourceIndex}`);
  }
  const audio = AUDIO_DOMAINS.has(layer.domain);
  const opacity = Number.isFinite(layer.opacity)
    ? Math.min(1, Math.max(0, layer.opacity))
    : 1;
  const opaque = !audio && (sourceIndex === 0 || layer.opaqueBackground === true);
  return {
    id: `layer-${sourceIndex}-${layer.domain}`,
    name: layer.prompt.trim().slice(0, 80) || `${layer.domain} layer ${sourceIndex}`,
    sourceIndex,
    domain: SHARED_DOMAIN[layer.domain],
    role: audio ? 'audio' : opaque ? 'background' : 'foreground',
    blendMode: layer.blendMode,
    opacity: audio ? 0 : opacity,
    zIndex,
    bounds: {
      x: 0,
      y: 0,
      width: audio ? 0 : 1,
      height: audio ? 0 : 1,
    },
    alpha: {
      mode: opaque ? 'opaque' : 'embedded',
    },
    artifact: {
      path: `layers/layer-${sourceIndex}-${layer.domain}.html`,
      mimeType: 'text/html',
      sha256: createHash('sha256').update(layer.artifactHtml).digest('hex'),
    },
    generation: { prompt: layer.prompt, generator: layer.domain, generatedAt },
  };
}

export function buildLayerPlan(result: CompositionResult): LayerPlan {
  const generatedAt = new Date().toISOString();
  const sourceCommit = process.env.SINTER_SOURCE_COMMIT
    ?? process.env.GITHUB_SHA
    ?? process.env.CI_COMMIT_SHA;
  const thesis = result.creativeThesis;
  const principle = thesis?.principles[0]?.contractIdentity;
  let zIndex = -1;
  const layers = result.layers.flatMap((layer, sourceIndex) => {
    if (!layer.generated) return [];
    zIndex += 1;
    return [entryFor(layer, sourceIndex, zIndex, generatedAt)];
  });
  if (layers.length === 0) {
    throw new Error('Cannot write a layer plan without a generated layer');
  }
  if (!result.creativeThesis) throw new Error('Layer plan requires a validated Creative Thesis');
  const validatedThesis = validateCreativeThesis(result.creativeThesis);
  const identity = creativeThesisIdentity(validatedThesis);

  return {
    schema: LAYER_PLAN_SCHEMA,
    schemaVersion: LAYER_PLAN_VERSION,
    id: slug(result.title),
    title: result.title,
    canvas: {
      width: DEFAULT_GLOBAL_SETTINGS.width,
      height: DEFAULT_GLOBAL_SETTINGS.height,
      backgroundColor: result.background,
    },
    provenance: {
      generatedAt,
      sinterVersion: SINTER_VERSION,
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(process.env.SINTER_SOURCE_FINGERPRINT
        ? { sourceFingerprint: process.env.SINTER_SOURCE_FINGERPRINT }
        : {}),
      creativeThesis: validatedThesis,
      ...(thesis && principle ? {
        creativeIntelligence: {
          thesisId: identity.thesisId,
          principleId: identity.principleId,
          contractVersion: identity.contractVersion,
          projectionDigest: identity.projectionDigest,
        },
      } : {}),
    },
    layers,
  };
}

/** The compose command's closing lines: no green tick for a page that has no layers. */
export function compositionOutcomeLines(successCount: number, layerCount: number, htmlPath: string): string[] {
  const tally = `${successCount}/${layerCount} layers composed`;
  if (successCount === 0) return [`❌ ${tally}`, `⚠️  Saved an empty page for inspection: ${htmlPath}`];
  return [`${successCount < layerCount ? '⚠️ ' : '✅'} ${tally}`, `✅ Saved: ${htmlPath}`];
}

export async function writeLayerPlan(path: string, result: CompositionResult): Promise<LayerPlan> {
  const plan = buildLayerPlan(result);
  const assetsDir = join(dirname(path), 'layers');
  await mkdir(assetsDir, { recursive: true });
  for (const entry of plan.layers) {
    const layer = result.layers[entry.sourceIndex];
    if (!layer?.artifactHtml) {
      throw new Error(`Missing runtime artifact for layer ${entry.id}`);
    }
    await writeFileAtomic(join(dirname(path), entry.artifact.path), layer.artifactHtml);
  }
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}
