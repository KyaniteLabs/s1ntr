#!/usr/bin/env node
/**
 * W1-F03: re-probe operator generate.live with host-per-call logging.
 *
 * Runs a tiny generate and parses stdout for llm:response lines that now
 * include role@host. Disposition:
 *   - generator role must use api.x.ai (or configured Grok host) when pin is Grok
 *   - evaluator role may use K3/Kilo (scoring) — not "cosplay"
 *   - exit/fail of generate itself is product vs routing based on that split
 *
 * Usage:
 *   node scripts/rotation/reprobe-operator-generate.mjs [--dry-parse <log>]
 *   node scripts/rotation/reprobe-operator-generate.mjs --live
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordOperatorInvoke } from './tour-instrumentation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

/** @param {string} text */
export function parseHostPerCallLines(text) {
  const lines = String(text || '').split('\n');
  const calls = [];
  for (const line of lines) {
    // [ts] LLMClient llm:response role@host provider/model Nms ok|err
    const m = line.match(
      /llm:response\s+(\S+?)(?:\s+|\/)(\S+\/\S+|\S+)\s+(\d+)ms\s+(ok|err:[^\n]*)/i,
    );
    if (!m) {
      // looser: role@host provider/model
      const m2 = line.match(
        /llm:response\s+([a-z0-9_-]+)@([a-z0-9._:-]+)\s+([a-z0-9_-]+)\/([^\s]+)\s+(\d+)ms/i,
      );
      if (m2) {
        calls.push({
          role: m2[1],
          host: m2[2],
          provider: m2[3],
          model: m2[4],
          latencyMs: Number(m2[5]),
          raw: line.trim(),
        });
      }
      continue;
    }
    const who = m[1];
    const [provider, ...modelParts] = m[2].split('/');
    const roleHost = who.includes('@') ? who.split('@') : [null, who];
    calls.push({
      role: roleHost[0],
      host: roleHost[1] || null,
      provider,
      model: modelParts.join('/') || m[2],
      latencyMs: Number(m[3]),
      status: m[4],
      raw: line.trim(),
    });
  }
  return calls;
}

/**
 * Analyze calls: generator must not be on Kilo when pin is Grok/direct xAI.
 * @param {Array<{role?: string|null, host?: string|null, provider?: string, model?: string}>} calls
 * @param {{ expectedGenHost?: string }} [opts]
 */
