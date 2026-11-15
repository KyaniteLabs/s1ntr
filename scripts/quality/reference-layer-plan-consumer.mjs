import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[a-z][a-z0-9-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const DOMAINS = new Set([
  'p5', 'glsl', 'three', 'hydra', 'strudel', 'tone', 'revideo',
  'hyperframes', 'ascii', 'textgen', 'instrument',
]);
const ROLES = new Set(['background', 'foreground', 'audio']);

function inside(bundleDir, artifactPath) {
  if (!artifactPath || isAbsolute(artifactPath) || /^[a-z][a-z0-9+.-]*:/i.test(artifactPath)) {
    throw new Error(`non-portable artifact path: ${artifactPath}`);
  }
  const path = resolve(bundleDir, artifactPath);
  const fromBundle = relative(resolve(bundleDir), path);
  if (fromBundle.startsWith('..') || isAbsolute(fromBundle)) {
    throw new Error(`artifact path escapes bundle: ${artifactPath}`);
  }
  return path;
}

export async function consumeLayerPlan(planPath) {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.schema !== 'sinter.layer-plan' || plan.schemaVersion !== '1.0') {
    throw new Error('unsupported layer-plan major version');
  }
  if (!ID.test(plan.id) || !plan.title || !plan.canvas?.backgroundColor || !plan.provenance?.sinterVersion) {
    throw new Error('invalid layer-plan root fields');
  }
  if (!Array.isArray(plan.layers) || plan.layers.length === 0) throw new Error('empty layer plan');
  const ids = new Set();
  const resolved = [];
  for (const layer of plan.layers) {
    if (!ID.test(layer.id) || ids.has(layer.id)) throw new Error(`invalid layer id: ${layer.id}`);
    ids.add(layer.id);
    if (
      !DOMAINS.has(layer.domain)
      || !ROLES.has(layer.role)
      || !Number.isInteger(layer.sourceIndex)
      || !Number.isInteger(layer.zIndex)
      || layer.opacity < 0
      || layer.opacity > 1
      || !layer.generation?.prompt
      || !layer.generation?.generator
      || !layer.generation?.generatedAt
      || !HASH.test(layer.artifact?.sha256 ?? '')
    ) {
      throw new Error(`invalid layer contract: ${layer.id}`);
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = layer.bounds?.[key];
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid bounds: ${layer.id}`);
    }
    if (layer.alpha?.mode === 'opaque' && layer.role !== 'background') throw new Error(`invalid alpha: ${layer.id}`);
    if (layer.alpha?.mode === 'matte') {
      if (!['alpha', 'luminance'].includes(layer.alpha.channel) || !HASH.test(layer.alpha.sha256 ?? '')) {
        throw new Error(`invalid matte: ${layer.id}`);
      }
      const matte = await readFile(inside(dirname(planPath), layer.alpha.path));
      if (createHash('sha256').update(matte).digest('hex') !== layer.alpha.sha256) {
        throw new Error(`matte hash mismatch: ${layer.id}`);
      }
    } else if (!['embedded', 'opaque'].includes(layer.alpha?.mode)) {
      throw new Error(`invalid alpha: ${layer.id}`);
    }
    const bytes = await readFile(inside(dirname(planPath), layer.artifact.path));
    if (createHash('sha256').update(bytes).digest('hex') !== layer.artifact.sha256) {
      throw new Error(`artifact hash mismatch: ${layer.id}`);
    }
    resolved.push({ layer, bytes });
  }
  resolved.sort((a, b) => a.layer.zIndex - b.layer.zIndex || a.layer.id.localeCompare(b.layer.id));
  const frames = resolved.map(({ layer, bytes }) => `<iframe data-layer-id="${layer.id}" src="data:${layer.artifact.mimeType};base64,${bytes.toString('base64')}"></iframe>`);
  return { plan, order: resolved.map(item => item.layer.id), html: `<main>${frames.join('')}</main>` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await consumeLayerPlan(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ id: result.plan.id, order: result.order })}\n`);
}
