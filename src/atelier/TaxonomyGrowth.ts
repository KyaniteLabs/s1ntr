/**
 * TaxonomyGrowth — the Elixis taxonomy grown from the artifact store
 * (Forgejo #930). The NamingOrgan plates champions; this module reads the
 * plate record and the name log and derives, per domain: coined-vs-accepted
 * name rates, accepted-name lexical clusters (light stemming + prefix
 * overlap — no ML deps), and frequency-weighted style-axis tags.
 *
 * ADDITIVE by doctrine: nothing here replaces a Naming/Elixis input. The
 * NamingOrgan currently has no hints/lexicon input, so the derived taxonomy
 * is written to .omx/atelier/game/taxonomy.json (next to plates.json) and
 * surfaced via `sinter taxonomy`; wiring it into the organ's naming prompts
 * is a documented follow-up for the PM.
 *
 * Definitions (deliberately mechanical):
 * - COINED: a distinct name on a `[name] best|move <domain> -> "X"` line in
 *   .omx/atelier/lessons/game.log. Move domains (`aXb`) attribute the event
 *   to BOTH constituent domains.
 * - ACCEPTED: a coined name that is also present in the plate store
 *   (.omx/atelier/game/plates.json). The log only records post-discipline
 *   coinings, so this measures log-vs-store survival, not engine rejections
 *   (rejected candidates are never logged — see the `store` count for the
 *   full plate inventory, which may predate the log).
 * - STYLE AXES: tokens from accepted plates (name token weight 3, subtitle
 *   token weight 1), stopwords removed, adjectives detected by suffix
 *   heuristic. Sorted by weight desc then tag asc. Fully deterministic.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import type { PlateEntry } from './NamingOrgan.js';

/** Newer plate entries carry evidence-corrected attribution; optional, additive. */
type StoredPlate = PlateEntry & { primary_domain?: string };
const plateDomain = (p: StoredPlate): string => p.primary_domain ?? p.domain;

const NAME_LOG = (cwd: string) => join(cwd, '.omx', 'atelier', 'lessons', 'game.log');
const PLATES = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'plates.json');
const BEADS = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'beads.json');
export const TAXONOMY_PATH = (cwd: string) => join(cwd, '.omx', 'atelier', 'game', 'taxonomy.json');

export interface NameEvent {
  kind: 'best' | 'move';
  /** Raw domain field from the log (`p5`, or a move combo `threexglsl`). */
  rawDomain: string;
  /** Constituent domains (move combos split on `x`, verified non-empty). */
  domains: string[];
  name: string;
  subtitle: string;
}

export interface LexicalCluster {
  /** Deterministic label: shortest member, ties broken alphabetically. */
  label: string;
  members: string[];
  count: number;
}

export interface StyleAxis {
  tag: string;
  kind: 'adjective' | 'noun';
  weight: number;
}

export interface DomainTaxonomy {
  coined: number;
  accepted: number;
  /** accepted / coined, 0 when nothing coined yet. */
  acceptanceRate: number;
  /** Plate-store entries for this domain (may predate the name log). */
  store: number;
  /** Bead inventory for this domain — the diversity substrate. */
  beads: number;
  names: string[];
  clusters: LexicalCluster[];
  styleAxes: StyleAxis[];
}

export interface Taxonomy {
  domains: Record<string, DomainTaxonomy>;
  totals: { coined: number; accepted: number; store: number; beads: number; domains: number };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'from', 'with', 'into', 'onto', 'in', 'on', 'at', 'to',
  'is', 'are', 'was', 'were', 'be', 'as', 'it', 'its', 'this', 'that', 'by', 'plus', 'via', 'not',
  'adds', 'add', 'artistic', 'likely', 'available', 'captures', 'capturing', 'gives', 'fitting',
]);

const ADJECTIVE_SUFFIXES = [
  'ous', 'ful', 'ical', 'ive', 'less', 'ish', 'able', 'ible', 'esque', 'ary', 'oid', 'ic', 'al',
];

/** Split camelCase, strip accents, lowercase. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/** Light suffix strip — enough to merge plurals/gerunds, nothing clever. */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  return token;
}

function isAdjective(token: string): boolean {
  return ADJECTIVE_SUFFIXES.some(s => token.endsWith(s) && token.length > s.length + 1);
}

