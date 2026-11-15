/**
 * CompositionOrchestrator — the end-to-end "combine outputs" path.
 *
 * Sinter's core is not just generating single-domain pieces; it is *layering*
 * them into mixed works. The pieces existed (per-domain generators + the
 * composition engine/adapters/blendModes) but nothing connected them: there was
 * no way to take a layer spec, generate each layer, and assemble one runnable
 * layered artifact.
 *
 * This orchestrator does exactly that:
 *   1. generate each layer's code via the existing generator registry, and
 *   2. assemble the layers into a single standalone HTML where each layer is an
 *      isolated full-stage iframe stacked by z-order with a CSS blend mode and
 *      opacity (so a shader background, p5 particles, and a Tone.js audio bed
 *      can play together as one work).
 *
 * Iframes give each layer its own global scope (p5/THREE/hydra all define
 * colliding globals) and `mix-blend-mode` on the iframe element blends it with
 * the layers behind it.
 */

import { generatorRegistry } from '../generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../generators/registerGenerators.js';
import { HTMLWrapper, type Domain as WrapDomain } from '../utils/htmlWrapper.js';
import type { DomainType, BlendMode } from './types.js';
import {
  buildCompositionBrief,
  buildLayerPrompt,
  paintsOpaqueBackground,
} from './LayerContract.js';
import { capLayerBrightness, exceedsWashoutBudget } from './BlendBudget.js';
import {
  measureCompositeHtml,
  verdictFromMeasure,
  layersToDemote,
  gateEnabled,
  DEMOTED_OPACITY_FACTOR,
  type CompositeGateReport,
} from './CompositeRenderGate.js';
import { LLMClient, withProviderAttemptGuard } from '../llm/LLMClient.js';
import { Logger } from '../utils/Logger.js';
import { creativeThesisIdentity, embedCreativeThesisIdentity, MUSIC_SOUND_SUPPORTED_CONTRACT_IDS, validateCreativeThesis, type CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import type {
  CompositionGraphExecutionPlan,
  CompositionGraphControl,
  GraphExecutionReceipt,
  GraphExecutionOptions,
} from './CompositionGraph.js';
import { executeCompositionGraph } from './CompositionGraph.js';
import {
  buildInteractiveArtifact,
  type BuildInteractiveArtifactOptions,
  type InteractiveArtifactTrace,
} from '../creative-intelligence/InteractiveArtifact.js';
import { compileMusicCreativeThesis, generateMusic } from '../music/generateMusic.js';
import type { MusicSoundEvidence } from '../music/MusicSoundArtifact.js';
import {
  GenerationAttemptLedger,
  type GenerationFailureProjection,
} from '../runtime-core/generationAttemptSink.js';
import type { GenerationAttemptTelemetryContext } from '../telemetry/generationAttemptEvent.js';

export interface CompositionGenerationContext {
  runId: string;
  candidateId: string;
  ledger: GenerationAttemptLedger;
  /** #716 supplies this host-signed binding after its API lands. */
  executorReservationDigest?: string;
  campaignFundingReservationDigest?: string;
  readonly primaryAttemptIds?: Readonly<Record<string, string>>;
  readonly recoveryAttemptIds?: Readonly<Record<string, string>>;
  /** Host-owned campaign boundary for one graph-node provider attempt. */
  readonly runProviderStage?: <T>(
    input: { readonly nodeId: string; readonly attempt: number },
    operation: () => Promise<T>,
  ) => Promise<T>;
}

/** One requested layer in a composition. */
export interface CompositionLayerSpec {
  /** Creative domain for this layer. */
  domain: DomainType;
  /** Prompt describing what this layer should be. */
  prompt: string;
  /** Pre-existing code for this layer. When set, the layer is used AS-IS and not
   *  regenerated — this is how an existing work is kept as the base while new
   *  layers are generated on top of it. */
  code?: string;
  /** CSS blend mode used to composite this layer over the ones below it. */
  blendMode?: BlendMode;
  /** Layer opacity, 0..1. */
  opacity?: number;
}

/** A full composition request. */
export interface CompositionSpec {
  title?: string;
  /** CSS background for the stage behind all layers. */
  background?: string;
  /** Canonical thesis compiled by CreativeRunCoordinator. */
  creativeThesis?: CreativeThesis;
  /** Provider-attempt cap compiled from a CompositionGraph budget. */
  maxProviderCalls?: number;
  /** Planned graph semantics retained through Studio/CLI lowering. */
  executionPlan?: CompositionGraphExecutionPlan;
  /** Required deterministic runtime operations for advanced graph semantics. */
  executionContext?: GraphExecutionOptions;
  /** Deterministic no-browser lanes may explicitly suppress measured rendering. */
  renderGate?: boolean;
  signal?: AbortSignal;
  /** Coordinator-owned durable telemetry and graph-wide recovery authority. */
  generationContext?: CompositionGenerationContext;
  layers: CompositionLayerSpec[];
}

export interface ComposedLayer {
  domain: DomainType;
  prompt: string;
  blendMode: BlendMode;
  opacity: number;
  codeLength: number;
  /** True if a generator produced code; false if the layer failed to generate. */
  generated: boolean;
  error?: string;
  /** True if a FOREGROUND layer painted an opaque full-canvas background (seam risk; contract violation). */
  opaqueBackground?: boolean;
  /** True when the seam guard ACTED on an opaqueBackground foreground layer
   *  (forced its blend to a brightening mode so its opaque band no longer
   *  hard-occludes the layers beneath). */
  seamGuarded?: boolean;
  /** Standalone runtime artifact used by layer-plan export and targeted regeneration. */
  artifactHtml?: string;
  audioEvidence?: MusicSoundEvidence;
}

export interface CompositionResult {
  html: string;
  title: string;
  background: string;
  layers: ComposedLayer[];
  /** Layers that generated successfully. */
  successCount: number;
  /** Measured-frame gate report (washout/crush detection + blend remediation).
   *  Absent when the gate is disabled or no visual layer generated. */
  renderGate?: CompositeGateReport;
  creativeThesis?: CreativeThesis;
  creativeEvidence?: {
    rationale: string;
    selectedRows: readonly string[];
    /** Declared form/typography design targets drawn from the thesis plan.
     *  NOT measured at runtime — kept distinct from `gateEvidence.measured`. */
    declaredTargets: readonly { rowId: string; metric: string; target: string }[];
    /** Observed whole-frame render-gate evidence and blend-mode remediation.
     *  Distinct from `declaredTargets`: the gate measures overall luminance,
     *  not the per-row scale/spacing/contrast targets. Undefined when the
     *  gate was skipped (e.g. Puppeteer unavailable) or no visual layer ran. */
    gateEvidence?: {
      measured: { meanLuminance: number; brightnessStd: number; verdict: string };
      /** Honest blend-remediation accounting. `attempts` is 1 if a retry was
       *  tried, 0 otherwise (a measurement is NOT a revision attempt). */
      remediation: { maxAttempts: 1; attempts: number; applied: boolean };
    };
  };
  graphExecution?: GraphExecutionReceipt;
  audioEvidence?: readonly MusicSoundEvidence[];
  /** Canonical projection returned unchanged to CLI and Studio callers. */
  failureProjection?: GenerationFailureProjection;
}

type GeneratedLayerResult = {
  spec: CompositionLayerSpec;
  code: string;
  generated: boolean;
  error?: string;
  opaqueBackground?: boolean;
  seamGuarded?: boolean;
  audioEvidence?: MusicSoundEvidence;
};

/** Domains that produce audio rather than a visual — they need a start gesture. */
const AUDIO_DOMAINS = new Set<DomainType>(['tone', 'strudel', 'music']);

/** Keywords that signal the brief wants a deterministic audio layer. */
const AUDIO_BRIEF_KEYWORDS = [
  'music', 'sound', 'audio', 'tone', 'strudel', 'beat', 'rhythm', 'melody',
  'harmony', 'chord', 'synth', 'drone', 'drum', 'percussion', 'bass', 'tempo',
  'sonic', 'oscillator', 'midi', 'lo-fi', 'ambient sound',
];

function briefInvitesAudio(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return AUDIO_BRIEF_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const layerStateBridge = (sourceIndex: number): string => `<script>(function(){
window.sinterCompositionState={time:0,sequence:0,pointer:{x:.5,y:.5,down:false}};
window.sinterCausalInput=0;
addEventListener('message',function(e){var s=e.data&&e.data.state,p=s&&s.pointer;
if(e.source===parent&&e.data&&e.data.type==='sinter:causal'&&Number.isFinite(e.data.value)&&
e.data.value>=0&&e.data.value<=1){window.sinterCausalInput=e.data.value;
document.documentElement.style.setProperty('--sinter-causal-input',String(e.data.value));
document.querySelectorAll('audio').forEach(function(a){a.volume=e.data.value});
try{if(window.Tone&&window.Tone.getDestination)window.Tone.getDestination().volume.value=-18*(1-e.data.value)}catch(_){}
dispatchEvent(new CustomEvent('sinter:causal',{detail:e.data}));return}
if(e.source!==parent||!e.data||e.data.type!=='sinter:state'||!s||Object.keys(s).length!==3||
!Number.isFinite(s.time)||s.time<0||!Number.isInteger(s.sequence)||s.sequence<0||
!p||Object.keys(p).length!==3||!Number.isFinite(p.x)||p.x<0||p.x>1||
!Number.isFinite(p.y)||p.y<0||p.y>1||typeof p.down!=='boolean')return;
window.sinterCompositionState=s;dispatchEvent(new CustomEvent('sinter:state',{detail:s}));
var v=Math.max(0,Math.min(1,(p.x+p.y+window.sinterCausalInput+((s.time*0.07+${sourceIndex}*0.13)%1))/4));
parent.postMessage({type:'sinter:causal-output',layerIndex:${sourceIndex},value:v},'*')});
['pointermove','pointerdown','pointerup'].forEach(function(t){addEventListener(t,function(e){
parent.postMessage({type:'sinter:input',inputType:t,x:e.clientX/Math.max(1,innerWidth),
y:e.clientY/Math.max(1,innerHeight)},'*')},{passive:true})})})();</script>`;

/** Map a composition DomainType to its generator-registry entry name. */
const DOMAIN_TO_ENTRY: Record<string, string> = {
  p5: 'p5',
  three: 'three',
  shader: 'shader',
  tone: 'tone',
  music: 'tone',
  strudel: 'strudel',
  hydra: 'hydra',
  ascii: 'ascii',
  html: 'html',
};

/** Map a composition DomainType to the HTMLWrapper Domain. */
const DOMAIN_TO_WRAP: Record<string, WrapDomain> = {
  p5: 'p5',
  three: 'three',
  shader: 'shader',
  tone: 'tone',
  music: 'tone',
  strudel: 'strudel',
  hydra: 'hydra',
  ascii: 'ascii',
  html: 'html',
};

function createProviderCallGuard(maxProviderCalls?: number): (() => void) | undefined {
  if (maxProviderCalls === undefined) return undefined;
  let providerCalls = 0;
  return () => {
    if (providerCalls >= maxProviderCalls) {
      throw new Error(`Composition graph provider-call budget exhausted (${maxProviderCalls})`);
    }
    providerCalls += 1;
  };
}

function assertMaterializedControl(control: CompositionGraphControl): void {
  if (control.from.port !== 'causal-output' || control.from.type !== 'number'
    || control.to.port !== 'causal-input' || control.to.type !== 'number') {
    throw new Error(`Composition control ${control.id} is not supported by the production runtime`);
  }
}

function preflightMusicLayer(layer: CompositionLayerSpec): void {
  if (!AUDIO_DOMAINS.has(layer.domain) && layer.domain !== 'music') return;
  try {
    compileMusicCreativeThesis(layer.prompt);
  } catch {
    throw new Error(`Unsupported music/sound layer prompt for ${layer.domain}`);
  }
}

function compositionThesis(spec: CompositionSpec): CreativeThesis | undefined {
  const hasDeterministicMusic = spec.layers.some((layer) => AUDIO_DOMAINS.has(layer.domain));
  if (!hasDeterministicMusic) {
    if (spec.creativeThesis) validateCreativeThesis(spec.creativeThesis);
    return spec.creativeThesis;
  }
  const thesis = spec.creativeThesis ?? compileMusicCreativeThesis(
    [spec.title, ...spec.layers.map((layer) => `${layer.domain}: ${layer.prompt}`)].filter(Boolean).join('\n'),
  );
  const identity = creativeThesisIdentity(validateCreativeThesis(thesis));
  if (!(MUSIC_SOUND_SUPPORTED_CONTRACT_IDS as readonly string[]).includes(identity.principleId)) {
    throw new Error('Composition Creative Thesis is incompatible with deterministic music/sound evidence');
  }
  return thesis;
}

export class CompositionOrchestrator {
  /** Production seam for deterministic interaction/accessibility compositions. */
  static composeInteractiveArtifact(
    creativeThesis: CreativeThesis,
    options: BuildInteractiveArtifactOptions,
  ): { readonly html: string; readonly trace: InteractiveArtifactTrace } {
    return buildInteractiveArtifact(creativeThesis, options);
  }

  /**
   * Generate every layer and assemble a standalone layered HTML document.
   * Layers are generated concurrently; failures degrade gracefully (the layer
   * is dropped from the stack but recorded in the result).
   */
  static async compose(spec: CompositionSpec): Promise<CompositionResult> {
    return this.composeInternal(spec);
  }

  static async executeDeterministic(
    spec: Omit<CompositionSpec, 'maxProviderCalls' | 'renderGate'>,
  ): Promise<CompositionResult> {
    return this.composeInternal({ ...spec, maxProviderCalls: 0, renderGate: false });
  }

  private static async composeInternal(spec: CompositionSpec): Promise<CompositionResult> {
    if (!spec.layers || spec.layers.length === 0) {
      throw new Error('CompositionOrchestrator: spec must contain at least one layer');
    }
    if (spec.generationContext?.runProviderStage && !spec.executionPlan) {
      throw new Error('CompositionOrchestrator: governed provider stages require an execution plan');
    }
    const creativeThesis = compositionThesis(spec);
    for (const layer of spec.layers) preflightMusicLayer(layer);
    await registerAllGenerators();

    const title = spec.title ?? 'Sinter Composition';
    const background = spec.background ?? '#000';
    const compositionBrief = buildCompositionBrief(spec.layers);
    // The graph budget counts logical nodes. Only the host-governed stage
    // runner may admit a separately signed recovery provider call.
    const guardedProviderCalls = spec.maxProviderCalls === undefined
      ? undefined
      : spec.generationContext?.runProviderStage
        ? spec.maxProviderCalls * (spec.executionPlan?.retry.maxAttempts ?? 1)
        : spec.maxProviderCalls;
    const providerCallGuard = createProviderCallGuard(guardedProviderCalls);
    let graphExecution: GraphExecutionReceipt | undefined;
    const results = spec.executionPlan
      ? await this.generatePlannedLayers({ ...spec, creativeThesis }, compositionBrief, providerCallGuard, (receipt) => { graphExecution = receipt; })
      : await Promise.all(spec.layers.map((layer, index) =>
        this.generateLayer(layer, index, spec.background, compositionBrief, creativeThesis, providerCallGuard, undefined, spec.generationContext)));

    const html = this.assemble(title, background, results, results.map(r => r.code), creativeThesis,
      spec.executionPlan);

    // Measured-frame gate: what is actually ON SCREEN decides, not the spec.
    // Washed-out or crushed frames get one blend-demoted re-assembly (same
    // generated art, safer compositing); the better-measuring variant wins.
    let finalHtml = html;
    let renderGate: CompositeGateReport | undefined;
    const hasVisualLayer = results.some(r => r.generated && r.code && !AUDIO_DOMAINS.has(r.spec.domain));
    if (spec.renderGate !== false && gateEnabled() && hasVisualLayer) {
      const gated = await this.runRenderGate(title, background, results, html, creativeThesis,
        spec.executionPlan);
      finalHtml = gated.html;
      renderGate = gated.report;
    }
    finalHtml = this.embedGraphEvidence(finalHtml, spec.executionPlan, graphExecution);

    const layers: ComposedLayer[] = results.map((r, index) => ({
      domain: r.spec.domain,
      prompt: r.spec.prompt,
      blendMode: r.spec.blendMode ?? 'normal',
      opacity: r.spec.opacity ?? 1,
      codeLength: r.code.length,
      generated: r.generated,
      error: r.error,
      opaqueBackground: r.opaqueBackground,
      seamGuarded: r.seamGuarded,
      audioEvidence: r.audioEvidence,
      artifactHtml: r.generated ? this.wrapLayer(r.spec, r.code, index, creativeThesis) : undefined,
    }));
    const plan = creativeThesis?.formTypography;
    const creativeEvidence = plan ? {
      rationale: plan.rationale,
      selectedRows: plan.selected.map((row) => row.rowId),
      declaredTargets: plan.declaredTargets,
      gateEvidence: renderGate?.measure ? {
        measured: { meanLuminance: renderGate.measure.meanLuminance, brightnessStd: renderGate.measure.brightnessStd ?? 0, verdict: renderGate.verdict as string },
        // Honest accounting: one remediation attempt if a retry was tried,
        // independent of whether the original measurement recorded a non-ok
        // verdict. A measurement alone is NOT a revision attempt.
        remediation: { maxAttempts: 1 as const, attempts: renderGate.remediation ? 1 : 0, applied: renderGate.remediation?.applied === true },
      } : undefined,
    } : undefined;

    const failureProjection = spec.generationContext
      ? await spec.generationContext.ledger.failureProjection(
        spec.generationContext.runId,
        spec.generationContext.candidateId,
      )
      : undefined;

    return {
      html: finalHtml,
      title,
      background,
      layers,
      successCount: results.filter(r => r.generated).length,
      renderGate,
      creativeThesis,
      creativeEvidence,
      graphExecution,
      audioEvidence: results.flatMap((result) => result.audioEvidence ? [result.audioEvidence] : []),
      failureProjection,
    };
  }

  private static async generatePlannedLayers(
    spec: CompositionSpec,
    compositionBrief: string,
    providerCallGuard: (() => void) | undefined,
    onReceipt: (receipt: GraphExecutionReceipt) => void,
  ): Promise<GeneratedLayerResult[]> {
    const results: Array<GeneratedLayerResult | undefined> = new Array(spec.layers.length);
    const attempts = new Map<string, GenerationAttemptTelemetryContext>();
    if (!spec.executionContext?.onControl) {
      for (const control of spec.executionPlan?.controls ?? []) assertMaterializedControl(control);
    }
    const executionContext = spec.executionPlan?.controls.length
      ? { ...spec.executionContext,
          onControl: spec.executionContext?.onControl ?? (() => {}) }
      : spec.executionContext;
    const execution = await executeCompositionGraph(spec.executionPlan!, async (node, context) => {
      const existingAttemptTelemetry = attempts.get(node.id);
      const attemptTelemetry = existingAttemptTelemetry ?? (spec.generationContext
        ? await spec.generationContext.ledger.beginPrimary({
          runId: spec.generationContext.runId,
          candidateId: spec.generationContext.candidateId,
          domain: node.layer.domain,
          executorReservationDigest: spec.generationContext.executorReservationDigest,
          campaignFundingReservationDigest: spec.generationContext.campaignFundingReservationDigest,
          attemptId: spec.generationContext.primaryAttemptIds?.[node.id],
        })
        : undefined);
      if (!existingAttemptTelemetry && attemptTelemetry) {
        attempts.set(node.id, attemptTelemetry);
      }
      const generate = () => this.generateLayer(
        node.layer, node.sourceIndex, spec.background, compositionBrief, spec.creativeThesis,
        providerCallGuard, context.signal, spec.generationContext, attemptTelemetry,
      );
      const result = spec.generationContext?.runProviderStage
        ? await spec.generationContext.runProviderStage(
            { nodeId: node.id, attempt: context.attempt }, generate,
          )
        : await generate();
      results[node.sourceIndex] = result;
      if (!result.generated) throw new Error(result.error ?? `Layer ${node.id} failed`);
    }, {
      ...executionContext,
      signal: spec.signal,
      continueOnError: true,
      reserveRetry: spec.generationContext ? async (nodeId) => {
        const failed = attempts.get(nodeId);
        if (!failed) return false;
        const recovery = await spec.generationContext!.ledger.reserveRecovery({
          runId: spec.generationContext!.runId,
          candidateId: spec.generationContext!.candidateId,
          failedAttemptId: failed.attemptId,
          domain: failed.domain,
          recoveryAttemptId: spec.generationContext!.recoveryAttemptIds?.[nodeId],
        });
        if (!recovery.granted) return false;
        attempts.set(nodeId, recovery.context);
        return true;
      } : undefined,
    });
    onReceipt(execution);
    // Array#map skips holes. Graph cancellation can leave source-index slots
    // sparse, so materialize every slot before downstream assembly.
    return Array.from(results, (result, index) => result ?? {
      spec: spec.layers[index], code: '', generated: false, error: 'Composition graph execution cancelled',
    });
  }

  private static embedGraphEvidence(
    html: string,
    plan?: CompositionGraphExecutionPlan,
    receipt?: GraphExecutionReceipt,
  ): string {
    if (!plan || !receipt) return html;
    const payload = JSON.stringify({ schema: 'sinter.composition-graph', schemaVersion: '2.0',
      graphId: plan.graphId, nodes: plan.nodes.map(node => node.id), groups: plan.groups, scenes: plan.scenes,
      phases: plan.phases,
      controls: plan.controls, resources: plan.resources, timingIslands: plan.timingIslands,
      bridges: plan.bridges, receipt }).replace(/</g, '\\u003c');
    return html.replace('</body>', `<script id="sinter-graph-evidence" type="application/json">${payload}</script>\n</body>`);
  }

  /**
   * Render-measure the assembled composite; on a washout/too-dark verdict,
   * demote the offending non-base blend modes to 'normal' (at reduced
   * opacity), re-assemble, and keep whichever frame measures better. Never
   * throws — a gate failure degrades to the unmeasured composite.
   */
  private static async runRenderGate(
    title: string,
    background: string,
    results: Array<{ spec: CompositionLayerSpec; code: string; generated: boolean; opaqueBackground?: boolean; error?: string }>,
    html: string,
    creativeThesis?: CreativeThesis,
    executionPlan?: CompositionGraphExecutionPlan,
  ): Promise<{ report: CompositeGateReport; html: string }> {
    try {
      const measure = await measureCompositeHtml(html);
      const verdict = verdictFromMeasure(measure);
      if (verdict === 'ok') return { report: { verdict, measure }, html };

      const blendModes = results.map(r => (r.generated ? (r.spec.blendMode ?? 'normal') : 'normal'));
      const demote = layersToDemote(verdict, blendModes);
      if (demote.length === 0) {
        Logger.warn('CompositionOrchestrator', `[render-gate] ${verdict} frame (mean lum ${measure.meanLuminance.toFixed(2)}) but no demotable blend layer — keeping as-is`);
        return { report: { verdict, measure }, html };
      }

      const demoted = results.map((r, i) => (demote.includes(i)
        ? { ...r, spec: { ...r.spec, blendMode: 'normal' as BlendMode, opacity: (r.spec.opacity ?? 1) * DEMOTED_OPACITY_FACTOR } }
        : r));
      const retryHtml = this.assemble(title, background, demoted, demoted.map(r => r.code),
        creativeThesis, executionPlan);
      const measureAfter = await measureCompositeHtml(retryHtml);
      const verdictAfter = verdictFromMeasure(measureAfter);
      // A muddy frame is already mid-luminance, so distance-from-0.5 cannot
      // judge the retry — the spread (brightnessStd) is what mud lacks.
      const applied = verdictAfter === 'ok'
        || (verdict === 'muddy'
          ? (measureAfter.brightnessStd ?? 0) > (measure.brightnessStd ?? 0)
          : Math.abs(measureAfter.meanLuminance - 0.5) < Math.abs(measure.meanLuminance - 0.5));
      Logger.info('CompositionOrchestrator', `[render-gate] ${verdict} (lum ${measure.meanLuminance.toFixed(2)}, std ${(measure.brightnessStd ?? 0).toFixed(1)}) → demoted layers [${demote.join(',')}] → ${verdictAfter} (lum ${measureAfter.meanLuminance.toFixed(2)}, std ${(measureAfter.brightnessStd ?? 0).toFixed(1)}); ${applied ? 'kept demoted variant' : 'kept original'}`);
      return {
        report: { verdict, measure, remediation: { demotedLayers: demote, verdictAfter, measureAfter, applied } },
        html: applied ? retryHtml : html,
      };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      Logger.warn('CompositionOrchestrator', `[render-gate] unavailable: ${message}`);
      // Never synthesize a passing verdict: consumers score 'ok' as 1 with a
      // clean admission. An unmeasured frame is 'unavailable', not quality.
      return { report: { verdict: 'unavailable', skipped: message }, html };
    }
  }

  /**
   * Compose from a single natural-language idea: an LLM decomposes it into a
   * layer spec (which domains, what each layer is, blend modes), then the layers
   * are generated and assembled. This is the conversational entry to the
   * "combine outputs" capability.
   */
  static async composeFromPrompt(prompt: string, llm?: LLMClient): Promise<CompositionResult> {
    const spec = await this.decomposePrompt(prompt, llm);
    return this.compose(spec);
  }

  /** Generate one source-indexed layer without touching any sibling. */
  static async regenerateLayer(
    spec: CompositionLayerSpec,
    sourceIndex: number,
    stageBackground?: string,
    creativeThesis?: CreativeThesis,
  ): Promise<ComposedLayer> {
    preflightMusicLayer(spec);
    const executionThesis = AUDIO_DOMAINS.has(spec.domain)
      ? compositionThesis({ creativeThesis, layers: [spec] })
      : creativeThesis;
    if (executionThesis) validateCreativeThesis(executionThesis);
    await registerAllGenerators();
    const result = await this.generateLayer(spec, sourceIndex, stageBackground, undefined, executionThesis);
    return {
      domain: result.spec.domain,
      prompt: result.spec.prompt,
      blendMode: result.spec.blendMode ?? 'normal',
      opacity: result.spec.opacity ?? 1,
      codeLength: result.code.length,
      generated: result.generated,
      error: result.error,
      opaqueBackground: result.opaqueBackground,
      seamGuarded: result.seamGuarded,
      audioEvidence: result.audioEvidence,
      artifactHtml: result.generated
        ? this.wrapLayer(result.spec, result.code, sourceIndex, executionThesis)
        : undefined,
    };
  }

  /** Use an LLM to turn a free-form idea into a validated CompositionSpec. */
  static async decomposePrompt(prompt: string, llm?: LLMClient): Promise<CompositionSpec> {
    const client = llm ?? new LLMClient({ role: 'studio' });
    // Only invite an audio layer when the brief itself signals audio intent.
    // Models like GLM-5.2 reliably emit tone/strudel when invited, which then
    // fails compositionThesis because visual briefs compile to principleIds
    // outside MUSIC_SOUND_SUPPORTED_CONTRACT_IDS (#865).
    const invitesAudio = briefInvitesAudio(prompt);
    const domains = invitesAudio
      ? '"shader","three","p5","hydra","ascii","html","tone","strudel"'
      : '"shader","three","p5","hydra","ascii","html"';
    const audioLayerHint = invitesAudio
      ? ', and an optional audio layer (tone/strudel) last'
      : '';
    const system =
      'You are a composition planner for a creative-coding studio. Break a creative idea ' +
      'into the layers needed to stack into one piece. Reply with ONLY strict JSON ' +
      '(no markdown) of shape: {"title": string, "background": string (css color), "layers": ' +
      `[{"domain": one of [${domains}], ` +
      '"prompt": string, "blendMode": one of ["normal","screen","multiply","overlay","lighten","darken"], ' +
      '"opacity": number 0..1}]}. Order layers back-to-front (first = background). Put a background ' +
      'layer first (shader/three), foreground detail next (p5/ascii) with a "screen" or "lighten" ' +
      `blend so it shows through${audioLayerHint}. ` +
      'CONTRAST BETWEEN LAYERS IS CRITICAL — the composite must stay legible, not muddy: ' +
      'use "screen"/"lighten" for bright detail over a DARK background, and "normal" (opacity ~1) ' +
      'for an opaque focal element; AVOID "multiply"/"overlay"/"darken" unless two layers have ' +
      'clearly different lightness, because they muddy or wash out similar-value layers. ' +
      'Give each layer prompt a deliberate palette that contrasts the layers beneath it, and pick a ' +
      'background color at the opposite lightness end from the foreground. The composite should have ' +
      'ONE clear focal layer with depth — never an even, low-contrast mush. ' +
      'Use a brightening blend ("screen"/"lighten") on AT MOST ONE foreground layer; any additional ' +
      'foreground layers must use "normal" — stacking multiple screen/lighten layers washes the ' +
      'composite out to white.';
    const res = await client.generate(system, `Idea: ${prompt}`);
    const spec = this.parseSpec(res.code ?? '', prompt);
    // Cap cumulative brightening so multiple stacked screen/lighten layers don't wash
    // the composite out to white (#619 caveat). Excess bright layers have opacity capped.
    if (exceedsWashoutBudget(spec.layers)) {
      const before = spec.layers.map((l) => l.opacity);
      spec.layers = capLayerBrightness(spec.layers);
      const capped = spec.layers.filter((l, i) => l.opacity !== before[i]).length;
      Logger.info('CompositionOrchestrator', `Washout guard: capped opacity on ${capped} over-budget bright layer(s)`);
    }
    Logger.info('CompositionOrchestrator', `Decomposed prompt into ${spec.layers.length} layers: ${spec.layers.map(l => l.domain).join(', ')}`);
    return spec;
  }

  /**
   * Parse and sanitize an LLM decomposition into a valid CompositionSpec.
   * Tolerant of markdown fences; clamps opacity, validates domains/blend modes,
   * and falls back to a single p5 layer if nothing usable is found.
   */
  static parseSpec(raw: string, originalPrompt: string): CompositionSpec {
    const validDomains = new Set<DomainType>(Object.keys(DOMAIN_TO_ENTRY) as DomainType[]);
    // The full BlendMode union — 'difference'/'exclusion' are valid CSS mix-blend
    // modes (supported by blendModes.ts + the BlendBudget table) and must NOT be
    // silently dropped to 'normal'; dropping them loses a deliberate creative choice.
    const validBlends = new Set<BlendMode>(['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'difference', 'exclusion']);
    let parsed: unknown;
    try {
      const json = raw.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/i, '').trim() || raw.trim();
      const start = json.indexOf('{');
      const end = json.lastIndexOf('}');
      parsed = JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json);
    } catch {
      parsed = null;
    }
    const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
    const rawLayers = Array.isArray(obj.layers) ? obj.layers : [];
    const layers: CompositionLayerSpec[] = [];
    for (const l of rawLayers) {
      if (!l || typeof l !== 'object') continue;
      const r = l as Record<string, unknown>;
      const domain = String(r.domain || '').toLowerCase() as DomainType;
      if (!validDomains.has(domain)) continue;
      const blend = String(r.blendMode || 'normal').toLowerCase() as BlendMode;
      const opacityNum = typeof r.opacity === 'number' ? r.opacity : Number(r.opacity);
      layers.push({
        domain,
        prompt: typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt.trim() : originalPrompt,
        blendMode: validBlends.has(blend) ? blend : 'normal',
        opacity: Number.isFinite(opacityNum) ? Math.min(1, Math.max(0, opacityNum)) : 1,
      });
    }
    if (layers.length === 0) {
      // Decomposition failed — degrade to a single sketch of the whole idea.
      layers.push({ domain: 'p5', prompt: originalPrompt, blendMode: 'normal', opacity: 1 });
    }
    return {
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Sinter Composition',
      background: typeof obj.background === 'string' && obj.background.trim() ? obj.background.trim() : '#05070f',
      layers,
    };
  }

  private static async generateLayer(
    spec: CompositionLayerSpec,
    index: number,
    stageBackground?: string,
    compositionBrief?: string,
    creativeThesis?: CreativeThesis,
    providerCallGuard?: () => void,
    signal?: AbortSignal,
    generationContext?: CompositionGenerationContext,
    suppliedAttempt?: GenerationAttemptTelemetryContext,
  ): Promise<GeneratedLayerResult> {
    if (AUDIO_DOMAINS.has(spec.domain) && !generationContext?.runProviderStage) {
      try {
        if (!creativeThesis) throw new Error('Deterministic music layer requires a canonical composition Creative Thesis');
        const result = await generateMusic({
          prompt: buildLayerPrompt(spec.prompt, { isBase: index === 0, domain: spec.domain, stageBackground, compositionBrief, creativeThesis }),
          sourcePrompt: spec.prompt,
          platform: spec.domain === 'strudel' ? 'strudel' : 'p5-webaudio',
          creativeThesis,
          deterministicArtifact: true,
        });
        return { spec, code: result.code, generated: true, audioEvidence: result.evidence };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.warn('CompositionOrchestrator', `Deterministic music layer ${index} failed: ${message}`);
        return { spec, code: '', generated: false, error: message };
      }
    }
    // Pre-existing code stays byte-for-byte unchanged outside a frozen campaign.
    // Governed audio reaches its registered LLM generator so the required stage
    // can debit and settle the exact provider allocation.
    if (spec.code && spec.code.trim()) {
      const opaqueBackground = index > 0 && paintsOpaqueBackground(spec.code, spec.domain);
      return { spec, code: spec.code, generated: true, opaqueBackground };
    }
    const entryName = DOMAIN_TO_ENTRY[spec.domain];
    if (!entryName) {
      return { spec, code: '', generated: false, error: `unsupported layer domain: ${spec.domain}` };
    }
    const entry = generatorRegistry.getAll().find((e) => e.name === entryName);
    if (!entry) {
      return { spec, code: '', generated: false, error: `no generator registered for ${entryName}` };
    }
    try {
      const attemptTelemetry = suppliedAttempt ?? (generationContext
        ? await generationContext.ledger.beginPrimary({
          runId: generationContext.runId,
          candidateId: generationContext.candidateId,
          domain: spec.domain,
          executorReservationDigest: generationContext.executorReservationDigest,
          campaignFundingReservationDigest: generationContext.campaignFundingReservationDigest,
        })
        : undefined);
      // Base layer (z=1) may paint an opaque full-stage background — anchored to the
      // spec's declared background when one exists (F18); every foreground layer is
      // told to render on a transparent canvas so lower layers show through.
      const isBase = index === 0;
      const raw = await withProviderAttemptGuard(
        providerCallGuard,
        async () => entry.generate(buildLayerPrompt(spec.prompt, {
          isBase,
          domain: spec.domain,
          stageBackground,
          compositionBrief,
          creativeThesis,
        }), {
          signal,
          attemptTelemetry,
          attemptLedger: generationContext?.ledger,
          useGeneratorTools: generationContext?.runProviderStage ? false : undefined,
          coordinatorManagedRecovery: generationContext?.runProviderStage !== undefined,
        }),
      );
      const code = typeof raw === 'string' ? raw : raw.code;
      Logger.info('CompositionOrchestrator', `Layer ${index} (${spec.domain}) generated ${code.length} chars`);
      // Deterministic guard: flag a foreground layer that violated the contract.
      const opaqueBackground = !isBase && paintsOpaqueBackground(code, spec.domain);
      let actedSpec = spec;
      let seamGuarded = false;
      if (opaqueBackground) {
        // ACT on the detected seam (do not just observe): a foreground layer's
        // opaque full-canvas band hard-occludes everything beneath it under a
        // 'normal'/'multiply'/'darken'/'overlay' blend, producing the visible
        // seam. Force a brightening blend ('screen') so the opaque band adds
        // light instead of occluding — the seam disappears without regenerating
        // the art. Brightening blends ('screen'/'lighten') already let lower
        // layers through, so leave those untouched.
        const blend = spec.blendMode ?? 'normal';
        if (blend !== 'screen' && blend !== 'lighten') {
          actedSpec = { ...spec, blendMode: 'screen' };
          seamGuarded = true;
          Logger.warn('CompositionOrchestrator', `Layer ${index} (${spec.domain}) paints an opaque full-canvas background — seam guard forced blend '${blend}' → 'screen' so it no longer occludes lower layers`);
        } else {
          Logger.warn('CompositionOrchestrator', `Layer ${index} (${spec.domain}) paints an opaque full-canvas background under a brightening blend ('${blend}') — already non-occluding, seam guard left it as-is`);
        }
      }
      return { spec: actedSpec, code, generated: true, opaqueBackground, seamGuarded };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.warn('CompositionOrchestrator', `Layer ${index} (${spec.domain}) failed: ${message}`);
      return { spec, code: '', generated: false, error: message };
    }
  }

  private static wrapLayer(spec: CompositionLayerSpec, code: string, sourceIndex: number, creativeThesis?: CreativeThesis): string {
    const rawHtml = spec.domain === 'music' && /^<!DOCTYPE html>/i.test(code.trim())
      ? code
      : HTMLWrapper.wrap(code, {
        domain: DOMAIN_TO_WRAP[spec.domain] ?? 'p5',
        compositionForeground: sourceIndex > 0 && !AUDIO_DOMAINS.has(spec.domain),
      });
    const html = rawHtml.includes('</head>')
      ? rawHtml.replace('</head>', `${layerStateBridge(sourceIndex)}\n</head>`)
      : `${layerStateBridge(sourceIndex)}\n${rawHtml}`;
    return creativeThesis ? embedCreativeThesisIdentity(html, creativeThesis) : html;
  }

  /** Build the composite HTML: stacked, blended iframes — one per generated layer. */
  private static assemble(
    title: string,
    background: string,
    results: Array<{ spec: CompositionLayerSpec; code: string; generated: boolean; opaqueBackground?: boolean }>,
    _codes: string[],
    creativeThesis?: CreativeThesis,
    executionPlan?: CompositionGraphExecutionPlan,
  ): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeTitle = esc(title);
    const hasAudio = results.some((r) => r.generated && AUDIO_DOMAINS.has(r.spec.domain));
    const frames: string[] = [];

    let z = 1;
    for (const [layerIndex, r] of results.entries()) {
      if (!r.generated || !r.code) continue;
      const blend = r.spec.blendMode ?? 'normal';
      const opacity = r.spec.opacity ?? 1;
      const isAudio = AUDIO_DOMAINS.has(r.spec.domain);
      const layerHtml = this.wrapLayer(r.spec, r.code, layerIndex, creativeThesis);
      const dataUri = `data:text/html;base64,${Buffer.from(layerHtml, 'utf-8').toString('base64')}`;
      // Audio layers are invisible but must stay in the DOM to keep playing.
      const visualStyle = isAudio
        ? 'width:1px;height:1px;opacity:0;pointer-events:none;'
        : `width:100%;height:100%;mix-blend-mode:${blend};opacity:${opacity};`;
      frames.push(
        `      <iframe class="sinter-layer" data-layer-index="${layerIndex}" data-domain="${r.spec.domain}" ` +
        `data-opaque-background="${r.opaqueBackground === true}" data-base-opacity="${opacity}" allow="autoplay" ` +
        `style="position:absolute;inset:0;border:0;${visualStyle}z-index:${z};" src="${dataUri}"></iframe>`,
      );
      z++;
    }

    const startOverlay = hasAudio
      ? `  <button id="sinter-start" aria-label="Start composition" style="position:fixed;inset:0;z-index:9999;border:0;background:rgba(0,0,0,0.55);color:#fff;font:600 18px system-ui,sans-serif;cursor:pointer">▶ Click to start (audio)</button>
  <script>
    document.getElementById('sinter-start').addEventListener('click', function () {
      this.remove();
      document.querySelectorAll('iframe.sinter-layer').forEach(function (f) {
        try { f.contentWindow && f.contentWindow.postMessage('sinter:start', '*'); } catch (e) {}
        // Re-poke the iframe so any deferred audio context can resume on this gesture.
        var s = f.getAttribute('src'); f.setAttribute('src', s);
      });
    });
  </script>`
      : '';

    const nodeIndex = new Map(executionPlan?.nodes.map(node => [node.id, node.sourceIndex]) ?? []);
    const causalControls = (executionPlan?.controls ?? []).filter(control =>
      control.from.port === 'causal-output' && control.from.type === 'number'
      && control.to.port === 'causal-input' && control.to.type === 'number').map(control => ({
      id: control.id, from: nodeIndex.get(control.from.nodeId), to: nodeIndex.get(control.to.nodeId),
      scale: control.scale ?? 1, offset: control.offset ?? 0,
    })).filter(control => control.from !== undefined && control.to !== undefined);
    const causalJson = JSON.stringify(causalControls).replace(/</g, '\\u003c');
    const stateBridge = `<script>
  (function () {
    var started = performance.now();
    var state = { time: 0, sequence: 0, pointer: { x: 0.5, y: 0.5, down: false } };
    var causalControls = ${causalJson};
    function publish(now) {
      state.time = (now - started) / 1000; state.sequence += 1;
      document.querySelectorAll('iframe.sinter-layer').forEach(function (frame) {
        if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'sinter:state', state: state }, '*');
      });
      requestAnimationFrame(publish);
    }
    addEventListener('message', function (event) {
      var frames = Array.from(document.querySelectorAll('iframe.sinter-layer'));
      var sourceFrame = frames.find(function (frame) { return frame.contentWindow === event.source; });
      if (!sourceFrame) return;
      if (event.data && event.data.type === 'sinter:causal-output' && Number.isFinite(event.data.value)) {
        var source = Number(sourceFrame.dataset.layerIndex), value = Math.max(0, Math.min(1, event.data.value));
        causalControls.filter(function (control) { return control.from === source; }).forEach(function (control) {
          var target = frames.find(function (frame) { return Number(frame.dataset.layerIndex) === control.to; });
          if (!target || !target.contentWindow) return;
          var transformed = Math.max(0, Math.min(1, value * control.scale + control.offset));
          target.contentWindow.postMessage({ type: 'sinter:causal', controlId: control.id,
            sourceLayerIndex: source, value: transformed }, '*');
          if (!['tone','strudel','music'].includes(target.dataset.domain || '')) {
            var declaredBase = Number(target.dataset.baseOpacity);
            var base = Number.isFinite(declaredBase) ? declaredBase : 1;
            target.style.opacity = String(base * (0.7 + transformed * 0.3));
          }
        });
        return;
      }
      if (!event.data || event.data.type !== 'sinter:input') return;
      var bounded = function (value) { return Math.max(0, Math.min(1, Number(value) || 0)); };
      state.pointer = { x: bounded(event.data.x), y: bounded(event.data.y),
        down: event.data.inputType === 'pointerdown' ? true
          : event.data.inputType === 'pointerup' ? false : state.pointer.down };
    });
    requestAnimationFrame(publish);
  })();
  </script>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    html, body { margin: 0; height: 100%; background: ${background}; overflow: hidden; }
    #sinter-stage { position: fixed; inset: 0; }
    a.skip { position: absolute; left: -999px; }
  </style>
</head>
<body>
  <a class="skip" href="#sinter-stage">Skip to content</a>
  <main id="sinter-stage" role="img" aria-label="${safeTitle}">
${frames.join('\n')}
  </main>
${stateBridge}
${startOverlay}
</body>
</html>
`;
    return creativeThesis ? embedCreativeThesisIdentity(html, creativeThesis) : html;
  }
}

/**
 * Execute an already-materialized composition without provider calls or a
 * browser render gate. Candidate search uses this production primitive so its
 * internal executions do not masquerade as additional user compose requests.
 */
export function executeDeterministicComposition(
  spec: Omit<CompositionSpec, 'maxProviderCalls' | 'renderGate'>,
): Promise<CompositionResult> {
  return CompositionOrchestrator.executeDeterministic(spec);
}
