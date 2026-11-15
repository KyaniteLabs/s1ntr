#!/usr/bin/env node
/**
 * MECE rotation — assign models to fixed lanes.
 * Usage: node scripts/rotation/mece-rotate.mjs --round N --wave W --write-briefs
 * Invariant: L1/L2={sol,kimi} L3/L4={grok,glm}; odd rounds flip pairs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const MODELS = {
  sol: { id: 'sol', model: 'gpt-5.6-sol', reasoning: 'high', extra: ['--base-url', 'http://localhost:8317/v1'] },
  kimi: { id: 'kimi', model: 'moonshotai/kimi-k3', reasoning: 'high', extra: ['--base-url', 'https://api.kilo.ai/api/gateway'] },
  grok: { id: 'grok', model: 'grok-4.5', reasoning: 'high', extra: ['--auth', 'grok'] },
  glm: { id: 'glm', model: 'glm-5.2', reasoning: 'high', extra: ['--base-url', 'https://api.z.ai/api/anthropic'] },
};

const LANES = {
  L1: { name: 'envelope-gate-e2e', title: 'envelope + proofChain + two-attempt E2E + pure wave-gate',
    read: 'docs/agents/waves/staged/BOUNDARY_TABLE.md, src/harness/CompoundRunEnvelope.ts, test/unit/harness/compound-harvest-e2e.test.ts',
    forbid: 'L2 publisher/harvest; L3 timeout; L4 allowlist' },
  L2: { name: 'publisher-harvest', title: 'PlanPublisher + harvest + verify-before-learn',
    read: 'docs/agents/waves/staged/BOUNDARY_TABLE.md, src/harness/PlanPublisher.ts, src/harness/SelfImproveCompoundLoop.ts',
    forbid: 'L1 envelope/wave-gate; L3 timeout; L4 process' },
  L3: { name: 'timeout-transport', title: 'timeout wiring, failureClass, retryable, boundaryMs',
    read: 'src/llm/LLMClient.ts, src/harness/CompoundRunEnvelope.ts, scripts/rotation/batteries.mjs',
    forbid: 'L1 envelope redesign; L2 harvest; L4 allowlist' },
  L4: { name: 'process-allowlist', title: 'allowlist, staging, mandate dedup, receipt discipline',
    read: 'src/harness/DiagnosePathAllowlist.ts, scripts/rotation/stage-diagnose-inputs.mjs',
    forbid: 'L1/L2/L3 product compound implementation' },
};

function parseArgs(argv) {
  const o = { round: 0, wave: 8, print: true, writeBriefs: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--round') o.round = Number(argv[++i]);
    else if (argv[i] === '--wave') o.wave = Number(argv[++i]);
    else if (argv[i] === '--write-briefs') o.writeBriefs = true;
    else if (argv[i] === '--print') o.print = true;
  }
  return o;
}

export function assignmentForRound(round) {
  const flip = (Number(round) || 0) % 2 === 1;
  return {
    round: Number(round) || 0,
    L1: flip ? MODELS.kimi : MODELS.sol,
    L2: flip ? MODELS.sol : MODELS.kimi,
    L3: flip ? MODELS.glm : MODELS.grok,
    L4: flip ? MODELS.grok : MODELS.glm,
  };
}

function tipSha() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function briefFor(laneKey, model, tip) {
  const lane = LANES[laneKey];
  return `ARCHITECT DIAGNOSE ONLY — LANE ${laneKey} ONLY (${lane.name}). No mutations. Tools + executeSkill only.
LOAD FIRST: executeSkill comorbidity-check then systematic-debugging (expectedResult short quoted ≤60 chars).
TIP SHA: ${tip}
MODEL: ${model.model} reasoning=${model.reasoning}
YOU OWN ONLY: ${lane.title}.
READ: ${lane.read}
FORBIDDEN LANES: ${lane.forbid}.
FORBIDDEN: re-prove SelfImproveCompoundLoop existence; laundry list; product mutations; other lanes.
DELIVER complete(params.plan)≥200: BLUF; residual ONLY in ${laneKey}; max 5 P0/P1; path evidence; acceptance.
`;
}

const args = parseArgs(process.argv);
const assign = assignmentForRound(args.round);
const tip = tipSha();
const map = {
  tip, wave: args.wave, round: assign.round,
  seats: {
    L1: { lane: LANES.L1.name, model: assign.L1.model, reasoning: assign.L1.reasoning, extra: assign.L1.extra, id: assign.L1.id },
    L2: { lane: LANES.L2.name, model: assign.L2.model, reasoning: assign.L2.reasoning, extra: assign.L2.extra, id: assign.L2.id },
    L3: { lane: LANES.L3.name, model: assign.L3.model, reasoning: assign.L3.reasoning, extra: assign.L3.extra, id: assign.L3.id },
    L4: { lane: LANES.L4.name, model: assign.L4.model, reasoning: assign.L4.reasoning, extra: assign.L4.extra, id: assign.L4.id },
  },
  invariant: 'L1/L2={sol,kimi} L3/L4={grok,glm}',
  nextRound: assign.round + 1,
};
console.log(JSON.stringify(map, null, 2));
if (args.writeBriefs) {
  const dir = join(process.cwd(), `.quality/wave${args.wave}`, 'briefs');
  mkdirSync(dir, { recursive: true });
  for (const key of ['L1', 'L2', 'L3', 'L4']) {
    const m = assign[key];
    const text = briefFor(key, m, tip);
    writeFileSync(join(dir, `${key.toLowerCase()}-active.txt`), text);
  }
  writeFileSync(join(process.cwd(), `.quality/wave${args.wave}`, 'ROTATION.json'), JSON.stringify(map, null, 2) + '\n');
  console.error('wrote briefs', dir);
}
