/**
 * Improvement loops for layered pieces (`sinter compose --loops N`), on the same LiminalProductionLoops module as
 * `generate --loops`. Each loop is its own governed compose in its own folder (loops/rK). Loop k+1 gets loop k's layer plan,
 * every layer's code, the composite's measured stills and the judge's critique with each layer's alive/beat-response verdict,
 * and may revise one or more layers: layers with a problem (dead, errored, wired to the beat but not answering it) are
 * regenerated from an EDIT prompt, layers that work are reused byte-for-byte (no provider call). When nothing is wrong, every
 * layer is edited. A loop's score is the judge's coherence score; a failed render check leaves it unscored (never best) but
 * still carries its layers and the failure text forward.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CoordinatedCompositionResult, ComposeRevision } from '../creative-run/CreativeRunCoordinatorBase.js';
import { hybridEnabled, type ExplicitLayerRequest } from '../composition/hybrid/HybridPlan.js';
import type { HybridJudgement } from '../composition/hybrid/HybridComposition.js';
import type { LayerPlan } from '../composition/LayerPlan.js';
import type { PriorRun } from '../generators/revision/RevisionBrief.js';
import { parseRevisionPrompt, identicalLineShare } from '../generators/revision/RevisionBrief.js';
import { hashReverseProvenance, type ReverseProvenance } from '../reverse/ReverseBrief.js';
import { writeFileAtomic, writeFileAtomicSync } from '../utils/atomicWrite.js';
import { runProductionCliCompose, type ProductionComposeDelegate } from './LiminalProductionCompose.js';
import { LoopReplayIntegrityError, runGovernedLoops, type LoopGenerateOutcome, type LoopsManifest, type RunLoopsInput } from './LiminalProductionLoops.js';

interface SavedLayer { index: number; domain: string; role: string; blendMode: string; opacity: number; code: string; keep: boolean; problem: string | null; critique: string }
interface SavedPiece {
  source: string; title: string; layers: SavedLayer[]; score: number | null;
  critique: string; stills: string[]; verdict: string; sidecars?: string[];
  providerCalls?: number; draftFailure?: string; ownerRetry?: string;
}

const PIECE_FILE = 'compose-loop.json';
const PROVENANCE_FILE = 'reverse-provenance.json';
const REQUIRED_EXPORTS = ['composition.html', 'composition.layers.json', 'medium.json'];
const OPTIONAL_EXPORTS = ['composition.hybrid.json', 'composition.project.json', 'hybrid-early.png', 'hybrid-late.png', PROVENANCE_FILE];

function readBundle(dir: string, recoveredPiece?: Buffer) {
  const layerDir = path.join(dir, 'layers');
  if (!lstatSync(dir).isDirectory() || !lstatSync(layerDir).isDirectory()) {
    throw new Error('COMPOSE_LOOP_ARTIFACT_MISMATCH: expected physical directories');
  }
  const readEntry = (name: string) => {
    const file = path.join(dir, name);
    if (!lstatSync(file).isFile()) throw new Error(`COMPOSE_LOOP_ARTIFACT_MISMATCH: ${name}`);
    const bytes = readFileSync(file);
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const required = REQUIRED_EXPORTS.map(readEntry);
  const plan = JSON.parse(required[1].bytes.toString('utf8')) as LayerPlan;
  const assets = plan.layers.flatMap(layer => layer.alpha.mode === 'matte' ? [layer.artifact, layer.alpha] : [layer.artifact]);
  const layers = assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(asset => {
    if (!/^layers\/[^/\\]+$/.test(asset.path)) throw new Error('COMPOSE_LOOP_INVALID_LAYER_PATH');
    const entry = readEntry(asset.path);
    if (entry.sha256 !== asset.sha256) throw new Error(`COMPOSE_LOOP_ARTIFACT_MISMATCH: ${entry.name}`);
    return entry;
  });
  const saved = recoveredPiece ? { name: PIECE_FILE, bytes: recoveredPiece,
    sha256: createHash('sha256').update(recoveredPiece).digest('hex') } : readEntry(PIECE_FILE);
  const piece = JSON.parse(saved.bytes.toString('utf8')) as SavedPiece;
  const sidecars = OPTIONAL_EXPORTS.filter(name => piece.sidecars
    ? piece.sidecars.includes(name) : existsSync(path.join(dir, name))).map(readEntry);
  const entries = [...required, ...sidecars, ...layers, saved];
  const digest = createHash('sha256').update(JSON.stringify(entries.map(({ name, sha256 }) => [name, sha256]))).digest('hex');
  return { digest, plan, exports: entries.slice(0, -1) };
}

function attemptFolder(dir: string, kind: 'initial' | 'noop' | 'bloat' = 'initial'): string {
  return kind === 'initial' ? dir : path.join(dir, `attempt-${kind}`);
}

type ComposeLoopsResult = { manifest: LoopsManifest; bestLoop: number | null; bestFolder: string | null };

export async function publishComposeLoop(run: ComposeLoopsResult, outputRoot: string, options: {
  exportLayer?: number;
  galleryDir?: string;
} = {}): Promise<{ layerPng?: string; provenance?: string; gallery?: { slug: string; version: number } }> {
  if (!run.bestFolder) throw new Error('COMPOSE_LOOP_NO_WINNER');
  const record = run.manifest.records.find(row => row.loop === run.bestLoop);
  const bundle = readBundle(run.bestFolder);
  if (!record?.winningAttempt?.artifactSha256 || record.winningAttempt.artifactSha256 !== bundle.digest) {
    throw new Error('COMPOSE_LOOP_ARTIFACT_MISMATCH: winner differs from the reviewed files');
  }
  const [html, ...otherExports] = bundle.exports;
  const source = html.bytes.toString('utf8');
  const { exportLayer, galleryDir } = options;
  const png = exportLayer === undefined ? undefined
    : await (await import('../composition/LayerPngExporter.js')).renderLayerPng(source, exportLayer);
  mkdirSync(path.join(outputRoot, 'layers'), { recursive: true });
  if (!lstatSync(path.join(outputRoot, 'layers')).isDirectory()) throw new Error('COMPOSE_LOOP_INVALID_EXPORT_FOLDER');
  for (const { name, bytes } of otherExports) {
    await writeFileAtomic(path.join(outputRoot, name), bytes);
  }
  const layerPng = png && path.join(outputRoot, `layer-${exportLayer}.png`);
  if (layerPng && png) await writeFileAtomic(layerPng, png);
  const provenance = otherExports.some(file => file.name === PROVENANCE_FILE)
    ? path.join(outputRoot, PROVENANCE_FILE) : undefined;
  let gallery;
  if (galleryDir) {
    const { Gallery } = await import('../gallery/Gallery.js');
    gallery = await new Gallery(galleryDir).recordComposition(source, {
      title: bundle.plan.title,
      layers: bundle.plan.layers.map(layer => layer.domain),
    }, { reuseExisting: true });
  }
  // Publish the visible winner after the requested exports succeed.
  await writeFileAtomic(path.join(outputRoot, html.name), html.bytes);
  return { layerPng, provenance, gallery };
}

function judgeCritique(result: CoordinatedCompositionResult, judgement: HybridJudgement | undefined, judgeError: string | null): { text: string; layers: SavedLayer[]; stills: string[]; verdict: string } {
  const plan = result.hybridPlan;
  const lines: string[] = [];
  const verdict = judgement ? judgement.verdict : judgeError ? 'fail' : 'unjudged';
  lines.push(`COMPOSITE VERDICT: ${verdict.toUpperCase()}${judgement?.reason ? ` (${judgement.reason})` : judgeError ? ` (${judgeError})` : ''}`);
  if (judgement?.coherence) lines.push(`${judgement.coherence.criterion}: ${judgement.coherence.score.toFixed(2)} (palette fit ${judgement.coherence.paletteFit.toFixed(2)}, analyzer agreement ${judgement.coherence.analyzerAgreement.toFixed(2)})`);
  if (judgement?.early && judgement.late) lines.push(`Measured stills: early luminance ${judgement.early.meanLuminance.toFixed(2)} spread ${judgement.early.spread.toFixed(3)}; late luminance ${judgement.late.meanLuminance.toFixed(2)} spread ${judgement.late.spread.toFixed(3)}; early/late frame change ${(judgement.frameChange ?? 0).toFixed(4)}`);
  if (result.renderGate && !judgement) lines.push(`Render gate: ${String(result.renderGate.verdict)}${result.renderGate.skipped ? ` (skipped: ${result.renderGate.skipped})` : ''}`);
  lines.push('PER-LAYER VERDICTS:');
  const layers: SavedLayer[] = result.layers.map((l, index) => {
    const role = plan?.layers[index]?.role ?? (index === 0 ? 'background' : 'overlay');
    const j = judgement?.layers.find((x) => x.index === index);
    const sig = judgement?.signals?.filter((s) => s.layer === index) ?? [];
    const problems: string[] = [];
    if (!l.generated) problems.push(`did not generate: ${l.error ?? 'no code'}`);
    if (j && !j.alive) problems.push('drew nothing');
    if (j && j.errors.length) problems.push(`runtime errors: ${j.errors.join(' | ')}`);
    const beat = sig.map((s) => {
      if (s.note) return `beat response: ${s.status === 'deaf' ? 'NOT responsive' : s.status} (${s.note})`;
      // Reconstruct the original critique when replaying a pre-sampling judgement.
      return s.busy ? `beat response: busy (own motion ${s.noise.toFixed(3)} swamps the signal; exempt)`
        : s.responsive ? `beat response: responsive (beat-held change ${s.effect.toFixed(3)} vs own motion ${s.noise.toFixed(3)})`
          : `beat response: NOT responsive (beat-held change ${s.effect.toFixed(3)} vs own motion ${s.noise.toFixed(3)}; needs 2x and 0.01)`;
    });
    for (const s of sig) if (!s.busy && !s.responsive) problems.push('wired to the beat but its frames do not change with the signal');
    lines.push(`- layer ${index} ${l.domain} ${role}: ${problems.length ? 'PROBLEM, ' + problems.join('; ') : 'ok'}${beat.length ? '; ' + beat.join('; ') : ''}; ${l.codeLength} chars`);
    return { index, domain: l.domain, role, blendMode: l.blendMode, opacity: l.opacity, code: l.code ?? '', keep: false, problem: problems.length ? problems.join('; ') : null,
      critique: problems.length ? problems.join('; ') : 'no defect measured; push it further' };
  });
  const broken = layers.filter((l) => l.problem !== null);
  // Revise one or more layers: those with a problem; with none, every layer is edited. Working layers are reused as they are.
  for (const l of layers) l.keep = broken.length > 0 && l.problem === null && l.code.trim() !== '';
  const stills = judgement?.stills ? [path.basename(judgement.stills.early), path.basename(judgement.stills.late)] : [];
  return { text: lines.join('\n'), layers, stills, verdict };
}

function layerPlanText(result: CoordinatedCompositionResult, layers: readonly SavedLayer[]): string {
  const plan = result.hybridPlan;
  const head = plan ? `LAYERED PIECE "${plan.title}" (${plan.kind}; palette ${plan.palette.background} + ${plan.palette.colors.join(', ')}; ${plan.bpm ? plan.bpm + ' bpm' : 'no tempo'}; why: ${plan.reason})`
    + (plan.signals.length ? `\nSIGNALS: ${plan.signals.map((s) => `${s.kind} ${s.from} -> layer ${s.to} ${s.param} depth ${s.depth}`).join('; ')}` : '')
    : `LAYERED PIECE "${result.title}" (${layers.length} layers)`;
  const body = layers.map((l) => `[layer ${l.index}] domain=${l.domain} role=${l.role} blend=${l.blendMode} opacity=${l.opacity}${plan?.layers[l.index]?.why ? ` why=${plan.layers[l.index].why}` : ''}\n<layer_code index="${l.index}">\n${l.code}\n</layer_code>`);
  return [head, ...body].join('\n');
}

/** A layered piece is a no-op only if EVERY layer's code is >90% unchanged; kept (working) layers are legitimately identical. Returns the most-changed layer's survival. */
function layerSurvival(base: string, next: string): number {
  const blocks = (t: string): Map<string, string> => new Map([...t.matchAll(/<layer_code index="(\d+)">\n([\s\S]*?)\n<\/layer_code>/g)].map((m) => [m[1], m[2]]));
  const a = blocks(base); const b = blocks(next);
  if (a.size === 0 || b.size === 0) return identicalLineShare(base, next);
  let min = 1;
  for (const [k, code] of a) min = Math.min(min, b.has(k) ? identicalLineShare(code, b.get(k) as string) : 0);
  return min;
}