export function analyzeGenerateHostCalls(calls, opts = {}) {
  const expectedGenHost = opts.expectedGenHost || 'api.x.ai';
  const untagged = calls.filter((c) => !c.role);
  const gen = calls.filter((c) => c.role === 'generator');
  const evals = calls.filter((c) => c.role === 'evaluator');
  const genOnKilo = gen.filter(
    (c) =>
      String(c.host || '').includes('kilo')
      || String(c.provider || '').includes('kilo')
      || String(c.model || '').includes('kimi-k3'),
  );
  const genOnExpected = gen.filter((c) => String(c.host || '').includes(expectedGenHost));
  let disposition = 'unknown';
  let detail = '';
  if (untagged.length > 0 && gen.length === 0) {
    disposition = 'instrument-ambiguous';
    detail =
      'Untagged llm:response lines (pre host-per-call) — cannot prove generator vs evaluator; re-run with role@host build';
  } else if (gen.length === 0 && evals.length > 0) {
    disposition = 'instrument-ambiguous';
    detail =
      'Only evaluator-role llm:response lines seen — not generator cosplay; re-run with host-per-call if gen missing';
  } else if (genOnKilo.length > 0) {
    disposition = 'product-routing';
    detail = `generator role hit Kilo/K3 host(s): ${genOnKilo.map((c) => c.host || c.model).join(', ')}`;
  } else if (genOnExpected.length > 0) {
    disposition = 'routing-ok-product-or-syntax';
    detail = `generator host ok (${expectedGenHost}); fail is product/syntax not silent K3 pin`;
  } else if (gen.length === 0) {
    disposition = 'instrument-ambiguous';
    detail = 'no generator-tagged calls parsed';
  } else {
    disposition = 'product-routing';
    detail = `generator hosts unexpected: ${gen.map((c) => c.host).join(', ')}`;
  }
  return {
    disposition,
    detail,
    generatorCalls: gen.length,
    evaluatorCalls: evals.length,
    untaggedCalls: untagged.length,
    genOnKilo: genOnKilo.length,
    genOnExpected: genOnExpected.length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryIdx = args.indexOf('--dry-parse');
  if (dryIdx >= 0) {
    const p = args[dryIdx + 1];
    const text = fs.readFileSync(p, 'utf8');
    const calls = parseHostPerCallLines(text);
    const analysis = analyzeGenerateHostCalls(calls);
    const out = { calls, analysis };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  if (!args.includes('--live')) {
    // Default: re-analyze Wave 1 generate.live.log if present
    // Worktrees may not have .quality — also try main checkout sibling.
    const candidates = [
      path.join(repoRoot, '.quality/tour/wave-1/operator/generate.live.log'),
      // worktree → main checkout (.quality is gitignored, often only on primary tree)
      path.join(repoRoot, '../../../.quality/tour/wave-1/operator/generate.live.log'),
      path.join(process.cwd(), '.quality/tour/wave-1/operator/generate.live.log'),
    ];
    const legacy = candidates.map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
    if (legacy) {
      const text = fs.readFileSync(legacy, 'utf8');
      const calls = parseHostPerCallLines(text);
      const analysis = analyzeGenerateHostCalls(calls);
      // Wave-1 log predates role@host — treat as instrument-ambiguous + note K3 lines
      const k3Lines = (text.match(/kilo\/moonshotai\/kimi-k3/g) || []).length;
      const resolvedGrok = /Resolved provider:.*api\.x\.ai.*grok/i.test(text);
      const result = {
        source: legacy,
        schema: 'sinter-f03-reprobe-v1',
        resolvedGrokBanner: resolvedGrok,
        k3ResponseLines: k3Lines,
        calls,
        analysis: {
          ...analysis,
          disposition:
            resolvedGrok && k3Lines > 0 && calls.every((c) => !c.role)
              ? 'instrument-ambiguous-legacy'
              : analysis.disposition,
          detail:
            resolvedGrok && k3Lines > 0 && calls.every((c) => !c.role)
              ? 'CLI banner Grok/xAI but untagged llm:response lines show K3 — likely evaluator scoring, not proven generator cosplay. Re-run --live after host-per-call land.'
              : analysis.detail,
        },
        recommendation:
          'Ship LLM_RESPONSE role+endpointHost (this PR). Re-run --live to close F03. Harness H1/H2 remain product backlog.',
      };
      const outPath = path.join(repoRoot, '.quality/tour/wave-1/operator/f03-reprobe.json');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
      try {
        recordOperatorInvoke({
          commandClass: 'generate.live.reprobe',
          exitCode: 0,
          durationMs: 0,
          detail: result.analysis.disposition,
          wave: 1,
          seat: 'generator',
        });
      } catch {
        /* ignore */
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    console.error('usage: reprobe-operator-generate.mjs --dry-parse <log> | --live | (default: wave-1 log)');
    process.exit(2);
  }

  // Live re-probe (paid) — short prompt
  const start = Date.now();
  const bin = path.join(repoRoot, 'bin/sinter');
  const r = spawnSync(
    process.execPath,
    [bin, '-p', 'tiny blue circle p5 sketch for f03 reprobe', '--domain', 'p5', '--max-iterations', '1'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 240_000,
      env: process.env,
    },
  );
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const calls = parseHostPerCallLines(text);
  const analysis = analyzeGenerateHostCalls(calls);
  const outDir = path.join(repoRoot, '.quality/tour/f03-reprobe');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `${stamp}.log`), text);
  const result = {
    schema: 'sinter-f03-reprobe-v1',
    ts: new Date().toISOString(),
    exitCode: r.status,
    durationMs: Date.now() - start,
    calls,
    analysis,
  };
  fs.writeFileSync(path.join(outDir, `${stamp}.json`), `${JSON.stringify(result, null, 2)}\n`);
  try {
    recordOperatorInvoke({
      commandClass: 'generate.live.reprobe',
      exitCode: r.status ?? 1,
      durationMs: Date.now() - start,
      detail: analysis.disposition,
      wave: 2,
      seat: 'generator',
    });
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(r.status === 0 ? 0 : 1);
}

const isCli =
  process.argv[1]
  && path.resolve(process.argv[1]).endsWith('reprobe-operator-generate.mjs');
if (isCli) main();
