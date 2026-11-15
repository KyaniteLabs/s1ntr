#!/usr/bin/env node
/**
 * Wave 4 close / pre-done fail-closed gate.
 *
 * Blocks "programComplete" theater unless:
 *  - freeze.wave4 seats present
 *  - INTENT + full-pipeline spec present
 *  - Sol adversarial review present (enforce mode: APPROVE or ITERATE with amends note)
 *  - live full-pipeline receipt with livePass + non-empty artifact (or --allow-dry for structure-only)
 *
 * Usage:
 *   node scripts/rotation/wave4-close-gate.mjs
 *   node scripts/rotation/wave4-close-gate.mjs --enforce-sol
 *   node scripts/rotation/wave4-close-gate.mjs --pipeline-dir PATH
 *   node scripts/rotation/wave4-close-gate.mjs --allow-dry   # structure dry-run only (never for programComplete)
 *   node scripts/rotation/wave4-close-gate.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const REQUIRED_PATHS = [
  'docs/agents/waves/wave-4-INTENT.md',
  'docs/agents/waves/wave-4-full-pipeline-dogfood.md',
  'docs/agents/waves/wave-4-seat-briefs.md',
  'docs/agents/waves/wave-4-seat-map.md',
  'docs/agents/waves/wave-4-ready.json',
  'scripts/rotation/wave4-full-pipeline-dogfood.mjs',
];

const SOL_REVIEW = 'docs/agents/waves/wave-4-SOL-adversarial-review.md';
const FREEZE = 'docs/agents/waves/tour-seat-live-freeze.json';

function parseArgs(argv) {
  const out = {
    enforceSol: false,
    allowDry: false,
    pipelineDir: null,
    json: false,
    updateReady: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--enforce-sol') out.enforceSol = true;
    else if (a === '--allow-dry') out.allowDry = true;
    else if (a === '--pipeline-dir' && argv[i + 1]) out.pipelineDir = String(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--update-ready') out.updateReady = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/rotation/wave4-close-gate.mjs [--enforce-sol] [--allow-dry] [--pipeline-dir PATH] [--update-ready] [--json]`);
      process.exit(0);
    }
  }
  return out;
}

function gitTip() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}

function probe(id, severity, fn) {
  try {
    const detail = fn() || 'ok';
    return { id, severity, ok: true, detail: String(detail) };
  } catch (err) {
    return { id, severity, ok: false, detail: String(err.message || err) };
  }
}

/**
 * Prefer a live livePass receipt over newest mtime (dry-runs must not eclipse canaries).
 */
function findLatestPipelineDir() {
  const root = path.join(REPO, '.quality', 'tour', 'wave-4');
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('full-pipeline-'))
    .map((d) => {
      const dir = path.join(root, d.name);
      const receiptPath = path.join(dir, 'pipeline-receipt.json');
      let live = false;
      let livePass = false;
      let mtime = fs.statSync(dir).mtimeMs;
      try {
        if (fs.existsSync(receiptPath)) {
          const r = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
          live = Boolean(r.live);
          livePass = Boolean(r.livePass);
          mtime = Math.max(mtime, fs.statSync(receiptPath).mtimeMs);
        }
      } catch {
        /* ignore corrupt receipt */
      }
      return { name: d.name, dir, mtime, live, livePass };
    });
  if (!dirs.length) return null;
  // rank: livePass first, then live, then mtime
  dirs.sort((a, b) => {
    if (a.livePass !== b.livePass) return a.livePass ? -1 : 1;
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.mtime - a.mtime;
  });
  return dirs[0].dir;
}

