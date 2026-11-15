import { appendFileSync, copyFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-parity-'));
  const teaser = join(root, 'teaser'), artifacts = join(root, 'artifacts'), vendor = join(root, 'vendor');
  for (const dir of [teaser, artifacts, vendor]) mkdirSync(dir);
  for (const name of [script, 'vendor-paths.mjs']) copyFileSync(resolve('teaser', name), join(teaser, name));
  cpSync(resolve('teaser/ab'), join(teaser, 'ab'), { recursive: true });
  for (const name of ['fonts', 'og']) symlinkSync(resolve('teaser', name), join(teaser, name));
  const artifact = join(artifacts, 'work.html'), asset = join(vendor, 'asset.js'), ledger = join(root, 'ledger.jsonl');
  writeFileSync(artifact, '<html><body><svg></svg><script src="/vendor/asset.js?v=1"></script></body></html>');
  writeFileSync(asset, 'first');
  writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg', artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'output', ...args], {
    cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
  });
  return { root, teaser, artifact, asset, ledger, run };
}

it('v2 check detects changed artifact and vendor bytes', () => {
  const f = fixture('build-v2.mjs');
  try {
    expect(f.run().status).toBe(0);
    expect(f.run('--check').status).toBe(0);
    writeFileSync(f.asset, 'second');
    expect(f.run('--check').status).toBe(10);
    expect(f.run().status).toBe(0);
    writeFileSync(f.artifact, '<html><body><svg>changed</svg><script src="/vendor/asset.js?v=1"></script></body></html>');
    expect(f.run('--check').status).toBe(10);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 check detects output-affecting options', () => {
  const f = fixture('build-v2.mjs');
  try {
    expect(f.run().status).toBe(0);
    expect(f.run('--check', '--name', 'Different').status).toBe(10);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 check detects changes to the imported contract implementation', () => {
  const f = fixture('build-v2.mjs');
  try {
    expect(f.run().status).toBe(0);
    appendFileSync(join(f.teaser, 'ab/contracts.mjs'), '\n// changed contract implementation\n');
    expect(f.run('--check').status).toBe(10);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 explicit bed selection overrides a broken lower-priority pointer', () => {
  const f = fixture('build-v2.mjs');
  try {
    const bed = join(f.root, 'artifacts', 'bed.html');
    writeFileSync(bed, '<script>window.__sinterBegin=()=>{};window.__sinterRest=()=>{}</script>');
    mkdirSync(join(f.teaser, 'bed'));
    writeFileSync(join(f.teaser, 'bed/pointer.json'), '{broken');
    const result = f.run('--bed', bed);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.teaser, 'manifest-output.json'), 'utf8'));
    expect(manifest.bed.commission).toEqual({ noted: 'passed via --bed' });
    expect(f.run('--check', '--bed', bed).status).toBe(0);
    writeFileSync(join(f.teaser, 'bed/pointer.json'), '{changed-but-still-ignored');
    expect(f.run('--check', '--bed', bed).status).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 tracks the selected bed path even when two beds have identical bytes', () => {
  const f = fixture('build-v2.mjs');
  try {
    const first = join(f.root, 'artifacts', 'first-bed.html');
    const second = join(f.root, 'artifacts', 'second-bed.html');
    writeFileSync(first, '<script>window.__sinterBegin=()=>{};window.__sinterRest=()=>{}</script>');
    copyFileSync(first, second);
    expect(f.run('--bed', first).status).toBe(0);
    expect(f.run('--check', '--bed', second).status).toBe(10);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 builds and tracks an explicitly supplied audio bed and its vendor dependencies', () => {
  const f = fixture('build-v2.mjs');
  try {
    const bed = join(f.root, 'artifacts', 'bed.html');
    writeFileSync(bed, '<script src="/vendor/asset.js"></script><script>window.__sinterBegin=()=>{};window.__sinterRest=()=>{}</script>');
    const result = f.run('--bed', bed);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.teaser, 'output/bed.html'), 'utf8')).toContain('__sinterBegin');
    expect(f.run('--check', '--bed', bed).status).toBe(0);
    writeFileSync(bed, '<script>window.__sinterBegin=()=>1;window.__sinterRest=()=>{}</script>');
    expect(f.run('--check', '--bed', bed).status).toBe(10);
    expect(f.run().status).toBe(0);
    expect(() => readFileSync(join(f.teaser, 'output/bed.html'))).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 refuses a commissioned bed outside the artifact root', () => {
  const f = fixture('build-v2.mjs');
  try {
    const bed = join(f.root, 'outside.html');
    writeFileSync(bed, '<script>window.__sinterBegin=()=>{};window.__sinterRest=()=>{}</script>');
    const result = f.run('--bed', bed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bed artifact outside');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 reports a broken commissioned bed pointer instead of silently falling back', () => {
  const f = fixture('build-v2.mjs');
  try {
    mkdirSync(join(f.teaser, 'bed'));
    writeFileSync(join(f.teaser, 'bed/pointer.json'), '{broken');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid bed pointer');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it('v2 rejects an explicitly selected bed without the audio control contract', () => {
  const f = fixture('build-v2.mjs');
  try {
    const bed = join(f.root, 'artifacts', 'bed.html');
    writeFileSync(bed, '<html>not an audio bed</html>');
    const result = f.run('--bed', bed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bed artifact lacks');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const script of ['build.mjs', 'build-v2.mjs']) {
  it(`${script} rejects an output hard link before modifying the linked file`, () => {
    const f = fixture(script);
    try {
      const outside = join(f.root, 'outside.html');
      writeFileSync(outside, 'keep original');
      mkdirSync(join(f.teaser, 'output'));
      linkSync(outside, join(f.teaser, 'output/index.html'));
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('keep original');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it(`${script} refuses prototype properties as artifact domains`, () => {
    const f = fixture(script);
    try {
      writeFileSync(f.ledger, JSON.stringify({ event_type: 'artifact_scored',
        domain: 'constructor', artifact: f.artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
      expect(f.run().status).not.toBe(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it(`${script} refuses unknown domains that could escape the public taxonomy`, () => {
    const f = fixture(script);
    try {
      writeFileSync(f.ledger, JSON.stringify({ event_type: 'artifact_scored',
        domain: '../../escape', artifact: f.artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
      expect(f.run().status).not.toBe(0);
      expect(() => readFileSync(join(f.teaser, 'escape.html'))).toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  for (const link of ['w', 'index.html']) {
    it(`${script} does not write through an output ${link} symlink`, () => {
      const f = fixture(script);
      try {
        const outside = join(f.root, 'outside'); mkdirSync(outside);
        const target = link === 'w' ? outside : join(outside, 'index.html');
        if (link !== 'w') writeFileSync(target, 'keep original');
        mkdirSync(join(f.teaser, 'output'));
        symlinkSync(target, join(f.teaser, 'output', link));
        const result = f.run();
        if (link === 'w') {
          expect(() => readFileSync(join(outside, 'line.html'))).toThrow();
        } else {
          expect(result.status).not.toBe(0);
          expect(readFileSync(target, 'utf8')).toBe('keep original');
        }
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }

  it(`${script} keeps the previous output if a vendor dependency is missing`, () => {
    const f = fixture(script);
    try {
      expect(f.run().status).toBe(0);
      const before = readFileSync(join(f.teaser, 'output/w/line.html'), 'utf8');
      writeFileSync(f.artifact, '<html><body><script src="/vendor/missing.js"></script></body></html>');
      expect(f.run().status).not.toBe(0);
      expect(readFileSync(join(f.teaser, 'output/w/line.html'), 'utf8')).toBe(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
