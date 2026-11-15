import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Great Rewiring S1 (2026-08-31): the learner's arm-swap propagated EMPTY
// hints into hints-active.json (2 of 5 fleet machines lost their genomes),
// the bandit credited outcomes from a days-old /tmp/genome-backup.json, and
// nothing refused empty/stale/corrupt restores. These tests pin the guard
// contract in scripts/atelier/genome_guard.py and the credit-the-live-genome
// resolution in scripts/atelier/bandit_bridge.py.
const GUARD = path.join(process.cwd(), 'scripts', 'atelier', 'genome_guard.py');
const BRIDGE = path.join(process.cwd(), 'scripts', 'atelier', 'bandit_bridge.py');
const HOLD = 'genome empty — holding swap';
const HOUR = 3600 * 1000;

const GENOME = [
  { id: 'lesson-1', domains: ['three'] },
  { id: 'lesson-2', domains: ['all'] },
];

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genome-guard-'));
}

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('python3', [GUARD, ...args], { encoding: 'utf8' });
}

function seed(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

function ageFile(file: string, hours: number): void {
  const t = new Date(Date.now() - hours * HOUR);
  fs.utimesSync(file, t, t);
}

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('genome_guard backup (defect a: emptiness must never overwrite backups)', () => {
  it('refuses an empty source (exit 3), holds, and preserves the last-good backup', () => {
    const dir = tmp();
    const hints = path.join(dir, 'hints.json');
    const backups = path.join(dir, 'genome-backups');
    const copyTo = path.join(dir, 'tmp-copy.json');
    seed(hints, []);
    seed(copyTo, GENOME); // legacy /tmp copy still holds the last good genome
    fs.mkdirSync(backups);
    const lastGood = path.join(backups, 'host-20260830T000000Z.json');
    seed(lastGood, GENOME);
    const before = fs.readFileSync(lastGood);

    const r = run(['backup', '--hints', hints, '--backup-dir', backups, '--copy-to', copyTo]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(HOLD);
    expect(fs.readFileSync(lastGood)).toEqual(before); // backup untouched
    expect(JSON.parse(fs.readFileSync(copyTo, 'utf8'))).toEqual(GENOME); // no empty refresh
  });

  it('writes a checksummed per-machine backup with sidecar and refreshes the copy', () => {
    const dir = tmp();
    const hints = path.join(dir, 'hints.json');
    const backups = path.join(dir, 'genome-backups');
    const copyTo = path.join(dir, 'genome-backup-main.json');
    seed(hints, GENOME);

    const r = run(['backup', '--hints', hints, '--backup-dir', backups,
      '--host', 'mach-one', '--copy-to', copyTo]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('backup ok');
    const files = fs.readdirSync(backups).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^mach-one-\d{8}T\d{6}Z\.json$/);
    const backup = path.join(backups, files[0]);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(GENOME);
    const sidecar = fs.readFileSync(backup + '.sha256', 'utf8');
    expect(sidecar).toContain(sha(backup));
    expect(sha(copyTo)).toBe(sha(backup)); // legacy /tmp copy refreshed this wave
    expect(fs.existsSync(copyTo + '.sha256')).toBe(true);
  });
});

describe('genome_guard check (defect c: empty / stale / corrupt must be refused)', () => {
  it('passes a healthy file', () => {
    const dir = tmp();
    const f = path.join(dir, 'hints.json');
    seed(f, GENOME);
    const r = run(['check', '--file', f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check ok');
  });

  it('refuses empty list, empty object, missing, and unparseable files (exit 3)', () => {
    const dir = tmp();
    for (const content of ['[]', '{}', 'not json {{{']) {
      const f = path.join(dir, 'bad.json');
      fs.writeFileSync(f, content);
      const r = run(['check', '--file', f]);
      expect(r.status).toBe(3);
      expect(r.stdout).toContain(HOLD);
    }
    const r = run(['check', '--file', path.join(dir, 'missing.json')]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(HOLD);
  });

  it('refuses a file older than the freshness window (exit 5)', () => {
    const dir = tmp();
    const f = path.join(dir, 'hints.json');
    seed(f, GENOME);
    ageFile(f, 25);
    const r = run(['check', '--file', f, '--max-age-hours', '24']);
    expect(r.status).toBe(5);
    expect(r.stdout).toContain('stale');
    // the age limit is a flag, not a constant: inside the window it passes
    const ok = run(['check', '--file', f, '--max-age-hours', '48']);
    expect(ok.status).toBe(0);
  });

  it('refuses a checksum sidecar mismatch (exit 6) and accepts a matching one', () => {
    const dir = tmp();
    const f = path.join(dir, 'hints.json');
    seed(f, GENOME);
    fs.writeFileSync(f + '.sha256', `${'0'.repeat(64)}  hints.json\n`);
    const bad = run(['check', '--file', f]);
    expect(bad.status).toBe(6);
    expect(bad.stdout).toContain('checksum mismatch');

    fs.writeFileSync(f + '.sha256', `${sha(f)}  hints.json\n`);
    const good = run(['check', '--file', f]);
    expect(good.status).toBe(0);
  });
});

describe('genome_guard promote (defect a: the staged-arm swap)', () => {
  it('refuses to promote an empty genome over the active genome', () => {
    const dir = tmp();
    const src = path.join(dir, 'hints.json');
    const dest = path.join(dir, 'hints-active.json');
    fs.writeFileSync(src, '[]');
    seed(dest, GENOME);
    const before = fs.readFileSync(dest);

    const r = run(['promote', '--src', src, '--dest', dest]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(HOLD);
    expect(fs.readFileSync(dest)).toEqual(before); // active genome preserved
  });

  it('atomically promotes a healthy genome (dest == src after restore-test)', () => {
    const dir = tmp();
    const src = path.join(dir, 'hints-staging.json');
    const dest = path.join(dir, 'hints.json');
    seed(src, GENOME);
    fs.writeFileSync(dest, '[]');

    const r = run(['promote', '--src', src, '--dest', dest]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('restore-test passed');
    expect(JSON.parse(fs.readFileSync(dest, 'utf8'))).toEqual(GENOME);
    // atomic write leaves no temp droppings behind
    expect(fs.readdirSync(dir).filter(f => f.startsWith('.genome-'))).toEqual([]);
  });
});

describe('genome_guard restore (defect c: guards + fallback + hold)', () => {
  it('restores a fresh, checksummed source over the destination', () => {
    const dir = tmp();
    const src = path.join(dir, 'genome-backup-main.json');
    const dest = path.join(dir, 'hints.json');
    seed(src, GENOME);
    seed(dest, []);
    fs.writeFileSync(src + '.sha256', `${sha(src)}  ${path.basename(src)}\n`);

    const r = run(['restore', '--src', src, '--dest', dest]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('restore ok');
    expect(r.stdout).toContain('restore-test passed');
    expect(JSON.parse(fs.readFileSync(dest, 'utf8'))).toEqual(GENOME);
  });

  it('falls back to the freshest viable per-machine backup when the source is stale', () => {
    const dir = tmp();
    const src = path.join(dir, 'genome-backup-main.json');
    const dest = path.join(dir, 'hints.json');
    const backups = path.join(dir, 'genome-backups');
    seed(src, GENOME);
    ageFile(src, 30); // older than 24h — not viable
    seed(dest, []);
    const freshBackup = path.join(backups, 'mach-one-20260831T000000Z.json');
    const fresher = [{ id: 'lesson-9', domains: ['all'] }];
    seed(freshBackup, fresher);

    const r = run(['restore', '--src', src, '--dest', dest, '--fallback-dir', backups]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(freshBackup); // cites the fallback it used
    expect(JSON.parse(fs.readFileSync(dest, 'utf8'))).toEqual(fresher);
  });

  it('holds (exit 4) when source AND every backup are empty or stale — no propagation', () => {
    const dir = tmp();
    const src = path.join(dir, 'genome-backup-main.json');
    const dest = path.join(dir, 'hints.json');
    const backups = path.join(dir, 'genome-backups');
    fs.writeFileSync(src, '[]'); // the wiped-machine signature
    seed(dest, [{ id: 'lesson-keep' }]);
    const before = fs.readFileSync(dest);
    const staleButGood = path.join(backups, 'mach-one-20260801T000000Z.json');
    seed(staleButGood, GENOME);
    ageFile(staleButGood, 72);
    const emptyBackup = path.join(backups, 'mach-one-20260831T000000Z.json');
    seed(emptyBackup, []); // fresh but empty — must NOT be chosen

    const r = run(['restore', '--src', src, '--dest', dest, '--fallback-dir', backups]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain(HOLD);
    expect(fs.readFileSync(dest)).toEqual(before); // destination untouched
  });
});

describe('bandit_bridge credit-the-live-genome (defect b)', () => {
  it('no longer reads the stale un-suffixed /tmp/genome-backup.json', () => {
    const src = fs.readFileSync(BRIDGE, 'utf8');
    // the old credit path opened the un-suffixed file directly; only a
    // historical mention in the docstring may remain
    expect(src).not.toContain("open('/tmp/genome-backup.json')");
    expect(src).toContain('resolve_genome');
  });

  function resolveWith(explicit: string | null, active: unknown, backups: Record<string, unknown>): { path: string | null; n: number } {
    const dir = tmp();
    const activePath = path.join(dir, 'hints-active.json');
    const backupsDir = path.join(dir, 'genome-backups');
    if (active !== null) seed(activePath, active);
    for (const [name, data] of Object.entries(backups)) seed(path.join(backupsDir, name), data);
    for (const stale of [activePath, ...Object.keys(backups).map(n => path.join(backupsDir, n))]) {
      if (fs.existsSync(stale) && path.basename(stale).includes('OLD')) ageFile(stale, 72);
    }
    if (explicit) ageFile(explicit, 72); // an explicit but stale /tmp file
    const py = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(BRIDGE))})`,
      'import bandit_bridge',
      'genome, src = bandit_bridge.resolve_genome(' +
        `${explicit === null ? 'None' : JSON.stringify(explicit)}, ` +
        `active_path=${JSON.stringify(activePath)}, ` +
        `backups_dir=${JSON.stringify(backupsDir)})`,
      'print(json.dumps({"path": src, "n": len(genome)}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout);
  }

  it('prefers the fresh live genome over a stale explicit /tmp path, and cites it', () => {
    const dir = tmp();
    const explicit = path.join(dir, 'genome-backup-main.json');
    seed(explicit, GENOME); // exists but will be aged 72h by resolveWith
    const got = resolveWith(explicit, GENOME, {});
    expect(got.path).not.toBe(explicit); // stale /tmp file is never credited
    expect(got.path).toContain('hints-active.json');
    expect(got.n).toBe(2);
  });

  it('falls back to the newest viable backup and returns nothing when all are empty', () => {
    const newer = [{ id: 'lesson-new' }];
    const got = resolveWith(null, [], { 'mach-one-NEW.json': newer, 'mach-one-OLD.json': GENOME });
    expect(got.path).toContain('mach-one-NEW.json');
    expect(got.n).toBe(1);

    const none = resolveWith(null, [], { 'mach-one-NEW.json': [] });
    expect(none.path).toBeNull();
    expect(none.n).toBe(0);
  });
});
