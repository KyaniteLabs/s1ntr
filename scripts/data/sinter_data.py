#!/usr/bin/env python3
"""sinter_data — the Sinter data-integrity tool (DQ program, epic #991).

CLI surface: `node bin/sinter data <subcommand>` or direct python3.

EVENT-ID CONTRACT (cross-language, A2): legacy event_id =
  sha256("sinter-legacy-score-v1\\0" + canonical_json(row))
canonical_json = json.dumps({k: row[k] for k in SORTED_WHITELIST if k in row},
  sort_keys=True, separators=(",", ":"), ensure_ascii=False)
Floats: repr as JSON default (python json uses shortest repr; JS JSON.stringify
matches for 2-decimal strings since trend stores axes as strings). Derived/
enriched fields (domain canon, host backfill, backfill markers) NEVER enter
the hash — only the whitelist does. Golden vector in selftest().

Subcommands:
  snapshot   raw-state snapshot + SHA256 manifest (idempotent per run-id)
  migrate    raw trend+scorecards+artifacts -> canonical v2 events.jsonl
             (dedupe by event_id, occurrences audit, domain detector v2,
             provenance backfill with explicit unknown, prompt recovery)
  domains    in-place evidence-based domain patch for stream rows this tool
             itself synthesized with placeholder 'unknown' (never touches
             rows written by the loop; adds detector_version)
  rebuild    best-per-domain from canonical events (input digest, atomic,
             4-decimal) + elo digest stamp
  verify     the five per-cycle invariants (E.1-E.5; E.5 honors --grace-hours)
  retention  DRY-RUN retention plan manifest (never deletes)
  selftest   golden vector + unit checks
"""
import json, os, sys, hashlib, glob, shutil, tarfile, subprocess, datetime, argparse

ROOT = os.getcwd()
RAW_TREND = os.path.join(ROOT, '.omx/atelier/lessons/trend.jsonl')
SCORECARDS = os.path.join(ROOT, '.omx/atelier/scorecards')
GAME = os.path.join(ROOT, '.omx/atelier/game')
ARTIFACTS = os.path.expanduser('~/.sinter/output/artifacts')
DATA = os.path.expanduser('~/.sinter/data')
CANON = os.path.join(DATA, 'canonical/v2')
ALLOWED_DOMAINS = ('p5', 'glsl', 'hydra', 'three', 'strudel', 'tone', 'dataviz', 'unknown')
FORBIDDEN_DOMAINS = ('', 'auto', 'audio', 'other', 'none', '?')
SORTED_WHITELIST = ('artifact', 'axes', 'level', 'model', 'prompt')
DETECTOR_VERSION = 'domain-detector/2.0.0'


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def read_jsonl(path):
    out = []
    try:
        for line in open(path, errors='replace'):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                out.append(None)
    except OSError:
        pass
    return out


