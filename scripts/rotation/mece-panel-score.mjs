#!/usr/bin/env node
/**
 * MECE panel seat scoring (W9-OPS-01 / #463).
 * Seat green: planBytes >= 200 AND exitCode === 0.
 * Model verdict is ignored for ok (may be logged only).
 * Not the same as recursive evaluateWaveGate / continuity green.
 */

export const PLAN_BYTES_MIN = 200;

/**
 * @param {{ planBytes?: number, exitCode?: number, verdict?: unknown }} input
 * @returns {{ ok: boolean, planBytes: number, exitCode: number, verdict: unknown }}
 */
export function scoreMeceDiagnoseSeat(input = {}) {
  const planBytes = Number(input.planBytes ?? 0);
  const exitCode = Number(input.exitCode ?? 1);
  const verdict = input.verdict === undefined ? null : input.verdict;
  const ok = Number.isFinite(planBytes) && planBytes >= PLAN_BYTES_MIN && exitCode === 0;
  return { ok, planBytes: Number.isFinite(planBytes) ? planBytes : 0, exitCode: Number.isFinite(exitCode) ? exitCode : 1, verdict };
}

/**
 * @param {Array<{ ok?: boolean }>} seats
 * @returns {{ allGreen: boolean, seats: typeof seats }}
 */
export function scoreMecePanel(seats = []) {
  const list = Array.isArray(seats) ? seats : [];
  return { seats: list, allGreen: list.length > 0 && list.every((s) => Boolean(s && s.ok)) };
}

function main(argv) {
  const cmd = argv[2];
  if (cmd === 'seat') {
    const raw = argv[3] || '{}';
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(scoreMeceDiagnoseSeat(input)) + '\n');
    return;
  }
  if (cmd === 'panel') {
    const raw = argv[3] || '[]';
    const seats = JSON.parse(raw);
    const scored = seats.map((s) => ({ ...s, ...scoreMeceDiagnoseSeat(s) }));
    process.stdout.write(JSON.stringify(scoreMecePanel(scored)) + '\n');
    return;
  }
  if (cmd === 'help' || !cmd) {
    process.stdout.write(
      'Usage:\n' +
        '  node scripts/rotation/mece-panel-score.mjs seat \'{"planBytes":4000,"exitCode":0,"verdict":null}\'\n' +
        '  node scripts/rotation/mece-panel-score.mjs panel \'[{"planBytes":4000,"exitCode":0},...]\'\n' +
        'Seat ok = planBytes>=200 && exitCode===0 (verdict ignored).\n',
    );
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('mece-panel-score.mjs') ||
    process.argv[1].includes('mece-panel-score'));
if (isMain) main(process.argv);
