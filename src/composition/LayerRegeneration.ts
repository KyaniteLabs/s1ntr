import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import {
  CompositionOrchestrator,
  type ComposedLayer,
  type CompositionLayerSpec,
} from './CompositionOrchestrator.js';
import {
  LAYER_PLAN_SCHEMA,
  LAYER_PLAN_VERSION,
  type LayerPlan,
  type LayerPlanEntry,
} from './LayerPlan.js';
import { creativeThesisIdentity, validateCreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';

export interface LayerRegenerationResult {
  plan: LayerPlan;
  target: LayerPlanEntry;
  previousSha256: string;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assetPath(bundleDir: string, path: string): string {
  if (!path || isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(`Layer artifact path must be bundle-relative: ${path}`);
  }
  const resolved = resolve(bundleDir, path);
  const fromBundle = relative(resolve(bundleDir), resolved);
  if (fromBundle.startsWith('..') || isAbsolute(fromBundle)) {
    throw new Error(`Layer artifact path escapes bundle: ${path}`);
  }
  return resolved;
}

function replaceLayer(
  compositeHtml: string,
  sourceIndex: number,
  artifactHtml: string,
  layer: ComposedLayer,
): string {
  const dataUri = `data:text/html;base64,${Buffer.from(artifactHtml, 'utf8').toString('base64')}`;
  const pattern = new RegExp(`<iframe\\b[^>]*data-layer-index="${sourceIndex}"[^>]*>`);
  const match = compositeHtml.match(pattern);
  if (!match) {
    throw new Error(`Composite is missing iframe for source index ${sourceIndex}`);
  }
  let iframe = match[0]
    .replace(/\bsrc="[^"]*"/, `src="${dataUri}"`)
    .replace(/data-opaque-background="[^"]*"/, `data-opaque-background="${layer.opaqueBackground === true}"`);
  if (!['tone', 'music', 'strudel'].includes(layer.domain)) {
    iframe = iframe
      .replace(/mix-blend-mode:[^;"]+;/, `mix-blend-mode:${layer.blendMode};`)
      .replace(/opacity:[^;"]+;/, `opacity:${layer.opacity};`);
  }
  return compositeHtml.replace(match[0], iframe);
}

async function verifyArtifacts(bundleDir: string, plan: LayerPlan): Promise<void> {
  for (const layer of plan.layers) {
    const content = await readFile(assetPath(bundleDir, layer.artifact.path));
    if (sha256(content) !== layer.artifact.sha256) {
      throw new Error(`Layer artifact hash mismatch: ${layer.id}`);
    }
    if (layer.alpha.mode === 'matte') {
      const matte = await readFile(assetPath(bundleDir, layer.alpha.path));
      if (sha256(matte) !== layer.alpha.sha256) {
        throw new Error(`Layer matte hash mismatch: ${layer.id}`);
      }
    }
  }
}

export async function regenerateLayerBundle(
  planPath: string,
  layerId: string,
  overrideSpec?: CompositionLayerSpec,
): Promise<LayerRegenerationResult> {
  const bundleDir = dirname(planPath);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as LayerPlan;
  if (
    plan.schema !== LAYER_PLAN_SCHEMA
    || plan.schemaVersion !== LAYER_PLAN_VERSION
    || !Array.isArray(plan.layers)
  ) {
    throw new Error(
      `Unsupported layer plan: ${String(plan.schema)} ${String(plan.schemaVersion)}; re-export the bundle`,
    );
  }
  const target = plan.layers.find(layer => layer.id === layerId);
  if (!target) throw new Error(`Unknown layer ID: ${layerId}`);

  await verifyArtifacts(bundleDir, plan);
  if (!plan.provenance.creativeThesis) throw new Error('Legacy layer plan has no Creative Thesis; re-export the bundle');
  const creativeThesis = validateCreativeThesis(plan.provenance.creativeThesis);
  const identity = creativeThesisIdentity(creativeThesis);
  const recorded = plan.provenance.creativeIntelligence;
  if (!recorded || recorded.thesisId !== identity.thesisId || recorded.principleId !== identity.principleId || recorded.contractVersion !== identity.contractVersion || recorded.projectionDigest !== identity.projectionDigest) {
    throw new Error('Layer plan Creative Thesis identity mismatch; re-export the bundle');
  }
  const artifact = target.artifact;
  if (artifact.mimeType !== 'text/html') {
    throw new Error(`Layer regeneration requires a text/html source artifact: ${target.id}`);
  }
  const spec: CompositionLayerSpec = overrideSpec ?? {
    domain: target.generation.generator,
    prompt: target.generation.prompt,
    blendMode: target.blendMode,
    opacity: target.opacity,
  };
  if (spec.domain !== target.generation.generator) {
    throw new Error(
      `Layer generator cannot change during regeneration: ${target.generation.generator}`,
    );
  }

  const regenerated = await CompositionOrchestrator.regenerateLayer(
    spec,
    target.sourceIndex,
    plan.canvas.backgroundColor,
    creativeThesis,
  );
  if (!regenerated.generated || !regenerated.artifactHtml) {
    throw new Error(`Layer regeneration failed: ${regenerated.error ?? layerId}`);
  }

  const compositePath = join(bundleDir, 'composition.html');
  const composite = await readFile(compositePath, 'utf8');
  const updatedComposite = replaceLayer(
    composite,
    target.sourceIndex,
    regenerated.artifactHtml,
    regenerated,
  );
  const previousSha256 = artifact.sha256;
  artifact.sha256 = sha256(regenerated.artifactHtml);
  target.name = regenerated.prompt.trim().slice(0, 80) || target.name;
  target.blendMode = regenerated.blendMode;
  const audio = ['tone', 'music', 'strudel'].includes(regenerated.domain);
  const opacity = Number.isFinite(regenerated.opacity)
    ? Math.min(1, Math.max(0, regenerated.opacity))
    : 1;
  const opaque = !audio && (target.sourceIndex === 0 || regenerated.opaqueBackground === true);
  target.role = audio ? 'audio' : opaque ? 'background' : 'foreground';
  target.opacity = audio ? 0 : opacity;
  target.alpha = { mode: opaque ? 'opaque' : 'embedded' };
  target.generation = {
    prompt: regenerated.prompt,
    generator: regenerated.domain,
    generatedAt: new Date().toISOString(),
  };

  await writeFileAtomic(assetPath(bundleDir, artifact.path), regenerated.artifactHtml);
  await writeFileAtomic(compositePath, updatedComposite);
  await writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, target, previousSha256 };
}
