/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * RescueCli — the `sinter rescue` command surface.
 *
 * Salvage rejected generations: the mechanical recovery chain first (same
 * semantics as the spine), ONE bounded LLM repair for the still-dead, then the
 * honest false-kill rate. Repair knowledge feeds system lessons through the
 * staging gate — never piece duplication (no-duplicator law).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rescuePool, writeRescueArtifacts } from '../atelier/RejectRescue.js';

interface RepairClient {
  generate: (system: string, user: string) => Promise<{ success: boolean; code?: string }>;
}

interface SeatConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  provider?: string;
  glmCodingPlanSeat?: boolean;
  maxTokens?: number;
}

/** Raw seat fetch (the sss-score judge pattern) — a bare LLMClient outside a
 *  product command hits the executor-authority gate. */
function buildRepairClient(): RepairClient | null {
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.HOME || '.', '.sinter', 'config.json'), 'utf8'));
    const seat: SeatConfig | undefined = cfg?.roles?.harness ?? cfg?.roles?.generator;
    if (!seat?.baseUrl || !seat?.model) return null;
    const isAnthropic = /anthropic/i.test(seat.baseUrl) || seat.provider === 'anthropic';
    const maxTokens = seat.maxTokens || (seat.glmCodingPlanSeat ? 32000 : 16000);
    return {
      generate: async (system, user) => {
        if (isAnthropic) {
          const res = await fetch(`${seat.baseUrl!.replace(/\/$/, '')}/v1/messages`, {
            method: 'POST',
            headers: { 'x-api-key': seat.apiKey ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: seat.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
            signal: AbortSignal.timeout(300000),
          });
          const data = await res.json() as { content?: Array<{ text?: string }> };
          const text = (data.content || []).map(block => block.text || '').join('');
          return { success: text.trim().length > 0, code: text };
        }
        const base = seat.baseUrl!.replace(/\/$/, '').replace(/\/chat\/completions$/, '');
        const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${seat.apiKey ?? ''}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: seat.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
          signal: AbortSignal.timeout(300000),
        });
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content || '';
        return { success: text.trim().length > 0, code: text };
      },
    };
  } catch {
    return null;
  }
}

export async function runRescueCommand(cmdArgs: string[], flags: { sweep?: boolean; noLlm?: boolean } = {}): Promise<void> {
  const wantsSweep = flags.sweep === true || cmdArgs.includes('--sweep');
  if (wantsSweep) {
    // PROACTIVE MODE — the standing organ: one pass over this machine's fresh
    // generation-failure records. The loop invokes this every wave; manual use
    // works too. Bounded: ≤6 records + ≤2 LLM repairs per sweep.
    const { sweepRejects } = await import('../atelier/RejectRescue.js');
    const result = await sweepRejects(process.cwd(), {
      llm: !(flags.noLlm || cmdArgs.includes('--no-llm')),
      buildRepairClient: (flags.noLlm || cmdArgs.includes('--no-llm')) ? undefined : buildRepairClient,
    });
    console.log(`[rescue-sweep] scanned=${result.scanned} salvaged=${result.salvaged.length} dead=${result.deadCount} falseKillRate=${(result.falseKillRate * 100).toFixed(0)}% skipped=${result.skipped}${result.stagedLessonIds.length ? ` staged=[${result.stagedLessonIds.join(',')}]` : ''}`);
    for (const s of result.salvaged) {
      console.log(`[rescue-sweep]   ${s.id} ${s.domain} ${s.classification} @ ${s.stage}`);
    }
    return;
  }
  const target = cmdArgs.find(arg => !arg.startsWith('--')) ?? '.omx/atelier/rejects/code';
  const noLlm = cmdArgs.includes('--no-llm');
  if (!existsSync(target)) {
    console.error(`usage: sinter rescue <rejects-dir|file> [--no-llm] — no such path: ${target}`);
    process.exit(1);
  }

  const report = await rescuePool(target, { noLlm, buildRepairClient: noLlm ? undefined : buildRepairClient });
  const reportPath = writeRescueArtifacts(report);

  for (const outcome of report.outcomes) {
    const note = outcome.classification === 'genuinely-dead' || outcome.classification === 'no-code'
      ? ` — ${outcome.classification === 'no-code' ? 'empty' : (outcome.errors ?? []).slice(0, 2).join(' | ').slice(0, 140)}`
      : ` — saved at ${outcome.stage}`;
    console.log(`${outcome.file.padEnd(14)} ${outcome.domain.padEnd(8)} ${outcome.classification.padEnd(15)}${note}`);
  }

  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  console.log(`\npool=${report.total}  false-kill=${report.counts['false-kill']}  recovered=${report.counts['recovered']}  llm-salvage=${report.counts['llm-salvage']}  dead=${report.counts['genuinely-dead']}  no-code=${report.counts['no-code']}`);
  console.log(`FALSE-KILL RATE (salvageable share of rejects): ${pct(report.falseKillRate)} — genuinely-dead share ${pct((report.counts['genuinely-dead'] + report.counts['no-code']) / Math.max(1, report.total))}`);
  if (report.repairPatterns.length > 0) {
    console.log('\nRecurring repair patterns (candidate system lessons — promote via the staging gate):');
    for (const pattern of report.repairPatterns) console.log(`  ${String(pattern.count).padStart(3)}x  ${pattern.pattern}`);
  }
  console.log(`\nsalvaged code + full report: ${reportPath}`);
}
