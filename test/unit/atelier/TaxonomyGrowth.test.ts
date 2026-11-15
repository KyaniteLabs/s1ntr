import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNameLog,
  buildTaxonomy,
  growTaxonomy,
  writeTaxonomy,
  formatTaxonomyReport,
  TAXONOMY_PATH,
  tokenize,
  stem,
} from '../../../src/atelier/TaxonomyGrowth.js';
import type { PlateEntry } from '../../../src/atelier/NamingOrgan.js';

const SYNTHETIC_LOG = [
  'Unknown option: --move',
  '[config] file-pinned seats take precedence',
  '[name] best strudel -> "Luminous Flow" · silk "STRUDEL · CRAFT 6.0 · RECEIPTS" · luminous layered lamination',
  '[name] best strudel -> "Luminarch" · silk "STRUDEL · CRAFT 4.0 · RECEIPTS" · monarch of layers',
  '[name] best p5 -> "Flowstate" · silk "P5 · CRAFT 3.7 · RECEIPTS" · flows of form',
  '[name] move threexglsl -> "TernionGL" · silk "THREE x GLSL · ISO 0.997" · a set of three',
  '[name] nothing to name',
  '[name] thread confirmation: SEMANTIC (16 threads, 1 tensions)',
  '',
].join('\n');

const SYNTHETIC_PLATES: PlateEntry[] = [
  // accepted (in the log)
  plate('best:strudel', 'best', 'strudel', 'Luminous Flow', 'luminous layered lamination'),
  plate('best:p5', 'best', 'p5', 'Flowstate', 'flows of form'),
  plate('move:threexglsl', 'move', 'threexglsl', 'TernionGL', 'a set of three', 'three'),
  // store-only: coined before the log existed
  plate('best:glsl', 'best', 'glsl', 'Fragmint', 'fragment mint shader'),
];

function plate(key: string, kind: 'best' | 'move', domain: string, name: string, subtitle: string, primaryDomain?: string): PlateEntry {
  return {
    key, kind, domain,
    plate: { name, subtitle, silk: 'X', discipline_pass: true },
    at: '2026-08-30T00:00:00.000Z',
    ...(primaryDomain ? { primary_domain: primaryDomain } : {}),
  } as PlateEntry;
}

function seedSubstrate(cwd: string, log: string, plates: PlateEntry[], beads: Array<{ domain: string }>): void {
  mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
  mkdirSync(join(cwd, '.omx', 'atelier', 'game'), { recursive: true });
  writeFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'game.log'), log);
  writeFileSync(join(cwd, '.omx', 'atelier', 'game', 'plates.json'), JSON.stringify(plates));
  writeFileSync(join(cwd, '.omx', 'atelier', 'game', 'beads.json'), JSON.stringify(beads));
}

