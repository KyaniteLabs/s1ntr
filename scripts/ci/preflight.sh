#!/usr/bin/env bash
# Run the fast CI gates locally BEFORE pushing, so a cheap failure does not take a
# ~8 min CI queue slot. Every check below is the same command CI runs (or a subset
# of the same tests); nothing here replaces CI, it only front-loads it.
#
#   scripts/ci/preflight.sh             ~35-60 s: static checks, quality check, contract tests, lint on changed files
#   PREFLIGHT_FULL=1 scripts/ci/preflight.sh   adds full lint and the GUI typecheck
#
# Runs every check even after a failure and lists all failures at the end.
# On a shared host run it as: nice -n 19 taskset -c 0-3 scripts/ci/preflight.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

failed=()
skipped=()
run() {
  local name=$1; shift
  local t0=$SECONDS
  if "$@" >".preflight-$$.log" 2>&1; then
    printf 'ok    %-34s %ds\n' "$name" $((SECONDS - t0))
  else
    printf 'FAIL  %-34s %ds\n' "$name" $((SECONDS - t0))
    sed 's/\x1b\[[0-9;]*m//g' ".preflight-$$.log" | tail -n 25 | sed 's/^/      /'
    failed+=("$name")
  fi
  rm -f ".preflight-$$.log"
}

[ -d node_modules ] || { echo "node_modules missing: run pnpm install --frozen-lockfile first" >&2; exit 2; }

run "orphan source check"        pnpm check:orphans
run "package script targets"     pnpm check:script-targets
run "CLI entrypoint parse"       pnpm check:cli-parse
run "doc links"                  pnpm check:doc-links
run "compound loop contract"     pnpm run check:compound-loop
run "mece manifest"              pnpm run check:mece-manifest
run "public mirror policy"       python3 test/test_public_mirror_policy.py
run "test quality (strict)"      pnpm test:quality:strict

if python3 -I -c 'import pytest, numpy, PIL' 2>/dev/null; then
  run "learning pytest"          env REQUIRE_NUMPY=1 python3 -I -m pytest -q test/learning
else
  skipped+=("learning pytest (needs python3 pytest numpy pillow; CI runs it)")
fi
run "art-batch corpus lock"      python3 -I test/art-batch/test_corpus_idempotent.py

# Gate-style tests that fail most often in CI (authority registry, owner identifiers,
# QA ledgers, domain contracts); the same files the fast suite runs.
run "contract tests"             env LIMINAL_CI_FAST=1 pnpm exec vitest run --coverage=false --pool=forks --maxWorkers=2 \
  test/integration/production-authority-registry.test.ts test/unit/scripts/mece-manifest.test.ts \
  test/unit/packaging/no-owner-identifiers.test.ts test/scripts/final-qa-ledger.test.ts \
  test/unit/runtime-core/DomainContractFacts.test.ts test/unit/creative-vocabulary/LibraryCards.test.ts

if [ "${PREFLIGHT_FULL:-0}" = "1" ]; then
  run "lint (all of src/)"       pnpm lint
  run "typecheck GUI"            bash -c 'pnpm --filter @sinter/audio-core build && pnpm --dir gui exec tsc --noEmit'
else
  base=$(git merge-base HEAD origin/main 2>/dev/null || true)
  changed=()
  if [ -n "$base" ]; then
    while IFS= read -r f; do [ -f "$f" ] && changed+=("$f"); done < <(
      { git diff --name-only "$base" -- 'src/*.ts' 'src/**/*.ts' 'src/*.tsx' 'src/**/*.tsx'; \
        git ls-files --others --exclude-standard -- 'src/*.ts' 'src/**/*.ts'; } | sort -u)
  fi
  if [ "${#changed[@]}" -gt 0 ]; then
    run "lint (${#changed[@]} changed files)" pnpm exec eslint "${changed[@]}"
  else
    echo "ok    lint (no changed src files)"
  fi
fi

echo
for s in "${skipped[@]:-}"; do [ -n "$s" ] && echo "SKIPPED: $s"; done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "PREFLIGHT FAILED: ${failed[*]}"
  exit 1
fi
echo "PREFLIGHT OK (CI still runs the full gate: build, typecheck, full test suite)"
