#!/usr/bin/env node
/**
 * beauty-v1 battery instrument (UMD-V2 B1)
 * Dual columns: technical vs beauty. Mock mode only by default.
 */
import fs from 'node:fs';
import path from 'node:path';

const DOMAINS = ['hydra', 'ascii', 'kinetic', 'textgen'];

/** Letterbox heuristic: near-black majority → technical may pass but beauty fails */
export function technicalFromFixture(domain, fixture = {}) {
  if (fixture.renderFailed) return { result: 'fail', failureClass: 'render-failed' };
  if (fixture.empty) return { result: 'fail', failureClass: 'EMPTY-ARTIFACT' };
  return { result: 'pass', failureClass: null };
}

export function beautyFromFixture(domain, fixture = {}) {
  if (fixture.letterbox) {
    return { verdict: 'reject', defectClass: 'BEAUTY-LETTERBOX', notes: 'majority frame black / letterbox' };
  }
  if (fixture.sparse) {
    return { verdict: 'reject', defectClass: 'BEAUTY-SPARSE', notes: 'compositionally sparse' };
  }
  if (fixture.hold) {
    return { verdict: 'hold', defectClass: null, notes: 'weak but salvageable' };
  }
  if (fixture.accept) {
    return { verdict: 'accept', defectClass: null, notes: 'fixture accept' };
  }
  return { verdict: 'unscored', defectClass: null, notes: 'no beauty judge' };
}

export function runMockBeautyBattery(commitSha = 'mock') {
  const fixtures = {
    hydra: { letterbox: true },
    ascii: { sparse: true },
    kinetic: { hold: true },
    textgen: { sparse: true },
  };
  const receipts = DOMAINS.map((domain) => {
    const f = fixtures[domain] || {};
    const technical = technicalFromFixture(domain, f);
    const beauty = beautyFromFixture(domain, f);
    return {
      schema: 'sinter-beauty-receipt-v1',
      commitSha,
      batteryId: 'beauty-v1',
      batteryVersion: 1,
      domain,
      model: 'mock',
      provider: 'mock',
      promptId: `beauty-${domain}-mock`,
      promptTextHash: 'mock',
      viewport: { width: 1280, height: 800 },
      waitMs: 4000,
      renderPath: `fixtures/beauty/${domain}.png`,
      technical,
      beauty: { ...beauty, judge: 'fixture' },
      issueRefs: [],
      waveId: 'V2-B1',
      createdAt: new Date().toISOString(),
    };
  });
  // technical pass ≠ beauty pass for hydra/ascii/textgen
  const falseGreen = receipts.filter((r) => r.technical.result === 'pass' && r.beauty.verdict === 'accept');
  return {
    schema: 'sinter-beauty-battery-summary-v1',
    batteryId: 'beauty-v1',
    mock: true,
    receipts,
    northStar: {
      id: 'beautyPassRateAtFixedProtocol',
      value: receipts.filter((r) => r.technical.result === 'pass' && r.beauty.verdict === 'accept').length / receipts.length,
    },
    ok: true,
    assertsTechnicalNotBeauty: receipts.some(
      (r) => r.technical.result === 'pass' && r.beauty.verdict !== 'accept' && r.beauty.verdict !== 'unscored',
    ),
    falseGreenCount: falseGreen.length,
  };
}

export function main(argv = process.argv.slice(2)) {
  if (!argv.includes('--mock') && !argv.includes('--dry-run')) {
    console.error('beauty-v1: use --mock (live not wired in B1 instrument)');
    process.exit(2);
  }
  const summary = runMockBeautyBattery();
  const outDir = path.join(process.cwd(), '.quality', 'beauty-v1', 'mock');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const r of summary.receipts) {
    fs.writeFileSync(path.join(outDir, `${r.domain}.json`), JSON.stringify(r, null, 2));
  }
  console.log(JSON.stringify({ ok: summary.ok, assertsTechnicalNotBeauty: summary.assertsTechnicalNotBeauty, northStar: summary.northStar, outDir }, null, 2));
  process.exit(summary.ok && summary.assertsTechnicalNotBeauty ? 0 : 1);
}

if (process.argv[1]?.endsWith('beauty-v1.mjs')) main();
