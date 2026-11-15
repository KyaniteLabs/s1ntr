#!/usr/bin/env bash
# MECE multi-round supervisor with anti-thrash (Wave 11 / C1).
# - Cap consecutive harvest-only rounds (no new residual product)
# - Stop if panel only restates closed baseline (optional env)
set -uo pipefail
HOURS=6; WAVE=9; ROUND=1
MAX_HARVEST_ONLY="${LIMINAL_MECE_MAX_HARVEST_ONLY:-2}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --start-wave) WAVE="$2"; shift 2 ;;
    --start-round) ROUND="$2"; shift 2 ;;
    --max-harvest-only) MAX_HARVEST_ONLY="$2"; shift 2 ;;
    *) shift ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
mkdir -p .quality docs/agents/waves
LOG=.quality/mece-6h-supervisor.log
STATE=.quality/mece-6h-state.json
DEADLINE=$(( $(date +%s) + HOURS * 3600 ))
export LIMINAL_ALLOW_LOCALHOST_LLM=true LIMINAL_HARNESS_TIMEOUT=1200000 LIMINAL_LLM_TIMEOUT=1200000 AGENT_SESSION=1
HARVEST_ONLY_STREAK=0
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }
rem(){ echo $(( DEADLINE - $(date +%s) )); }
state(){ python3 -c "import json,datetime; open('$STATE','w').write(json.dumps({'wave':$WAVE,'round':$ROUND,'deadline':$DEADLINE,'phase':'$1','harvestOnlyStreak':$HARVEST_ONLY_STREAK,'updated':datetime.datetime.now(datetime.UTC).isoformat()},indent=2)+chr(10))"; }

log "=== SUPERVISOR v3 start hours=$HOURS wave=$WAVE round=$ROUND maxHarvestOnly=$MAX_HARVEST_ONLY rem=$(rem)s ==="
log "anti-thrash: stop after $MAX_HARVEST_ONLY consecutive harvest-only rounds; closed joints in wave-10 baseline"
state start
chmod +x scripts/rotation/mece-loop-run.sh scripts/rotation/mece-rotate.mjs 2>/dev/null || true

while [[ $(rem) -gt 1200 ]]; do
  state diagnose
  log "=== MECE wave=$WAVE round=$ROUND rem=$(rem)s harvestOnlyStreak=$HARVEST_ONLY_STREAK ==="
  set +e
  bash scripts/rotation/mece-loop-run.sh --wave "$WAVE" --round "$ROUND" >>"$LOG" 2>&1
  RC=$?
  set -e
  log "diagnose rc=$RC"

  OUT="docs/agents/waves/wave-${WAVE}-r${ROUND}-harvest.md"
  python3 - "$WAVE" "$ROUND" "$OUT" <<'PY'
import json,sys,re
from pathlib import Path
from datetime import datetime,timezone
wave,rnd,outp=int(sys.argv[1]),int(sys.argv[2]),Path(sys.argv[3])
q=Path(f'.quality/wave{wave}')
lines=[f'# Wave {wave} round {rnd} harvest','',f'Generated: {datetime.now(timezone.utc).isoformat()}','']
sf=q/f'WAVE{wave}_PANEL_SUMMARY.json'
if sf.exists():
    lines+=['## Summary','```json',sf.read_text().strip(),'```','']
closed_hits=0
total_plans=0
closed_markers = (
    'PlanPublisher-only', 'dual-green', 'boundaryMs', 'verifyPatternBeforeLearn',
    'wave-10-closeout', 'wave-9-closeout', 'already shipped', 'CLOSED joint',
    'do not re-open', 'do not re-prove', 'mece-panel-score',
)
for p in sorted(q.glob('harness-*/receipts/*-plan.md')):
    t=p.read_text(errors='replace')
    total_plans += 1
    low=t.lower()
    if sum(1 for m in closed_markers if m.lower() in low) >= 2:
        closed_hits += 1
    lines+=[f'## {p.parent.parent.name}',f'bytes={len(t)}','```',*t.splitlines()[:40],'```','']
# anti-thrash signal file for shell
signal=q/'HARVEST_ONLY_SIGNAL.json'
mostly_closed = total_plans > 0 and closed_hits >= max(1, total_plans // 2)
signal.write_text(json.dumps({
    'totalPlans': total_plans,
    'closedHits': closed_hits,
    'mostlyClosedJointRestate': mostly_closed,
}, indent=2)+'\n')
outp.parent.mkdir(parents=True, exist_ok=True)
outp.write_text('\n'.join(lines)+'\n')
print(outp)
PY
  log "harvest $OUT"

  # A4: harvest-only / closed-joint restate streak
  SIGNAL=".quality/wave${WAVE}/HARVEST_ONLY_SIGNAL.json"
  MOSTLY_CLOSED=0
  if [[ -f "$SIGNAL" ]]; then
    MOSTLY_CLOSED=$(python3 -c "import json;print(1 if json.load(open('$SIGNAL')).get('mostlyClosedJointRestate') else 0)")
  fi
  if [[ "$MOSTLY_CLOSED" == "1" ]]; then
    HARVEST_ONLY_STREAK=$((HARVEST_ONLY_STREAK+1))
    log "anti-thrash: mostly closed-joint restate (streak=$HARVEST_ONLY_STREAK/$MAX_HARVEST_ONLY)"
  else
    HARVEST_ONLY_STREAK=0
  fi

  git add "$OUT" 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "docs(wave): wave ${WAVE} r${ROUND} MECE harvest" >>"$LOG" 2>&1 || true
    git push -u origin HEAD >>"$LOG" 2>&1 || log "push soft-fail"
  fi

  if [[ "$HARVEST_ONLY_STREAK" -ge "$MAX_HARVEST_ONLY" ]]; then
    log "anti-thrash STOP: $HARVEST_ONLY_STREAK consecutive harvest-only/closed-joint rounds — implement open tickets or stop diagnose"
    state anti_thrash_stop
    break
  fi

  ROUND=$((ROUND+1)); WAVE=$((WAVE+1))
  state rotated
  log "next wave=$WAVE round=$ROUND rem=$(rem)s"
  if [[ $(rem) -lt 2400 ]]; then log "time budget low; stop"; break; fi
done
state done
log "=== SUPERVISOR v3 done rem=$(rem)s harvestOnlyStreak=$HARVEST_ONLY_STREAK ==="
