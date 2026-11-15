/**
 * Liminal-owned transfer oracle (ralplan AC6).
 * Fixed flat vs layered HTML fixtures + dual-eval gate scoring.
 * Live evaluators may be injected; no free-form generation for the oracle pair.
 */
import type { DreamTransferOutcome } from '../dreaming/research/DreamResearchTypes.js';
import type { DreamCreativeCandidate } from '../dreaming/research/DreamRenderedExperimentExecutor.js';
import { createHash } from 'node:crypto';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Control fixture: deliberately flat — single mid-grey slab, no depth stack. */
export const ORACLE_FLAT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#2a2a2a}canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function r(){c.width=innerWidth;c.height=innerHeight;x.fillStyle='#404040';x.fillRect(0,0,c.width,c.height);
x.fillStyle='#707070';x.fillRect(c.width*0.25,c.height*0.4,c.width*0.5,c.height*0.2);}
addEventListener('resize',r);r();
</script></body></html>`;

/** Treatment fixture: unmistakable multi-layer depth (occlusion + scale strata + FG). */
export const ORACLE_LAYERED_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0e1413;overflow:hidden}canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function r(){const w=innerWidth,h=innerHeight,d=devicePixelRatio||1;c.width=w*d;c.height=h*d;x.setTransform(d,0,0,d,0,0);
const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,'#1a2824');g.addColorStop(1,'#0a0e0d');x.fillStyle=g;x.fillRect(0,0,w,h);
// soft depth stacking + layered occlusion + scale strata (far→near)
for(let i=0;i<6;i++){const t=i/5,s=0.25+t*0.7,cx=w*(0.35+t*0.06),cy=h*(0.62-t*0.12),rw=w*s*0.4,rh=h*s*0.18;
x.globalAlpha=0.2+t*0.18;x.fillStyle=i%2?'#7ab8a4':'#3d4544';x.beginPath();
x.ellipse(cx,cy,rw,rh,0,0,Math.PI*2);x.fill();}
// near-field occluder + parallax-like FG bar
x.globalAlpha=0.85;x.fillStyle='#c9e8d8';x.beginPath();x.ellipse(w*0.72,h*0.42,w*0.12,h*0.08,0,0,Math.PI*2);x.fill();
x.globalAlpha=1;x.fillStyle='rgba(8,12,11,0.72)';x.fillRect(0,h*0.68,w,h*0.32);
x.fillStyle='#9fd4bc';x.fillRect(0,h*0.68,w,4);}
addEventListener('resize',r);r();requestAnimationFrame(function loop(){r();requestAnimationFrame(loop);});
</script></body></html>`;

export function oracleControlCandidate(): DreamCreativeCandidate {
  return {
    id: 'oracle-flat-control',
    source: ORACLE_FLAT_HTML,
    graphDigest: sha(ORACLE_FLAT_HTML),
    layerIds: ['flat-field'],
    domains: ['html'],
  };
}

export function oracleTreatmentCandidate(): DreamCreativeCandidate {
  return {
    id: 'oracle-layered-treatment',
    source: ORACLE_LAYERED_HTML,
    graphDigest: sha(ORACLE_LAYERED_HTML),
    layerIds: ['depth-shell-0', 'depth-shell-1', 'depth-shell-2'],
    domains: ['html'],
  };
}

export type OracleGateResult = {
  readonly eval1: DreamTransferOutcome;
  readonly eval2: DreamTransferOutcome;
  /** pass only when both validators say validated (layered preferred). */
  readonly gate: 'pass' | 'abort';
  readonly reason: string;
};

/**
 * AC6 scoring: dual-validated → pass holdouts; dual-split or dual-falsified → abort.
 */
export function scoreOracleDualEval(
  eval1: DreamTransferOutcome,
  eval2: DreamTransferOutcome,
): OracleGateResult {
  if (eval1 === 'validated' && eval2 === 'validated') {
    return Object.freeze({
      eval1, eval2, gate: 'pass',
      reason: 'dual-validated: layered preferred over flat; holdout battery allowed',
    });
  }
  if (eval1 === 'falsified' && eval2 === 'falsified') {
    return Object.freeze({
      eval1, eval2, gate: 'abort',
      reason: 'dual-falsified: evaluators prefer flat over layered; diagnose seats, do not auto-B',
    });
  }
  return Object.freeze({
    eval1, eval2, gate: 'abort',
    reason: 'dual-split or non-unanimous: inconclusive disagreement; abort holdout battery',
  });
}

export type OracleReceipt = {
  readonly schema: 'sinter.wave8-transfer-oracle-receipt';
  readonly schemaVersion: 1;
  readonly controlGraphDigest: string;
  readonly treatmentGraphDigest: string;
  readonly eval1: DreamTransferOutcome;
  readonly eval2: DreamTransferOutcome;
  readonly gate: 'pass' | 'abort';
  readonly reason: string;
  readonly holdoutsAllowed: boolean;
};

export function buildOracleReceipt(
  eval1: DreamTransferOutcome,
  eval2: DreamTransferOutcome,
): OracleReceipt {
  const scored = scoreOracleDualEval(eval1, eval2);
  const control = oracleControlCandidate();
  const treatment = oracleTreatmentCandidate();
  return Object.freeze({
    schema: 'sinter.wave8-transfer-oracle-receipt',
    schemaVersion: 1,
    controlGraphDigest: control.graphDigest,
    treatmentGraphDigest: treatment.graphDigest,
    eval1: scored.eval1,
    eval2: scored.eval2,
    gate: scored.gate,
    reason: scored.reason,
    holdoutsAllowed: scored.gate === 'pass',
  });
}