function save(dir: string, piece: SavedPiece): void { writeFileAtomicSync(path.join(dir, PIECE_FILE), JSON.stringify(piece, null, 2)); }

function loadSaved(dir: string): SavedPiece | null {
  try { const p = path.join(dir, PIECE_FILE); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as SavedPiece : null; } catch { return null; }
}

function priorFromSaved(dir: string, saved: SavedPiece): PriorRun {
  return {
    source: saved.source, score: saved.score, critique: saved.critique, frames: saved.stills,
    rejectionReasons: saved.layers.filter(layer => layer.problem).map(layer => `layer ${layer.index} ${layer.domain}: ${layer.problem}`),
    artifactDirectory: dir, artifactDigest: readBundle(dir).digest,
  };
}

export interface RunComposeLoopsInput {
  readonly prompt: string;
  readonly outputRoot: string;
  readonly loops: number;
  readonly delegate: ProductionComposeDelegate;
  readonly retryUnknown?: RunLoopsInput['retryUnknown'];
  readonly retryArgs?: readonly string[];
  readonly hybridLayers?: ExplicitLayerRequest[];
  readonly providerCallsPerLoop: number;
  readonly attemptId?: string;
  readonly reverseProvenance?: ReverseProvenance;
  readonly log?: (line: string) => void;
}