function parseSolVerdict(text) {
  const m = String(text).match(/\*\*Verdict:\*\*\s*\*?\*?(APPROVE|ITERATE|REJECT)/i)
    || String(text).match(/Verdict:\s*\*?\*?(APPROVE|ITERATE|REJECT)/i)
    || String(text).match(/\b(APPROVE|ITERATE|REJECT)\b/);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

export function runWave4CloseGate(opts = {}) {
  const args = { enforceSol: false, allowDry: false, pipelineDir: null, ...opts };
  const head = gitTip();
  const probes = [];

  probes.push(
    probe('docs_present', 'hard', () => {
      const missing = REQUIRED_PATHS.filter((p) => !fs.existsSync(path.join(REPO, p)));
      if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
      return `n=${REQUIRED_PATHS.length}`;
    }),
  );

  probes.push(
    probe('freeze_wave4', 'hard', () => {
      const freeze = JSON.parse(fs.readFileSync(path.join(REPO, FREEZE), 'utf8'));
      const w = freeze.wave4;
      if (!w?.harness || !w?.generator || !w?.evaluator || !w?.chat) {
        throw new Error('freeze.wave4 incomplete');
      }
      if (w.harness !== 'Sol' || w.generator !== 'K3' || w.evaluator !== 'Grok' || w.chat !== 'GLM') {
        throw new Error(
          `unexpected roster harness=${w.harness} gen=${w.generator} eval=${w.evaluator} chat=${w.chat}`,
        );
      }
      if (!w.solKimiRotation?.policy) throw new Error('solKimiRotation policy missing');
      return 'Sol/K3/Grok/GLM + rotation policy';
    }),
  );

  probes.push(
    probe('sol_adversarial_receipt', args.enforceSol ? 'hard' : 'soft', () => {
      const p = path.join(REPO, SOL_REVIEW);
      if (!fs.existsSync(p)) throw new Error(`missing ${SOL_REVIEW}`);
      const body = fs.readFileSync(p, 'utf8');
      if (body.trim().length < 200) throw new Error('sol review too short');
      const verdict = parseSolVerdict(body);
      if (args.enforceSol && verdict === 'REJECT') throw new Error('Sol REJECT blocks spend/close');
      if (args.enforceSol && verdict === 'UNKNOWN') throw new Error('Sol verdict unparseable');
      return `present verdict=${verdict}`;
    }),
  );

  const pipelineDir = args.pipelineDir || findLatestPipelineDir();
  probes.push(
    probe('full_pipeline_receipt', 'hard', () => {
      if (!pipelineDir) throw new Error('no full-pipeline-* dir under .quality/tour/wave-4');
      const receiptPath = path.join(pipelineDir, 'pipeline-receipt.json');
      const finalPath = path.join(pipelineDir, 'FINAL-PRODUCT.md');
      if (!fs.existsSync(receiptPath)) throw new Error(`missing ${receiptPath}`);
      if (!fs.existsSync(finalPath)) throw new Error(`missing FINAL-PRODUCT.md`);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (receipt.schema !== 'sinter-wave4-full-pipeline-v1') {
        throw new Error(`bad schema ${receipt.schema}`);
      }
      if (!args.allowDry) {
        if (!receipt.live) throw new Error('pipeline receipt is not live (dry-run only)');
        if (!receipt.livePass) throw new Error('livePass=false — empty artifact or stage fail');
        const gen = (receipt.stages || []).find((s) => s.id === 'generate');
        if (!gen?.artifactPath) throw new Error('generate stage missing artifactPath');
        if ((gen.artifactBytes || 0) < 40) throw new Error('artifact too small');
        // Model identity: cosplay + observed fingerprints (Sol residual P0-1)
        const id = receipt.modelIdentity;
        if (!id) throw new Error('modelIdentity missing on live receipt');
        if (id.generatorCosplay) throw new Error(`generator cosplay: ${id.generatorCosplay}`);
        if (id.evaluatorCosplay) throw new Error(`evaluator cosplay: ${id.evaluatorCosplay}`);
        if (id.harnessCosplay) throw new Error(`harness cosplay: ${id.harnessCosplay}`);
        if (id.chatCosplay) throw new Error(`chat cosplay: ${id.chatCosplay}`);
        if (!id.generatorObserved || !id.evaluatorObserved || !id.harnessObserved || !id.chatObserved) {
          throw new Error(
            `missing observed identity gen=${id.generatorObserved} eval=${id.evaluatorObserved} harness=${id.harnessObserved} chat=${id.chatObserved}`,
          );
        }
        // Reject synthetic self-written identity theater in calls list
        for (const c of id.calls || []) {
          if (c?.source === 'synthetic' || c?.synthetic === true) {
            throw new Error(`synthetic identity call for ${c.role || 'unknown'}`);
          }
        }
        const ev = (receipt.stages || []).find((s) => s.id === 'evaluate');
        if (!ev?.judgedPipelineArtifact) throw new Error('evaluate stage did not judge pipeline artifact');
        if (!ev?.artifactSha256) throw new Error('evaluate stage missing artifactSha256');
      } else if (!receipt.ok && !receipt.dryPass) {
        throw new Error('dry pipeline not ok');
      }
      return path.relative(REPO, pipelineDir);
    }),
  );

  probes.push(
    probe('anti_theater_intent', 'hard', () => {
      const intent = fs.readFileSync(path.join(REPO, 'docs/agents/waves/wave-4-INTENT.md'), 'utf8');
      if (!/SEQUENTIAL|sequential full pipeline|chat → generate/i.test(intent)) {
        throw new Error('INTENT missing sequential pipeline done bar');
      }
      if (!/Creative outputs required|artifact/i.test(intent)) {
        throw new Error('INTENT missing creative artifact requirement');
      }
      return 'sequential + artifacts in INTENT';
    }),
  );

  const hardFails = probes.filter((p) => !p.ok && p.severity === 'hard');
  const softFails = probes.filter((p) => !p.ok && p.severity === 'soft');
  const ok = hardFails.length === 0;

  const report = {
    schema: 'sinter-wave4-close-gate-v1',
    ts: new Date().toISOString(),
    head,
    ok,
    hardFails: hardFails.map((p) => p.id),
    softFails: softFails.map((p) => p.id),
    pipelineDir: pipelineDir ? path.relative(REPO, pipelineDir) : null,
    probes,
    note: ok
      ? args.allowDry
        ? 'STRUCTURE OK (allow-dry) — not sufficient for programComplete'
        : 'CLOSE GATE GREEN — live pipeline + freeze + docs'
      : 'CLOSE GATE RED — do not claim Wave 4 done',
  };

  if (args.updateReady) {
    const readyPath = path.join(REPO, 'docs/agents/waves/wave-4-ready.json');
    if (fs.existsSync(readyPath)) {
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      ready.closeGate = {
        ok: report.ok,
        at: report.ts,
        head: report.head,
        hardFails: report.hardFails,
        pipelineDir: report.pipelineDir,
        allowDry: Boolean(args.allowDry),
      };
      // Never auto-flip programComplete true from allow-dry
      if (report.ok && !args.allowDry) {
        ready.preSpend = ready.preSpend || {};
        ready.preSpend.fullPipelineLive = true;
        ready.preSpend.closeGate = true;
      }
      if (report.ok && !args.allowDry && ready.solAdversarialReview?.status === 'approved') {
        // still require human for programComplete
        ready.notes = `${ready.notes || ''} | close-gate green @ ${report.ts}`;
      }
      fs.writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
    }
  }

  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = runWave4CloseGate(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  }
  if (!report.ok) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
