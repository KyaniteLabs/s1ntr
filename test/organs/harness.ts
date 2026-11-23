/**
 * Organ E2E harness (Simon, 2026-11-19: "every single organ inside of sinter needs to be fully
 * integrated, tested end to end").
 *
 * One real generation through the production entrypoint (`runProductionCliGenerate` ->
 * `createProductionLiminalRuntime` -> real command service, validation, persistence, headless
 * render, perception, scoring, admission). Only the two LLM seats are stubs, and both record
 * everything they are sent. An organ test perturbs the organ's state, runs this twice, and
 * asserts the recorded brief, the score or the route moved. A disconnected organ cannot move
 * anything, so its test fails.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProductionCliGenerate, type ProductionCliGenerateResult } from '../../src/cli/LiminalProductionGenerate.js';
import { createProductionLiminalRuntime } from '../../src/runtime-core/ProductionLiminalRuntime.js';
import { createTestReceiptAuthority } from '../../src/runtime-core/LiminalCommandService.js';
import { createTestLiminalOwnerReviewAuthority } from '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import type { LLMClient } from '../../src/llm/LLMClient.js';

/** A tiny, valid, animated html piece: cheap to render, never blank. */
export const LIVELY_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Orbit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;height:100%;background:#0b0b1a;overflow:hidden}
canvas{display:block}</style></head><body><canvas id="c"></canvas><script>
const c=document.getElementById('c');const x=c.getContext('2d');
function fit(){c.width=innerWidth;c.height=innerHeight}fit();addEventListener('resize',fit);
let t=0;(function f(){t+=0.04;x.fillStyle='rgba(11,11,26,0.18)';x.fillRect(0,0,c.width,c.height);
for(let i=0;i<40;i++){const a=t*(0.3+i*0.02)+i;const r=60+i*7+Math.sin(t+i)*30;
x.fillStyle='hsl('+(i*9+t*40)%360+',90%,'+(35+25*Math.sin(t+i))+'%)';
x.beginPath();x.arc(c.width/2+Math.cos(a)*r,c.height/2+Math.sin(a)*r,4+3*Math.sin(t*2+i),0,7);x.fill()}
requestAnimationFrame(f)})();</script></body></html>`;

export interface SeatCall { readonly system: string; readonly user: string; readonly images: number }

export interface OrganRunInput {
  readonly domain?: string;
  readonly prompt?: string;
  /** Source the stub generator returns. */
  readonly code?: string;
  /** JSON the stub judge returns for every call. */
  readonly judgeReply?: Record<string, unknown>;
  /** Working directory of the run: lessons/exemplar state (`.omx/atelier`) is cwd-relative. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly teachScope?: string;
  readonly knowledgeRoot?: string;
  readonly outputRoot?: string;
}

export interface OrganRun {
  readonly result: ProductionCliGenerateResult;
  readonly generatorCalls: readonly SeatCall[];
  readonly judgeCalls: readonly SeatCall[];
  readonly outputRoot: string;
  /** The generator's system prompt: the brief every taught organ lands in. */
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly evaluation: { score: number; failureClass?: string; degraded?: boolean; admissionEligible?: boolean;
    rejectionReasons?: readonly string[]; [key: string]: unknown };
  readonly cleanup: () => Promise<void>;
}

const DIMENSIONS = ['cohesion', 'structuralDepth', 'spatialEmbodiment', 'materiality', 'motionPurpose',
  'composition', 'palette', 'finish'] as const;
export const DEFAULT_JUDGE_REPLY = Object.freeze({ score: 0.8, confidence: 0.9, reasoning: 'stub judge',
  dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, 0.8])) });

function seat(role: string, reply: (system: string, user: string) => string, calls: SeatCall[]): LLMClient {
  const record = (system: string, user: string, images: number) => calls.push({ system, user, images });
  const answer = (code: string) => ({ success: true, code, provider: 'organ-stub', model: role });
  return {
    getConfig: () => ({ provider: 'organ-stub', model: `${role}-stub`, timeout: 120_000 }),
    generate: async (system: string, user: string) => { record(system, user, 0); return answer(reply(system, user)); },
    generateWithImages: async (system: string, user: string, images: readonly unknown[]) => {
      record(system, user, images.length); return answer(reply(system, user));
    },
  } as unknown as LLMClient;
}

/** Runs `fn` with env overrides applied to process.env, restoring every key afterwards. */
async function withEnv<T>(env: Readonly<Record<string, string | undefined>>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

export async function runOrganGeneration(input: OrganRunInput = {}): Promise<OrganRun> {
  const domain = input.domain ?? 'html';
  const outputRoot = input.outputRoot ?? await mkdtemp(path.join(os.tmpdir(), 'organ-run-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'organ-state-'));
  const generatorCalls: SeatCall[] = [];
  const judgeCalls: SeatCall[] = [];
  const generator = seat('generator', () => input.code ?? LIVELY_HTML, generatorCalls);
  const evaluator = seat('evaluator', () => JSON.stringify(input.judgeReply ?? DEFAULT_JUDGE_REPLY), judgeCalls);
  const previousCwd = process.cwd();
  const env = { SINTER_LIMINAL_RUNTIME_ROOT: undefined, SINTER_LIMINAL_KNOWLEDGE_ROOT: undefined,
    SINTER_EXEMPLARS_FILE: undefined, ...input.env };
  const cleanup = async () => {
    await rm(stateRoot, { recursive: true, force: true });
    if (!input.outputRoot) await rm(outputRoot, { recursive: true, force: true });
  };
  try {
    if (input.cwd) process.chdir(input.cwd);
    const result = await withEnv(env, () => runProductionCliGenerate({
      prompt: input.prompt ?? 'A slow orbit of colored light', domain, outputRoot,
      ...(input.teachScope ? { teachScope: input.teachScope } : {}),
    }, (options) => createProductionLiminalRuntime({ ...options, root: stateRoot,
      ...(input.knowledgeRoot ? { knowledgeRoot: input.knowledgeRoot } : {}),
      generator, evaluator, renderer: HeadlessRenderer.getInstance(),
      sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
      harnessIdentity: 'organ-stub/harness', studioIdentity: 'organ-stub/studio',
      receiptAuthority: createTestReceiptAuthority('organ-e2e-receipt-secret'),
      ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('organ-e2e-owner-secret'),
      knowledgeSigningKey: 'organ-e2e-knowledge-secret' })));
    const evaluation = (result.result as unknown as { evaluation?: OrganRun['evaluation'] }).evaluation
      ?? ({ score: Number.NaN } as OrganRun['evaluation']);
    const first = generatorCalls[0];
    return { result, generatorCalls, judgeCalls, outputRoot, systemPrompt: first?.system ?? '',
      userPrompt: first?.user ?? '', evaluation, cleanup };
  } finally {
    process.chdir(previousCwd);
  }
}
