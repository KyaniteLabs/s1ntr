/* eslint-disable no-console -- CLI command output: console output is intentional */
import { ModelRotator } from '../atelier/ModelRotator.js';
import { auditRotation, readDispatchDoctor } from '../atelier/DispatchRotation.js';

export function runRotateCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  const rotator = new ModelRotator(cwd);

  if (cmdArgs[0] === 'stats') {
    const stats = rotator.stats();
    console.log(`[rotate] current: ${stats.currentModel}`);
    for (const m of stats.models) {
      console.log(`  ${m.avgScore.toFixed(2)}  ${m.id}  (${m.turns} turns, best: ${m.bestDomain})`);
    }
    return;
  }

  if (cmdArgs[0] === 'audit' || cmdArgs[0] === 'next') {
    const doctor = readDispatchDoctor();
    const health = auditRotation(rotator.lanes(), doctor);
    if (cmdArgs[0] === 'audit') {
      for (const lane of health) console.log(`${lane.status}\t${lane.modelId}\t${lane.executor ?? 'no exact Dispatch mapping'}`);
      const mapped = new Set(health.map(lane => lane.executor));
      for (const row of doctor ?? []) {
        if (row.available && !mapped.has(row.executor)) console.log(`dispatch-only\t${row.executor}\tadapter review required`);
      }
      if (health.length === 0) console.log('no rotation matrix for this machine');
      if (health.some(lane => lane.status !== 'available') || health.length === 0) process.exitCode = 3;
      return;
    }
    const eligible = new Set(health.filter(lane => lane.status === 'available')
      .map(lane => `${lane.modelId}|${lane.baseUrl ?? ''}`));
    const next = rotator.nextEligible(eligible);
    console.log(JSON.stringify(next ?? { modelId: 'hold', note: 'no Dispatch-available mapped rotation lane' }));
    return;
  }

  // sinter rotate record <modelId> <domain> <mean> — the loop feeds each
  // scored turn back so bestForDomain() learning has real outcomes.
  if (cmdArgs[0] === 'record' && cmdArgs.length >= 4) {
    const [, modelId, domain, meanStr] = cmdArgs;
    const mean = parseFloat(meanStr);
    if (!Number.isFinite(mean)) {
      console.error('[rotate] record: mean must be a number');
      process.exitCode = 2;
      return;
    }
    rotator.recordOutcome(modelId, domain, mean);
    console.log(`[rotate] recorded ${modelId} ${domain} ${mean}`);
    return;
  }

  console.error('usage: sinter rotate [next|audit|stats|record <model> <domain> <mean>]');
}