describe('TaxonomyGrowth organ', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sinter-taxonomy-test-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('parses naming lines and ignores every other log line', () => {
    const events = parseNameLog(SYNTHETIC_LOG);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'best', rawDomain: 'strudel', name: 'Luminous Flow' });
    expect(events[3]).toMatchObject({ kind: 'move', rawDomain: 'threexglsl', name: 'TernionGL' });
    expect(events[3].domains).toEqual(['three', 'glsl']); // move combo attributes to BOTH domains
  });

  it('tokenizes with camelCase split + accent strip, stems plurals', () => {
    expect(tokenize('TernionGL')).toEqual(['ternion']); // 'gl' is under the 3-char floor
    expect(tokenize('Polycéphale')).toEqual(['polycephale']);
    expect(stem('flows')).toBe('flow');
    expect(stem('layers')).toBe('layer');
  });

  it('computes coined-vs-accepted per domain and store-only plates', () => {
    const taxonomy = buildTaxonomy({ log: SYNTHETIC_LOG, plates: SYNTHETIC_PLATES, beads: [{ domain: 'strudel' }, { domain: 'strudel' }, { domain: 'p5' }] });
    expect(taxonomy.totals).toEqual({ coined: 5, accepted: 4, store: 4, beads: 3, domains: 4 });

    const strudel = taxonomy.domains.strudel;
    expect(strudel.coined).toBe(2);
    expect(strudel.accepted).toBe(1); // Luminarch was coined but never plated
    expect(strudel.acceptanceRate).toBeCloseTo(0.5, 5);
    expect(strudel.beads).toBe(2);
    expect(strudel.names).toEqual(['Luminarch', 'Luminous Flow']); // sorted

    // move domains each get credit for the coined name
    expect(taxonomy.domains.three.coined).toBe(1);
    expect(taxonomy.domains.three.store).toBe(1); // move plate attributed via primary_domain
    expect(taxonomy.domains.glsl.coined).toBe(1);
    expect(taxonomy.domains.glsl.accepted).toBe(1); // TernionGL lives in the store (name match)
    expect(taxonomy.domains.glsl.styleAxes).toHaveLength(0); // axes only from OWN accepted plates
  });

  it('clusters known accepted names by stem and prefix overlap', () => {
    const taxonomy = buildTaxonomy({ log: SYNTHETIC_LOG, plates: SYNTHETIC_PLATES, beads: [] });
    const strudel = taxonomy.domains.strudel;
    // accepted names: only "Luminous Flow" — one token each after stopwords
    expect(strudel.clusters.map(c => c.label)).toEqual(['flow', 'luminous']);

    // with both luminous names accepted, prefix >= 4 merges them into one cluster
    const bothAccepted = buildTaxonomy({
      log: SYNTHETIC_LOG,
      plates: [...SYNTHETIC_PLATES, plate('best:strudel-2', 'best', 'strudel', 'Luminarch', 'monarch of layers')],
      beads: [],
    });
    const merged = bothAccepted.domains.strudel.clusters;
    expect(merged).toHaveLength(2);
    const luminous = merged.find(c => c.members.includes('luminous'))!;
    expect(luminous.members).toEqual(['luminarch', 'luminous']);
    expect(luminous.count).toBe(2);
  });

  it('derives frequency-weighted style axes from ACCEPTED plates only', () => {
    const taxonomy = buildTaxonomy({ log: SYNTHETIC_LOG, plates: SYNTHETIC_PLATES, beads: [] });
    const strudel = taxonomy.domains.strudel;
    expect(strudel.styleAxes[0]).toEqual({ tag: 'luminous', kind: 'adjective', weight: 4 }); // name x3 + subtitle x1
    expect(strudel.styleAxes.map(a => a.tag)).not.toContain('monarch'); // from the UNACCEPTED name's subtitle
    const weights = strudel.styleAxes.map(a => a.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights); // sorted by weight desc
  });

  it('grows from disk, writes deterministic JSON, and formats a report', () => {
    seedSubstrate(cwd, SYNTHETIC_LOG, SYNTHETIC_PLATES, [{ domain: 'strudel' }]);
    const first = growTaxonomy(cwd);
    const path = writeTaxonomy(cwd, first);
    expect(path).toBe(TAXONOMY_PATH(cwd));
    const written = readFileSync(path, 'utf8');

    // deterministic: re-run byte-for-byte identical (no timestamps)
    const second = growTaxonomy(cwd);
    expect(JSON.stringify(second, null, 1)).toBe(written.trimEnd());
    expect(Object.keys(second.domains)).toEqual([...Object.keys(second.domains)].sort());

    expect(existsSync(join(cwd, '.omx', 'atelier', 'game', 'taxonomy.json'))).toBe(true);
    const report = formatTaxonomyReport(first);
    expect(report).toContain('[taxonomy] 4 domains');
    expect(report).toContain('strudel: coined 2, accepted 1 (50%)');
  });

  it('tolerates an empty substrate without crashing', () => {
    const empty = growTaxonomy(cwd);
    expect(empty.totals).toEqual({ coined: 0, accepted: 0, store: 0, beads: 0, domains: 0 });
    expect(formatTaxonomyReport(empty)).toContain('coined 0');
  });
});
