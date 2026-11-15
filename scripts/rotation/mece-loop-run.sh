#!/usr/bin/env bash
# MECE 4-lane diagnose panel runner (W9-OPS-01 wires honest scoring).
set -euo pipefail
WAVE=9; ROUND=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wave) WAVE="$2"; shift 2 ;;
    --round) ROUND="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: scripts/rotation/mece-loop-run.sh [--wave N] [--round N]"
      echo "Seat ok = planBytes>=200 && exitCode==0 (verdict ignored). See mece-panel-score.mjs."
      exit 0
      ;;
    *) shift ;;
  esac
done
export LIMINAL_ALLOW_LOCALHOST_LLM=true
export LIMINAL_HARNESS_TIMEOUT="${LIMINAL_HARNESS_TIMEOUT:-1200000}"
export LIMINAL_LLM_TIMEOUT="${LIMINAL_LLM_TIMEOUT:-1200000}"
export LIMINAL_TUI_AGENT_MAX_STEPS=24
export LIMINAL_HARNESS_PLAN_MAX_TOKENS=32768
export LIMINAL_HARNESS_MAX_TOKENS=65536
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
QDIR=".quality/wave${WAVE}"
mkdir -p "$QDIR" docs/agents/waves/staged
for f in BOUNDARY_TABLE.md wave-next-mece-lanes.md ANTI_GOALS_IMPLEMENTER.md mece-rotate-loop.md; do
  [[ -f "docs/agents/waves/$f" ]] && cp "docs/agents/waves/$f" "docs/agents/waves/staged/$f" || true
done
node scripts/rotation/mece-rotate.mjs --round "$ROUND" --wave "$WAVE" --write-briefs

python3 - <<PY
import json, subprocess, os, shutil
from pathlib import Path
wave = int("$WAVE")
q = Path(f".quality/wave{wave}")
rot = json.loads((q / "ROTATION.json").read_text())
results = []
for lane in ["L1", "L2", "L3", "L4"]:
    seat = rot["seats"][lane]
    model, reasoning, extra = seat["model"], seat["reasoning"], seat.get("extra") or []
    out = q / f"harness-{lane.lower()}-{seat.get('id', model.split('/')[-1])}"
    brief = (q / "briefs" / f"{lane.lower()}-active.txt").read_text().strip()
    p = Path("scripts/rotation/tasks/harness.json")
    data = json.loads(p.read_text())
    for t in data["tasks"]:
        if t.get("id") == "harness-compound-diagnose-plan":
            t["brief"] = brief
            t["maxSteps"] = 24
    data["reasoningLevel"] = reasoning
    p.write_text(json.dumps(data, indent=2) + "\n")
    env = os.environ.copy()
    if "glm" in model or any("z.ai" in x for x in extra):
        try:
            key = subprocess.check_output(
                ["security", "find-generic-password", "-s", "pushing-dispatch", "-a", "glm_api_key", "-w"],
                text=True,
            ).strip()
            for k in ("HARNESS_API_KEY", "GLM_API_KEY", "LLM_API_KEY", "Z_AI_API_KEY", "ANTHROPIC_API_KEY"):
                env[k] = key
            env["ANTHROPIC_BASE_URL"] = "https://api.z.ai/api/anthropic"
        except Exception:
            pass
    log = q / f"{lane.lower()}.log"
    # #472 mandate dedup — claim BEFORE wiping out/ so we never destroy a concurrent winner
    tip = str(rot.get("tip") or "unknown")[:12]
    key_payload = {"wave": wave, "round": rot.get("round"), "lane": lane, "model": model, "brief": brief, "tip": tip}
    key_out = json.loads(subprocess.check_output(
        ["node", "scripts/rotation/diagnose-mandate-dedup.mjs", "key", json.dumps(key_payload)],
        text=True,
    ).strip())
    mandate_key = key_out["key"]
    ledger_path = str(q / "diagnose-mandates.json")
    claim_proc = subprocess.run(
        ["node", "scripts/rotation/diagnose-mandate-dedup.mjs", "claim",
         "--ledger", ledger_path,
         "--key", mandate_key,
         "--meta", json.dumps({"lane": lane, "model": model, "wave": wave, "round": rot.get("round")})],
        capture_output=True, text=True,
    )
    try:
        claim = json.loads((claim_proc.stdout or "").strip() or "{}")
    except Exception:
        claim = {}
    if claim_proc.returncode not in (0, 3):
        err = (claim_proc.stderr or claim_proc.stdout or "claim failed").strip()[:300]
        print(f"mandate claim error rc={claim_proc.returncode}: {err}", flush=True)
        raise SystemExit(f"mandate claim failed: {err}")
    if claim.get("dedup_hit") or claim_proc.returncode == 3:
        # Already claimed this wave/round — treat as successful skip (not a red seat)
        skipped = {
            "lane": lane, "model": model, "ok": True, "planBytes": 0,
            "verdict": "mandate_dedup", "rc": 0, "mandateKey": mandate_key, "skipped": True,
        }
        results.append(skipped)
        print(json.dumps(skipped, indent=2), flush=True)
        continue
    if out.exists():
        shutil.rmtree(out)
    cmd = ["node", "scripts/rotation/cli.mjs", "harness", "--live", "--wave", str(wave),
           "--model", model, "--reasoning", reasoning, "--max-tasks", "1", "--out", str(out), *extra]
    print(f"===== {lane} {model} =====", flush=True)
    try:
        with open(log, "w") as lf:
            proc = subprocess.run(cmd, env=env, stdout=lf, stderr=subprocess.STDOUT)
    finally:
        # release mandate after seat finishes so retries can re-run intentionally
        subprocess.run(
            ["node", "scripts/rotation/diagnose-mandate-dedup.mjs", "release",
             "--ledger", ledger_path, "--key", mandate_key],
            capture_output=True, text=True,
        )
    plan_bytes, verdict = 0, None
    rec = out / "receipts"
    if rec.exists():
        plan = next(rec.glob("*-plan.md"), None)
        rj = next((f for f in rec.glob("*.json") if "envelope" not in f.name and "meta" not in f.name and "plan." not in f.name), None)
        if plan:
            plan_bytes = plan.stat().st_size
        if rj:
            r = json.loads(rj.read_text())
            verdict = r.get("verdict")
    # W9-OPS-01: pure scorer — planBytes + exitCode; verdict ignored for ok
    scored = json.loads(subprocess.check_output(
        ["node", "scripts/rotation/mece-panel-score.mjs", "seat",
         json.dumps({"planBytes": plan_bytes, "exitCode": proc.returncode, "verdict": verdict})],
        text=True,
    ).strip())
    ok = bool(scored["ok"])
    results.append({
        "lane": lane,
        "model": model,
        "ok": ok,
        "planBytes": plan_bytes,
        "verdict": verdict,
        "rc": proc.returncode,
    })
    print(json.dumps(results[-1], indent=2), flush=True)
panel = {
    "tip": rot["tip"],
    "wave": wave,
    "round": rot["round"],
    "seats": results,
    "allGreen": all(x["ok"] for x in results),
}
(q / f"WAVE{wave}_PANEL_SUMMARY.json").write_text(json.dumps(panel, indent=2) + "\n")
print(json.dumps(panel, indent=2))
raise SystemExit(0 if panel["allGreen"] else 1)
PY