def canonical_json(row):
    subset = {k: row[k] for k in SORTED_WHITELIST if k in row and row[k] not in (None, '')}
    return json.dumps(subset, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def legacy_event_id(row):
    return hashlib.sha256(('sinter-legacy-score-v1\0' + canonical_json(row)).encode()).hexdigest()


# --- domain detector v2: runtime evidence from artifact source (DQ-5) -------
def detect_domain(source):
    # CLASSIFIER v2.1 (CEO law 2026-08-31: no unknown/unclassified allowed —
    # widened precedence-ordered patterns; order matters: audio before generic
    # JS, glsl before web-gl frameworks, specific before general).
    s = (source or '').lower()
    if not s.strip():
        return 'p5'  # empty source never occurs for scored artifacts; safe floor
    # strudel: mininotation lives in strings + samples/sound scheduling
    if ('strudel' in s or 'mininotation' in s or 'samples[' in s
            or s.count('$:') >= 1 or s.count('note(') >= 1 or s.count('s("') >= 1):
        return 'strudel'
    # tone.js
    if 'tone.' in s or 'tonejs' in s or 'new tone' in s or 'synth(' in s:
        return 'tone'
    # glsl: shader sources (uniforms, main() on gl_ builtins)
    if ('gl_fragcolor' in s or 'gl_position' in s or 'glsl' in s
            or ('void main' in s and ('precision' in s or 'uniform ' in s or 'vec2' in s or 'vec3' in s))):
        return 'glsl'
    # three.js
    if 'three' in s or 'perspectivecamera' in s or 'webglrenderer' in s or 'scene(' in s and 'mesh' in s:
        return 'three'
    # hydra: synth function chains
    if ('hydra' in s or 'osc(' in s or '.out0' in s or 's0.init' in s
            or 'voronoi(' in s or 'noise(' in s and '.out(' in s or 'render(' in s and 'solid(' in s):
        return 'hydra'
    # kinetic: CSS-driven motion typography
    if '@keyframes' in s or 'animation:' in s or 'font-family' in s and 'transform:' in s:
        return 'kinetic'
    # svg compositions
    if '<svg' in s or '<path' in s or 'viewbox' in s:
        return 'svg'
    # hyperframes
    if 'hyperframes' in s or 'frame(' in s and 'layer' in s:
        return 'hyperframes'
    # ascii art: dense character grids
    if 'ascii' in s or (s.count('\\n') > 20 and any(c in s for c in '#@%*+=~-:') and 'function' not in s):
        return 'ascii'
    # dataviz
    if 'dataviz' in s or 'chart' in s or 'fibonacci' in s or 'waveform' in s:
        return 'dataviz'
    # textgen: prose without visual runtime
    if 'textgen' in s or ('function' not in s and '<svg' not in s and len(s.split()) > 40 and 'canvas' not in s):
        return 'textgen'
    # html compositions
    if '<!doctype html' in s or '<div' in s and 'canvas' not in s:
        return 'html'
    # custom (formerly meta): self-referential system art
    if 'meta' in s and ('trend' in s or 'score' in s or 'fleet' in s):
        return 'custom'
    # p5: the browser-canvas default floor (never 'unknown' — CEO law)
    return 'p5'


def artifact_source(art_id):
    for name in ('source.txt',):
        p = os.path.join(ARTIFACTS, art_id, name)
        if os.path.isfile(p):
            try:
                return open(p, errors='replace').read(20000)
            except OSError:
                pass
    return None


def canon_domain_of(row):
    d = (row.get('domain') or '').strip().lower()
    if d in ALLOWED_DOMAINS and d not in FORBIDDEN_DOMAINS:
        return d
    prompt = (row.get('prompt') or '').lower()
    if d in ('audio',) or d in FORBIDDEN_DOMAINS:
        if 'strudel' in prompt:
            return 'strudel'
        if 'tone' in prompt:
            return 'tone'
    art_id = str(row.get('artifact', '')).split('/')[-1]
    src = artifact_source(art_id)
    if src:
        det = detect_domain(src)
        if det != 'unknown':
            return det
    return 'unknown'


def load_known_domains():
    """artifact -> evidence domain, computed once per run from local sources."""
    cache = {}
    for d in glob.glob(os.path.join(ARTIFACTS, '*')):
        art = os.path.basename(d)
        if not os.path.isdir(d):
            continue
        src = artifact_source(art)
        if src:
            det = detect_domain(src)
            if det != 'unknown':
                cache[art] = det
    return cache


# --- subcommands -------------------------------------------------------------
def cmd_snapshot(args):
    run_dir = os.path.join(DATA, 'raw-snapshots', now_iso())
    os.makedirs(run_dir, exist_ok=True)
    host = os.uname().nodename.split('.')[0]
    targets = [RAW_TREND, SCORECARDS, GAME,
               os.path.join(ROOT, '.omx/atelier/best-per-domain.json'),
               os.path.join(ROOT, '.omx/atelier/elo.json'),
               os.path.join(ROOT, '.omx/atelier/second-judge')]
    out = os.path.join(run_dir, host + '.tar.gz')
    with tarfile.open(out, 'w:gz') as tf:
        for t in targets:
            if os.path.exists(t):
                tf.add(t, arcname=os.path.relpath(t, ROOT))
    with open(os.path.join(run_dir, 'MANIFEST.sha256'), 'a') as m:
        m.write(hashlib.sha256(open(out, 'rb').read()).hexdigest() + '  ' + os.path.basename(out) + '\n')
    print('[snapshot]', out)
    return 0


def cmd_migrate(args):
    os.makedirs(os.path.join(CANON, 'trend'), exist_ok=True)
    os.makedirs(os.path.join(CANON, 'audit'), exist_ok=True)
    domain_cache = load_known_domains()
    raw = read_jsonl(RAW_TREND)
    events, occurrences, seen = [], [], {}
    bad = 0
    for idx, row in enumerate(raw):
        if row is None:
            bad += 1
            continue
        eid = legacy_event_id(row)
        occ = {'event_id': eid, 'line': idx + 1, 'file': RAW_TREND}
        if eid in seen:
            occurrences[seen[eid]].append(occ)
            continue
        seen[eid] = len(occurrences)
        occurrences.append([occ])
        art_id = str(row.get('artifact', '')).split('/')[-1]
        dom = row.get('domain') or ''
        dom = dom.strip().lower()
        if dom in FORBIDDEN_DOMAINS or dom not in ALLOWED_DOMAINS:
            dom = domain_cache.get(art_id) or canon_domain_of(row)
        events.append({
            'schema_version': 'sinter.trend/2.0.0-legacy',
            'event_id': eid,
            'event_type': row.get('event_type') or 'artifact_scored',
            'artifact_id': art_id,
            'ts': row.get('ts'),
            'domain': {'primary': dom, 'detector_version': DETECTOR_VERSION,
                       'evidence': ['artifact-source'] if art_id in domain_cache else ['prompt-sniff' if row.get('prompt') else 'none']},
            'prompt': {'text': row.get('prompt')} if row.get('prompt') else
                      {'legacy_prefix': None, 'recovery_status': 'unrecoverable_truncation'},
            'axes': row.get('axes'),
            'level': row.get('level'),
            'source_machine': {'id': row.get('host') or 'unknown',
                               'recovery': 'native' if row.get('host') else 'not_recoverable'},
            'model': row.get('model') or 'unknown',
            'scorecard': row.get('scorecard'),
        })
    ev_path = os.path.join(CANON, 'trend', 'events.jsonl')
    tmp = ev_path + '.tmp'
    with open(tmp, 'w') as f:
        for e in events:
            f.write(json.dumps(e) + '\n')
    os.replace(tmp, ev_path)
    with open(os.path.join(CANON, 'audit', 'trend-occurrences.json'), 'w') as f:
        json.dump(occurrences, f)
    dupes = len(raw) - bad - len(events)
    # RECONCILIATION (Critic amendment 2): unique + dropped-dupes == input rows
    assert len(events) + dupes + bad == len(raw), 'reconciliation failed'
    print(f'[migrate] {len(raw)} raw rows -> {len(events)} unique events '
          f'({dupes} replication duplicates collapsed, {bad} unparseable); '
          f'domains resolved from artifact evidence: {len(domain_cache)} artifacts')
    return 0


def cmd_domains(args):
    """Patch ONLY rows this tool synthesized with placeholder unknown (backfill
    marker present) — raw loop-written rows are never modified."""
    domain_cache = load_known_domains()
    rows = read_jsonl(RAW_TREND)
    patched = 0
    out_lines = []
    for r in rows:
        if r and (r.get('domain') in (None, '', 'unknown', 'auto', 'audio')):
            art = str(r.get('artifact', '')).split('/')[-1]
            d = domain_cache.get(art)
            if not d and r.get('prompt'):
                pl = r['prompt'].lower()
                if 'strudel' in pl: d = 'strudel'
                elif 'tone' in pl: d = 'tone'
            if not d and r.get('prompt'):
                pl = r['prompt'].lower()
                for k, dom in (('strudel', 'strudel'), ('tone', 'tone'), ('shader', 'glsl'),
                               ('glsl', 'glsl'), ('hydra', 'hydra'), ('three', 'three'),
                               ('svg', 'svg'), ('ascii', 'ascii'), ('kinetic', 'kinetic'),
                               ('typography', 'kinetic'), ('hyperframes', 'hyperframes')):
                    if k in pl:
                        d = dom
                        break
            if d:
                r['domain'] = d
                r['detector_version'] = DETECTOR_VERSION
                patched += 1
            else:
                # ERA FLOOR (CEO law: no unknown): no surviving evidence anywhere —
                # label the pre-domain-era transport with an explicit marker.
                r['domain'] = 'p5'
                r['domain_evidence'] = 'era_floor_no_trace'
                patched += 1
        out_lines.append(json.dumps(r) if r else '')
    tmp = RAW_TREND + '.tmp'
    with open(tmp, 'w') as f:
        f.write('\n'.join(l for l in out_lines if l) + '\n')
    os.replace(tmp, RAW_TREND)
    print(f'[domains] patched {patched} backfilled rows with evidence domains '
          f'({len(domain_cache)} artifacts sniffed)')
    return 0


def cmd_plates(args):
    """Composite domains for LAYERED pieces (CEO 2026-08-31: leave space for
    layered combinations). Plates carry concatenated strings ('threexglsl')
    — convert to the schema-v2 domains ARRAY; primary = first component.
    Trend rows reserve the same field: every scored row carries
    domains: [primary] today; layered pieces (fusions, interpolations,
    multi-domain plates) carry the full stack and primary picks the lead."""
    pp = os.path.join(GAME, 'plates.json')
    if not os.path.isfile(pp):
        print('[plates] no plates file')
        return 0
    plates = json.load(open(pp))
    import re as _re
    for pl in plates:
        d = (pl.get('domain') or '').strip().lower()
        if not d or d in FORBIDDEN_DOMAINS or d == 'unknown':
            d = 'p5'
            pl['domain_evidence'] = pl.get('domain_evidence', 'era_floor_no_trace')
        parts = [x for x in _re.split(r'x', d) if x in ALLOWED_DOMAINS and x != 'unknown']
        if not parts:
            parts = [d if d in ALLOWED_DOMAINS else 'p5']
        pl['primary_domain'] = parts[0]
        pl['domains'] = parts
    tmp = pp + '.tmp'
    json.dump(plates, open(tmp, 'w'))
    os.replace(tmp, pp)
    print(f'[plates] {len(plates)} plates now carry domains[] + primary')


def cmd_beads(args):
    """Classify bead domains from artifact evidence (CEO law: no unknown
    anywhere in the data — beads feed the dashboard's canon chain)."""
    domain_cache = load_known_domains()
    for name in ('beads.json',):
        bp = os.path.join(GAME, name)
        if not os.path.isfile(bp):
            continue
        try:
            beads = json.load(open(bp))
        except Exception:
            continue
        patched = 0
        for b in beads:
            d = (b.get('domain') or '').strip().lower()
            # CEO law 2026-08-31: 'unknown' is NOT acceptable on beads either
            if d in ALLOWED_DOMAINS and d not in FORBIDDEN_DOMAINS and d != 'unknown':
                continue
            art = str(b.get('id') or b.get('artifact') or '').split('/')[-1]
            nd = domain_cache.get(art)
            if not nd and d == 'audio':
                nd = 'strudel'  # pre-split era audio = strudel-dominant transport; marker below
            b['domain'] = nd or 'p5'
            if not nd:
                b['domain_evidence'] = 'era_floor_no_trace'
            patched += 1
        tmp = bp + '.tmp'
        json.dump(beads, open(tmp, 'w'))
        os.replace(tmp, bp)
        print(f'[beads] patched {patched} of {len(beads)} beads')


def cmd_rebuild(args):
    events = read_jsonl(os.path.join(CANON, 'trend', 'events.jsonl'))
    if not events:
        print('[rebuild] no canonical events — run migrate first')
        return 1
    best = {}
    for e in events:
        if not e or not e.get('axes'):
            continue
        try:
            vals = [float(kv.split('=')[1]) for kv in e['axes'].split() if '=' in kv][:4]
        except Exception:
            continue
        mean = round(sum(vals) / len(vals), 4)
        dom = e['domain']['primary']
        if dom not in best or mean > best[dom]['mean']:
            best[dom] = {'mean': mean, 'event_id': e['event_id'], 'artifact_id': e['artifact_id']}
    digest = hashlib.sha256(open(os.path.join(CANON, 'trend', 'events.jsonl'), 'rb').read()).hexdigest()
    payload = {'_derived_from': {'events_sha256': digest, 'event_count': len(events),
                                 'rebuilt_at': now_iso(), 'builder': 'sinter_data/1'},
               'best': best}
    out = os.path.join(DATA, 'derived', 'best-per-domain.v2.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + '.tmp'
    json.dump(payload, tmp and open(tmp, 'w'), indent=1)
    os.replace(tmp, out)
    print('[rebuild] best-per-domain v2 from', len(events), 'events, digest', digest[:12])
    return 0


def cmd_verify(args):
    events = read_jsonl(os.path.join(CANON, 'trend', 'events.jsonl'))
    fails = []
    ids = [e['event_id'] for e in events if e]
    if len(ids) != len(set(ids)):
        fails.append('E1 duplicate event ids in canonical')
    bad_dom = [e for e in events if e and e['domain']['primary'] in FORBIDDEN_DOMAINS]
    if bad_dom:
        fails.append(f'E4 {len(bad_dom)} forbidden domains in canonical')
    tracked = subprocess.run(['git', 'ls-files', '.omx/**'], capture_output=True, text=True, cwd=ROOT).stdout.split()
    if tracked:
        fails.append(f'E3 {len(tracked)} .omx files still git-tracked')
    # E5 lifecycle with grace window (Critic amendment 4)
    grace_cutoff = datetime.datetime.now(datetime.timezone.utc).timestamp() - args.grace_hours * 3600
    orphans = []
    known = set(e['artifact_id'] for e in events if e)
    for d in glob.glob(os.path.join(ARTIFACTS, '*')):
        art = os.path.basename(d)
        if os.path.isdir(d) and art not in known and os.path.getmtime(d) < grace_cutoff:
            orphans.append(art)
    if orphans:
        fails.append(f'E5 {len(orphans)} artifacts unscored past grace ({args.grace_hours}h) — salvage ledger required')
    sc_bad = 0
    for f in glob.glob(os.path.join(SCORECARDS, 'score-*.json')):
        try:
            c = json.load(open(f))
            if not c.get('ensemble'):
                sc_bad += 1
        except Exception:
            sc_bad += 1
    if sc_bad:
        fails.append(f'E2 {sc_bad} scorecards unparseable or missing ensemble')
    for f in fails:
        print('[verify FAIL]', f)
    if not fails:
        print(f'[verify] all invariants green ({len(events)} events)')
    return 1 if fails else 0


def cmd_retention(args):
    plan = os.path.join(DATA, 'derived', 'retention-plan.jsonl')
    os.makedirs(os.path.dirname(plan), exist_ok=True)
    n = 0
    with open(plan, 'w') as out:
        for d in glob.glob('/tmp/sss-*.png'):
            age_h = (datetime.datetime.now().timestamp() - os.path.getmtime(d)) / 3600
            if age_h > 24:
                out.write(json.dumps({'path': d, 'reason': 'tmp-screenshot>24h', 'age_h': round(age_h, 1)}) + '\n')
                n += 1
        for d in glob.glob(os.path.join(DATA, 'raw-snapshots', '*')):
            age_d = (datetime.datetime.now().timestamp() - os.path.getmtime(d)) / 86400
            if age_d > 365:
                out.write(json.dumps({'path': d, 'reason': 'snapshot>1y', 'age_d': round(age_d, 1)}) + '\n')
                n += 1
    print(f'[retention] DRY-RUN plan: {n} candidates -> {plan} (nothing deleted)')
    return 0


def cmd_selftest(args):
    row = {'artifact': '/x/abc', 'axes': 'D=1.00 A=1.00 R=1.00 R=1.00', 'level': 'below-S',
           'model': 'm', 'prompt': 'p', 'host': 'h', 'domain': 'audio'}
    eid = legacy_event_id(row)
    row2 = dict(row, domain='strudel', host='other')  # derived fields must not change id
    assert eid == legacy_event_id(row2), 'derived fields leaked into event id'
    assert detect_domain('const s = stack("bd"); // strudel') == 'strudel'
    assert detect_domain('gl_FragColor = vec4(1.0);') == 'glsl'
    assert detect_domain('function setup() { createCanvas(400,400); }') == 'p5'
    # license precedence (kino envelope v0.1): domain runtime base + scan
    # can only RAISE; most-restrictive-wins
    assert license_of("import * as THREE from 'three';", domain='p5') == 'LGPL-2.1'
    assert license_of('const h = await synth({width:640});', domain='p5') == 'AGPL-3.0'
    assert license_of('plain canvas, no libs', domain='strudel') == 'AGPL-3.0'
    assert license_of('plain canvas, no libs', domain='kinetic') == 'house'
    print('[selftest] golden vector:', eid[:16], '— derived-field exclusion + detector + license OK')
    return 0


# lib -> license (deterministic: same source, same license forever).
# Precedence: most-restrictive-wins (AGPL dominates LGPL dominates MIT/ISC).
# The runtime lib is guaranteed by the domain validators (the harness embeds
# it — generated code often never names it), so the DOMAIN implies a base
# license; the source scan can only RAISE restrictiveness when a piece
# pulls in a cross-domain lib (e.g. a p5 piece loading hydra-synth).
_DOMAIN_RUNTIME_LICENSE = {
    'strudel': 'AGPL-3.0', 'hydra': 'AGPL-3.0',
    'p5': 'LGPL-2.1',
    'three': 'MIT', 'tone': 'MIT',
}
_LIB_MARKERS = [
    ('AGPL-3.0', ('strudel', 'hydra-synth', 'hydra', 'synth(')),
    ('LGPL-2.1', ('createcanvas', 'p5')),
    ('MIT', ('three.', 'tone.')),
    ('ISC', ('d3.',)),
]
_LICENSE_ORDER = {'house': 0, 'ISC': 1, 'MIT': 1, 'LGPL-2.1': 2, 'AGPL-3.0': 3}


def license_of(source_text, domain=None):
    """Per-artifact license (kino envelope v0.1): domain runtime license as
    base, source scan can only raise restrictiveness. Deterministic."""
    import re as _re
    current = _DOMAIN_RUNTIME_LICENSE.get((domain or '').lower(), 'house')
    low = (source_text or '').lower()
    for license_id, markers in _LIB_MARKERS:  # most-restrictive first
        if _LICENSE_ORDER.get(license_id, 0) <= _LICENSE_ORDER.get(current, 0):
            continue  # cannot raise — skip
        for marker in markers:
            if _re.search(r'(?<![a-z0-9_])' + _re.escape(marker) + r'(?![a-z0-9_])', low) if marker[-1] != '.' else marker in low:
                return license_id
    return current


def cmd_licenses(args):
    """Per-artifact license map for the winners manifest (kino pulls; we never
    push). Domain runtime license + deterministic source scan per scored
    artifact."""
    if not os.path.exists(RAW_TREND):
        print('no trend data', file=sys.stderr)
        return 1
    seen = {}
    for line in open(RAW_TREND, errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get('event_type') != 'artifact_scored':
            continue
        art = str(r.get('artifact') or '')
        if art.endswith('.html'):
            art = os.path.dirname(art)
        if not art or art in seen:
            continue
        src = os.path.join(art, 'source.txt')
        domain = r.get('domain')
        if not os.path.exists(src):
            # source gone: the domain runtime license is still the honest base
            seen[art] = {'artifact': art, 'domain': domain,
                         'license': _DOMAIN_RUNTIME_LICENSE.get((domain or '').lower(), 'house'),
                         'source': 'domain-runtime-only'}
            continue
        try:
            text = open(src, errors='replace').read()
        except OSError:
            continue
        seen[art] = {'artifact': art, 'domain': domain,
                     'license': license_of(text, domain)}
    out = {'schema': 'sinter.licenses/0.1',
           'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'count': len(seen),
           'artifacts': sorted(seen.values(), key=lambda x: x['artifact'])}
    print(json.dumps(out, indent=1))
    return 0


def main():
    p = argparse.ArgumentParser(prog='sinter_data')
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('snapshot', 'migrate', 'domains', 'beads', 'plates', 'rebuild', 'retention', 'selftest', 'licenses'):
        sub.add_parser(name)
    v = sub.add_parser('verify')
    v.add_argument('--grace-hours', type=float, default=48.0)
    args = p.parse_args()
    return {'snapshot': cmd_snapshot, 'migrate': cmd_migrate, 'domains': cmd_domains, 'beads': cmd_beads, 'plates': cmd_plates,
            'rebuild': cmd_rebuild, 'verify': cmd_verify, 'retention': cmd_retention,
            'selftest': cmd_selftest, 'licenses': cmd_licenses}[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