export async function runComposeLoops(input: RunComposeLoopsInput): Promise<ComposeLoopsResult> {
  const { writeHybridArtifacts } = await import('../composition/hybrid/HybridComposition.js');
  const { writeLayerPlan } = await import('../composition/LayerPlan.js');
  const { describeMedium } = await import('../core/MediumLine.js');
  const provenanceSha256 = input.reverseProvenance ? hashReverseProvenance(input.reverseProvenance) : undefined;
  const run = await runGovernedLoops({
    request: input.prompt, domain: 'compose', loops: input.loops, outputRoot: input.outputRoot,
    providerCallsPerLoop: input.providerCallsPerLoop,
    resumeKey: JSON.stringify({ hybrid: hybridEnabled(), layers: input.hybridLayers ?? [], attemptId: input.attemptId, provenanceSha256 }),
    verifyResumedCreates: true, attemptPrefix: input.attemptId, retryUnknown: input.retryUnknown, retryArgs: input.retryArgs, lastIsBestWhenUnscored: true, log: input.log,
    loadDone: (loopDir, kind) => {
      const dir = attemptFolder(loopDir, kind);
      const saved = loadSaved(dir);
      if (!saved) throw new Error('COMPOSE_LOOP_ARTIFACT_MISMATCH: saved attempt is missing');
      return priorFromSaved(dir, saved);
    },
    survival: layerSurvival,
    generateOne: async ({ prompt: loopPrompt, outputRoot: loopDir, attemptId, baseArtifactDirectory, providerCallsMaximum, replayOnly, onRetryUnknown, expectedArtifactSha256 }): Promise<LoopGenerateOutcome> => {
      const kind = attemptId.endsWith('-noop') ? 'noop' : attemptId.endsWith('-bloat') ? 'bloat' : 'initial';
      const dir = attemptFolder(loopDir, kind);
      mkdirSync(dir, { recursive: true });
      const parsed = parseRevisionPrompt(loopPrompt);
      const idea = parsed ? parsed.request : loopPrompt;
      const revision: ComposeRevision | undefined = parsed ? {
        brief: loopPrompt.slice(idea.length).trim(),
        layers: (baseArtifactDirectory ? loadSaved(baseArtifactDirectory)?.layers ?? [] : []).map((l) => ({ index: l.index, domain: l.domain, code: l.code, keep: l.keep, critique: l.critique })) } : undefined;
      const governed = await runProductionCliCompose({ prompt: idea, outputRoot: dir, loopDirectory: loopDir, replayOnly, onRetryUnknown, attemptId, maxProviderCalls: providerCallsMaximum, referenceProvenanceSha256: provenanceSha256,
        ...(input.hybridLayers ? { hybridLayers: input.hybridLayers } : {}),
        ...(revision ? { revision } : {}) }, input.delegate);
      const result = governed.result;
      const providerCalls = governed.providerCallsUsed;
      if (result.successCount === 0) throw new Error('COMPOSE_LOOP_NO_GENERATED_LAYERS');
      if (governed.replayedLoop && lstatSync(path.join(dir, PIECE_FILE), { throwIfNoEntry: false })) {
        const saved = loadSaved(dir);
        if (!saved || saved.providerCalls === undefined) {
          throw new LoopReplayIntegrityError('COMPOSE_LOOP_JUDGEMENT_UNPROVEN');
        }
        if (saved.ownerRetry === governed.ownerRetry) {
          if (providerCalls === undefined || saved.providerCalls !== providerCalls) {
            throw new LoopReplayIntegrityError('COMPOSE_LOOP_PROVIDER_ACCOUNTING_MISMATCH');
          }
          return { score: saved.score, critique: saved.critique, providerCalls,
            ...(saved.draftFailure ? { draftFailure: saved.draftFailure } : {}),
            model: 'compose', payload: { folder: dir, result }, prior: priorFromSaved(dir, saved) };
        }
        if (expectedArtifactSha256 || !governed.ownerRetry) throw new LoopReplayIntegrityError('COMPOSE_LOOP_ATTEMPT_MISMATCH');
      }
      let judgement: HybridJudgement | undefined;
      const hybridManifest = path.join(dir, 'composition.hybrid.json');
      const html = path.join(dir, 'composition.html');
      const savedJudgement = governed.replayedLoop && !governed.ownerRetry && existsSync(hybridManifest)
        && existsSync(html) && readFileSync(html, 'utf8') === result.html;
      if (result.hybridPlan && (expectedArtifactSha256 || savedJudgement)) {
        judgement = JSON.parse(readFileSync(hybridManifest, 'utf8')).judge;
        if (!judgement) throw new LoopReplayIntegrityError('COMPOSE_LOOP_JUDGEMENT_UNPROVEN');
      } else if (result.hybridPlan) {
        judgement = (await writeHybridArtifacts(dir, result, {
          plan: result.hybridPlan, html: result.html, build: result.hybridBuild!,
        }, { retainRejectedDraft: true })).judgement;
      } else if (!expectedArtifactSha256) {
        writeFileAtomicSync(path.join(dir, 'composition.html'), result.html);
        const ok = result.layers.filter((l) => l.generated);
        if (ok.length) writeFileAtomicSync(path.join(dir, 'medium.json'), JSON.stringify(describeMedium({ domain: ok[0].domain, source: '', renderTarget: 'one self-contained page of stacked layers',
          decision: { source: 'planner', reason: `the decomposition planner split the idea into ${ok.length} layer(s)` },
          layers: ok.map((l, i) => ({ id: `layer-${i}`, domain: l.domain, role: i === 0 ? 'background' : 'overlay' })) }), null, 2) + '\n');
      }
      const layerPlan = path.join(dir, 'composition.layers.json');
      if (!expectedArtifactSha256) await writeLayerPlan(layerPlan, result);
      if (!expectedArtifactSha256 && input.reverseProvenance) {
        const { writeReverseProvenance } = await import('./ReverseCli.js');
        await writeReverseProvenance(dir, input.reverseProvenance);
      }
      const gate = result.renderGate;
      const verdict = gate?.remediation?.applied ? gate.remediation.verdictAfter : gate?.verdict;
      const draftFailure = judgement
        ? judgement.verdict !== 'pass' ? judgement.reason ?? 'hybrid render check failed' : undefined
        : verdict && verdict !== 'ok' ? `Composite render gate: ${verdict}` : undefined;
      const judged = judgeCritique(result, judgement, draftFailure ?? null);
      const score = judgement && judgement.verdict === 'pass' && judgement.coherence ? judgement.coherence.score : null;
      if (providerCalls === undefined) throw new Error('COMPOSE_LOOP_PROVIDER_ACCOUNTING_MISSING');
      const source = layerPlanText(result, judged.layers);
      const sidecars = result.hybridPlan ? ['composition.hybrid.json', 'composition.project.json', ...judged.stills] : [];
      if (input.reverseProvenance) sidecars.push(PROVENANCE_FILE);
      const piece: SavedPiece = { title: result.title, source, layers: judged.layers, score, critique: judged.text,
        stills: judged.stills, verdict: judged.verdict, sidecars, providerCalls, ...(governed.ownerRetry ? { ownerRetry: governed.ownerRetry } : {}),
        ...(draftFailure ? { draftFailure } : {}) };
      if (expectedArtifactSha256 && readBundle(dir, Buffer.from(JSON.stringify(piece, null, 2))).digest !== expectedArtifactSha256) {
        throw new LoopReplayIntegrityError('LOOPS_RESUME_ARTIFACT_MISMATCH');
      }
      save(dir, piece);
      return { score, critique: judged.text,
        ...(draftFailure ? { draftFailure } : {}),
        providerCalls, model: 'compose', payload: { folder: dir, result },
        prior: priorFromSaved(dir, piece) };
    },
  });
  return { manifest: run.manifest, bestLoop: run.bestLoop, bestFolder: run.manifest.records.find(record => record.best)?.artifactDirectory ?? null };
}
