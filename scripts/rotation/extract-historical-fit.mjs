#!/usr/bin/env node
/**
 * H-TELEM-06: Extract domain/eval/harness fit tables from pack archives.
 * Writes markdown to docs/agents/waves/historical-fit-tables.md (or --out).
 *
 * Never promotes INVALID / pre-#531 packs. Marks forensic archives explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

export function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function extractPack(packDir) {
  const summary = loadJson(path.join(packDir, 'summary.json'));
  if (!summary) return null;
  const receiptsDir = path.join(packDir, 'receipts');
  const tasks = [];
  if (fs.existsSync(receiptsDir)) {
    for (const name of fs.readdirSync(receiptsDir)) {
      if (!name.endsWith('.json')) continue;
      if (name.includes('envelope') || name.endsWith('-plan.md')) continue;
      const rec = loadJson(path.join(receiptsDir, name));
      if (!rec || !rec.taskId) continue;
      tasks.push({
        taskId: rec.taskId,
        verdict: rec.verdict,
        domain: rec.extra?.domain ?? null,
        tier: rec.extra?.difficultyTier ?? rec.extra?.tier ?? null,
        label: rec.extra?.label ?? null,
        score: rec.metrics?.score ?? rec.extra?.raw?.score ?? null,
        gateAt1: rec.metrics?.gateAt1 ?? rec.extra?.raw?.gatesAtShot1 ?? null,
        pass: rec.metrics?.pass ?? rec.extra?.raw?.pass ?? null,
        productCandidate: rec.extra?.raw?.productCandidate ?? rec.metrics?.productCandidate ?? null,
        latencyMs: rec.latencyMs ?? null,
      });
    }
  }
  const fj = summary.fixedJudge || null;
  const invalid =
    summary.mode === 'INVALID'
    || (fj && fj.route && fj.route !== 'agy-cliproxy' && (summary.seat === 'generator' || summary.seat === 'chat'));
  return {
    packDir,
    seat: summary.seat,
    model: summary.model,
    mode: summary.mode,
    northStar: summary.northStar?.value ?? summary.metrics?.northStar ?? null,
    northStarId: summary.northStar?.id ?? summary.metrics?.northStarId ?? null,
    join: summary.join || null,
    fixedJudge: fj,
    scorable: !invalid && summary.mode === 'live',
    invalid,
    tasks,
  };
}

export function scanRoots(roots) {
  const packs = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (fs.existsSync(path.join(dir, 'summary.json'))) {
        const p = extractPack(dir);
        if (p) packs.push(p);
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(root);
  }
  return packs;
}

export function renderMarkdown(packs, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [];
  lines.push('# Historical fit tables (telemetry harvest)');
  lines.push('');
  lines.push(`**Generated:** ${generatedAt}`);
  lines.push('**Rule:** Only `mode=live` + valid fixedJudge (gen/chat) are scorable. INVALID / pre-#531 = forensic.');
  lines.push('**Related:** `wave-1-FULL-HARVEST.md`, H-TELEM-06, `scripts/rotation/extract-historical-fit.mjs`.');
  lines.push('');

  const scorable = packs.filter((p) => p.scorable);
  const forensic = packs.filter((p) => !p.scorable);

  lines.push('## Scorable packs');
  lines.push('');
  lines.push('| Pack | Seat | Model | NS | Tasks |');
  lines.push('|------|------|-------|----|-------|');
  for (const p of scorable) {
    const short = p.packDir.replace(REPO + path.sep, '');
    lines.push(
      `| \`${short}\` | ${p.seat} | ${p.model} | ${p.northStar ?? '—'} | ${p.tasks.length} |`,
    );
  }
  if (!scorable.length) lines.push('| _(none found on disk)_ | | | | |');
  lines.push('');

  for (const p of scorable) {
    const short = p.packDir.replace(REPO + path.sep, '');
    lines.push(`### ${p.seat} · ${p.model} (\`${short}\`)`);
    lines.push('');
    if (p.seat === 'generator') {
      lines.push('| Task | Domain | gate@1 | score | latencyMs |');
      lines.push('|------|--------|--------|-------|-----------|');
      for (const t of p.tasks) {
        lines.push(
          `| ${t.taskId} | ${t.domain ?? '—'} | ${t.gateAt1 ?? '—'} | ${t.score ?? '—'} | ${t.latencyMs ?? '—'} |`,
        );
      }
    } else if (p.seat === 'evaluator') {
      lines.push('| Task | label | pass | GT | verdict |');
      lines.push('|------|-------|------|-----|---------|');
      for (const t of p.tasks) {
        lines.push(
          `| ${t.taskId} | ${t.label ?? '—'} | ${t.pass ?? '—'} | — | ${t.verdict ?? '—'} |`,
        );
      }
    } else if (p.seat === 'harness') {
      lines.push('| Task | verdict | productCandidate |');
      lines.push('|------|---------|------------------|');
      for (const t of p.tasks) {
        lines.push(`| ${t.taskId} | ${t.verdict ?? '—'} | ${t.productCandidate ? 'yes' : '—'} |`);
      }
    } else {
      lines.push('| Task | verdict |');
      lines.push('|------|---------|');
      for (const t of p.tasks) {
        lines.push(`| ${t.taskId} | ${t.verdict ?? '—'} |`);
      }
    }
    lines.push('');
  }

  lines.push('## Forensic / non-scorable packs');
  lines.push('');
  lines.push('| Pack | Seat | Mode | Why |');
  lines.push('|------|------|------|-----|');
  for (const p of forensic) {
    const short = p.packDir.replace(REPO + path.sep, '');
    const why = p.invalid
      ? `invalid judge/route ${p.fixedJudge?.route || p.mode}`
      : `mode=${p.mode}`;
    lines.push(`| \`${short}\` | ${p.seat} | ${p.mode} | ${why} |`);
  }
  if (!forensic.length) lines.push('| _(none)_ | | | |');
  lines.push('');
  lines.push('## Canonical Wave 1 scoreboard (authoritative)');
  lines.push('');
  lines.push('See `docs/agents/waves/wave-1-FULL-HARVEST.md` — domain/eval tables SoT after #554.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  let out = path.join(REPO, 'docs/agents/waves/historical-fit-tables.md');
  const roots = [
    path.join(REPO, '.quality', 'tour', 'wave-1'),
    path.join(REPO, '.quality', 'wave2-archives'),
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = path.resolve(args[++i]);
    if (args[i] === '--root' && args[i + 1]) roots.push(path.resolve(args[++i]));
  }
  const packs = scanRoots(roots);
  const md = renderMarkdown(packs);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(JSON.stringify({ out, packCount: packs.length, scorable: packs.filter((p) => p.scorable).length }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('extract-historical-fit.mjs');
if (isMain) main();