/** Parse `[name] best|move <domain> -> "Name" · silk "..." · subtitle` lines. */
export function parseNameLog(log: string): NameEvent[] {
  const events: NameEvent[] = [];
  for (const line of log.split('\n')) {
    const m = /^\[name\] (best|move) (\S+) -> "(.+?)" · silk "[^"]*"(?: · (.*))?$/.exec(line.trim());
    if (!m) continue;
    const rawDomain = m[2];
    // Split move-domains on 'x' ONLY when both halves are themselves known
    // domain tokens (guards 'flux'-style names containing a literal x from
    // being shredded into phantom subdomains — GLM review nit).
    const xParts = rawDomain.split('x').filter(d => d.length > 0);
    const knownDomain = /^[a-z][a-z0-9]{1,11}$/;
    const domains = rawDomain.includes('x') && xParts.length >= 2 && xParts.every(d => knownDomain.test(d))
      ? xParts
      : [rawDomain];
    events.push({ kind: m[1] as 'best' | 'move', rawDomain, domains, name: m[3], subtitle: m[4] ?? '' });
  }
  return events;
}

/** Union-find over stemmed tokens: same stem, or >=4-char shared prefix. */
function clusterTokens(tokens: string[]): LexicalCluster[] {
  const parent = new Map<string, string>();
  const find = (t: string): string => {
    let root = t;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const uniq = [...new Set(tokens)].sort();
  for (const t of uniq) parent.set(t, t);
  const stems = new Map(uniq.map(t => [t, stem(t)]));
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const a = uniq[i];
      const b = uniq[j];
      const prefixLen = (() => {
        let n = 0;
        while (n < Math.min(a.length, b.length) && a[n] === b[n]) n += 1;
        return n;
      })();
      if (stems.get(a) === stems.get(b) || prefixLen >= 4) union(a, b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const t of uniq) {
    const root = find(t);
    const group = groups.get(root) ?? [];
    group.push(t);
    groups.set(root, group);
  }
  const clusters = [...groups.values()].map(members => {
    const sorted = [...members].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { label: sorted[0], members: [...members].sort(), count: members.length };
  });
  clusters.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return clusters;
}

function styleAxes(weights: Map<string, number>, topN: number): StyleAxis[] {
  const axes = [...weights.entries()].map(([tag, weight]) => ({
    tag,
    kind: (isAdjective(tag) ? 'adjective' : 'noun') as 'adjective' | 'noun',
    weight,
  }));
  axes.sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
  return axes.slice(0, topN);
}

export interface TaxonomyInputs {
  /** Raw contents of .omx/atelier/lessons/game.log */
  log: string;
  /** Parsed plate store (NamingOrgan's PlateEntry records). */
  plates: StoredPlate[];
  /** Bead inventory (id + domain only are used). */
  beads: Array<{ domain?: string }>;
  /** Max style axes kept per domain. */
  topAxes?: number;
}

/** Pure, deterministic taxonomy builder — same inputs always yield the same JSON. */
export function buildTaxonomy(inputs: TaxonomyInputs): Taxonomy {
  const topAxes = inputs.topAxes ?? 8;
  const events = parseNameLog(inputs.log);
  const storeNames = new Set(inputs.plates.map(p => p.plate.name));

  const coinedByDomain = new Map<string, Map<string, NameEvent>>();
  for (const event of events) {
    for (const domain of event.domains) {
      const names = coinedByDomain.get(domain) ?? new Map<string, NameEvent>();
      if (!names.has(event.name)) names.set(event.name, event);
      coinedByDomain.set(domain, names);
    }
  }

  const storeByDomain = new Map<string, number>();
  for (const plate of inputs.plates) {
    const domain = plateDomain(plate);
    storeByDomain.set(domain, (storeByDomain.get(domain) ?? 0) + 1);
  }

  const beadsByDomain = new Map<string, number>();
  for (const bead of inputs.beads) {
    if (!bead.domain) continue;
    beadsByDomain.set(bead.domain, (beadsByDomain.get(bead.domain) ?? 0) + 1);
  }

  const domains: Record<string, DomainTaxonomy> = {};
  const allDomains = new Set<string>([
    ...coinedByDomain.keys(),
    ...storeByDomain.keys(),
    ...beadsByDomain.keys(),
  ]);
  for (const domain of [...allDomains].sort()) {
    const coined = coinedByDomain.get(domain) ?? new Map<string, NameEvent>();
    const names = [...coined.keys()].sort();
    const acceptedNames = names.filter(n => storeNames.has(n));

    // Style-axis weights from ACCEPTED plates only: a store plate attributed
    // to this domain (primary_domain ?? domain) whose name was also coined in
    // the log window (name token x3, subtitle token x1).
    const weights = new Map<string, number>();
    for (const plate of inputs.plates) {
      if (plateDomain(plate) !== domain) continue;
      if (!coined.has(plate.plate.name)) continue; // store-only plate — not an acceptance event
      for (const token of tokenize(plate.plate.name)) weights.set(token, (weights.get(token) ?? 0) + 3);
      for (const token of tokenize(plate.plate.subtitle ?? '')) weights.set(token, (weights.get(token) ?? 0) + 1);
    }

    const clusters = clusterNames(acceptedNames);
    domains[domain] = {
      coined: names.length,
      accepted: acceptedNames.length,
      acceptanceRate: names.length === 0 ? 0 : acceptedNames.length / names.length,
      store: storeByDomain.get(domain) ?? 0,
      beads: beadsByDomain.get(domain) ?? 0,
      names,
      clusters,
      styleAxes: styleAxes(weights, topAxes),
    };
  }

  const byKey = (get: (d: DomainTaxonomy) => number) =>
    Object.values(domains).reduce((sum, d) => sum + get(d), 0);
  return {
    domains,
    totals: {
      coined: byKey(d => d.coined),
      accepted: byKey(d => d.accepted),
      store: inputs.plates.length,
      beads: inputs.beads.length,
      domains: Object.keys(domains).length,
    },
  };
}

/** Lexical clusters over the accepted NAMES of one domain. */
function clusterNames(names: string[]): LexicalCluster[] {
  const tokens: string[] = [];
  for (const name of names) tokens.push(...tokenize(name));
  return clusterTokens(tokens);
}

/** Read the real substrate from disk and build the taxonomy (no writes). */
export function growTaxonomy(cwd: string, options: { topAxes?: number } = {}): Taxonomy {
  let log = '';
  try { log = readFileSync(NAME_LOG(cwd), 'utf8'); } catch { /* no log yet — empty taxonomy */ }
  let plates: PlateEntry[] = [];
  try { plates = JSON.parse(readFileSync(PLATES(cwd), 'utf8')) as PlateEntry[]; } catch { /* no plates yet */ }
  let beads: Array<{ domain?: string }> = [];
  if (existsSync(BEADS(cwd))) {
    try { beads = JSON.parse(readFileSync(BEADS(cwd), 'utf8')) as Array<{ domain?: string }>; } catch { /* unreadable beads — skip */ }
  }
  return buildTaxonomy({ log, plates, beads, topAxes: options.topAxes });
}

/** Write the taxonomy where the naming loop can consume it. Deterministic: no timestamps. */
export function writeTaxonomy(cwd: string, taxonomy: Taxonomy): string {
  const path = TAXONOMY_PATH(cwd);
  writeAtomicSync(path, `${JSON.stringify(taxonomy, null, 1)}\n`);
  return path;
}

/** Human report for `sinter taxonomy` (the repo's report-command pattern). */
export function formatTaxonomyReport(taxonomy: Taxonomy): string {
  const lines: string[] = [];
  const t = taxonomy.totals;
  lines.push(`[taxonomy] ${t.domains} domains | coined ${t.coined} | accepted ${t.accepted} | store ${t.store} plates | ${t.beads} beads`);
  for (const domain of Object.keys(taxonomy.domains).sort()) {
    const d = taxonomy.domains[domain];
    const top = d.styleAxes.slice(0, 3).map(a => `${a.tag}(${a.kind[0]})`).join(', ') || '—';
    lines.push(
      `[taxonomy] ${domain}: coined ${d.coined}, accepted ${d.accepted} (${(d.acceptanceRate * 100).toFixed(0)}%), ` +
      `store ${d.store}, beads ${d.beads} | axes: ${top}`,
    );
  }
  return lines.join('\n');
}
