/**
 * Dream-aware replies for the shared fake provider (test/helpers/fakeProviderServer.ts).
 * Scoped to what `sinter dream run|transfer|activate|compound` and the governed Creates beneath them send:
 *   operator   (no images, task "Produce one baseline ...")  -> baseline + variant JSON
 *   producer   (no images, task "Create an unseen transfer artifact") -> a candidate; deeper when armAssignment=treatment
 *   evaluator  (images; task blind-criterion | unseen-transfer)       -> verdicts that favour depth
 *   compound judge (no images, has arms[])                            -> scores by whether the arm's artifact is a "deep" source
 *   plain Create generator                                            -> deep HTML when a validated-transfer lesson is in the prompt
 * Nothing here calls a real provider; every reply is deterministic.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { goodJudgeReply, type FakeCall } from './fakeProviderServer.js';

export const LESSON_PREFIX = 'Validated transfer: ';
const page = (title: string, body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#0b0d1a;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body><canvas id="c"></canvas><script>${body}</script></body></html>`;

/** Flat: one ring of dots, no overlap. */
export const flatHtml = (seed: number) => page(`Flat ${seed}`,
  `const c=document.getElementById('c'),x=c.getContext('2d');function f(t){c.width=innerWidth;c.height=innerHeight;x.fillStyle='#0b0d1a';x.fillRect(0,0,c.width,c.height);for(let i=0;i<24;i++){const a=i/24*6.283+t/2000+${seed};x.fillStyle='hsl('+(i*15+${seed * 20})+',70%,60%)';x.beginPath();x.arc(c.width/2+Math.cos(a)*c.height/4,c.height/2+Math.sin(a)*c.height/4,10,0,6.283);x.fill()}requestAnimationFrame(f)}requestAnimationFrame(f)`);
/** Deep: three scaled strata that occlude each other and drift at different speeds. */
export const deepHtml = (seed: number) => page(`Deep ${seed}`,
  `const c=document.getElementById('c'),x=c.getContext('2d');function f(t){c.width=innerWidth;c.height=innerHeight;x.fillStyle='#0b0d1a';x.fillRect(0,0,c.width,c.height);for(let L=0;L<3;L++){const s=1+L*0.8,sp=(L+1)*0.0004;for(let i=0;i<14;i++){const a=i/14*6.283+t*sp+${seed};x.globalAlpha=0.5+L*0.2;x.fillStyle='hsl('+(L*120+i*26+${seed * 20})+',85%,'+(40+L*10)+'%)';x.beginPath();x.arc(c.width/2+Math.cos(a)*c.height/5*s,c.height/2+Math.sin(a)*c.height/6*s,16*s,0,6.283);x.fill()}}x.globalAlpha=1;requestAnimationFrame(f)}requestAnimationFrame(f)`);

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (call: FakeCall): Record<string, unknown> => {
  try { return JSON.parse(call.user) as Record<string, unknown>; } catch { /* user text may carry a trailing frame legend */ }
  const task = /^\{"task":"([^"]+)"/.exec(call.user)?.[1];
  return task ? { task } : {};
};

export interface DreamFakeLog { readonly kinds: string[]; readonly deepDigests: Set<string> }
/**
 * `storeFile` is the product store the CLI writes: the compound judge sees only receipt artifact digests, so
 * it maps them to source digests there and asks whether that source is one this fake wrote as "deep".
 */
export function dreamReplies(log: DreamFakeLog = { kinds: [], deepDigests: new Set() }, storeFile?: () => string) {
  const isDeep = (artifactDigest: string): boolean => {
    if (log.deepDigests.has(artifactDigest) || !storeFile) return log.deepDigests.has(artifactDigest);
    try {
      const store = JSON.parse(readFileSync(storeFile(), 'utf8')) as Record<string, { result?: {
        receipt?: { artifactDigest?: string }; artifacts?: { sourceDigest?: string } } }>;
      return Object.values(store).some(p => p.result?.receipt?.artifactDigest === artifactDigest
        && log.deepDigests.has(p.result.artifacts?.sourceDigest ?? ''));
    } catch { return false; }
  };
  const deep = (seed: number) => { const h = deepHtml(seed); log.deepDigests.add(sha256(h)); return h; };
  const candidate = (id: string, source: string) => ({ id, source, layerIds: ['depth-layer'], domains: ['html'] });
  const generate = (call: FakeCall): string => {
    const u = json(call);
    if (typeof u.task === 'string' && u.task.startsWith('Produce one baseline')) {
      log.kinds.push('operator');
      // Each study needs its own bytes: activation rejects artifacts shared between studies.
      const seed = 100 + (parseInt(sha256(call.system + call.user).slice(0, 6), 16) % 400);
      return JSON.stringify({ baseline: candidate('baseline', flatHtml(seed)),
        variant: { ...candidate('variant', deep(seed)), changedPaths: ['composition.depth'] } });
    }
    if (u.task === 'Create an unseen transfer artifact') {
      const treatment = u.armAssignment === 'treatment';
      const pseed = 500 + (parseInt(sha256(call.system + call.user).slice(0, 6), 16) % 400);
      log.kinds.push(treatment ? 'producer-treatment' : 'producer-control');
      return JSON.stringify(candidate(treatment ? 'treatment' : 'control', treatment ? deep(pseed) : flatHtml(pseed)));
    }
    if (Array.isArray(u.arms) && typeof u.taskId === 'string') {
      log.kinds.push('compound-judge');
      const arms = u.arms as Array<{ armId: string; artifactDigest: string }>;
      return JSON.stringify({ armScores: Object.fromEntries(arms.map(a => [a.armId, isDeep(a.artifactDigest) ? 0.85 : 0.45])) });
    }
    // plain governed Create: the activated lesson reaches the prompt as `Validated transfer: ...`
    const taught = (call.system + call.user).includes(LESSON_PREFIX);
    log.kinds.push(taught ? 'create-taught' : 'create-plain');
    const seed = 3 + (parseInt(sha256(call.system + call.user).slice(0, 6), 16) % 40); // distinct prompt, distinct artifact
    return taught ? deep(seed) : flatHtml(seed);
  };
  const judge = (call: FakeCall): Record<string, unknown> => {
    const u = json(call);
    if (u.task === 'unseen-transfer') { log.kinds.push('transfer-evaluator'); return { outcome: 'validated' }; }
    if (u.task === 'blind-criterion') {
      log.kinds.push('blind-evaluator');
      return { outcome: 'keeper', uncertainty: 0.1, criteria: [{ criterion: 'visual-depth', direction: 'improved' }] };
    }
    log.kinds.push('create-judge');
    return goodJudgeReply(0.8);
  };
  return { generate, judge, log };
}
