#!/usr/bin/env node
// Decides whether a push-to-main run may reuse a green pull_request run.
//
// A main run is redundant ONLY when all of these hold, otherwise the full
// gate runs (every uncertainty falls through to "run everything"):
//   1. the commit is a two-parent merge commit on main,
//   2. its tree hash equals the tree hash of the second parent (the PR head),
//   3. the PR head carries a SUCCESS "fast-gate (pull_request)" status that
//      the Actions runner posted (no human creator, target is an actions run).
// Same tree means same source, same lockfile and same ci.yml, so that run
// already tested exactly what main now contains.
//
// Env: SERVER_URL REPOSITORY JOB_TOKEN SHA. Writes skip=true|false to
// $GITHUB_OUTPUT and a reason line to stdout. Never exits non-zero.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const PR_CONTEXT = 'Forgejo CI / fast-gate (pull_request)';

/** Pure decision: returns { skip, reason }. */
export function decide({ parents, headTree, prTree, statuses }) {
  if (!Array.isArray(parents) || parents.length !== 2) {
    return { skip: false, reason: `not a two-parent merge commit (${parents?.length ?? 0} parents)` };
  }
  if (!headTree || !prTree) return { skip: false, reason: 'tree hash unavailable' };
  if (headTree !== prTree) {
    return { skip: false, reason: `merged tree ${headTree.slice(0, 10)} differs from PR head tree ${prTree.slice(0, 10)}: main must be tested` };
  }
  const mine = (Array.isArray(statuses) ? statuses : [])
    .filter((s) => s && s.context === PR_CONTEXT)
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (mine.length === 0) return { skip: false, reason: 'PR head has no fast-gate (pull_request) status' };
  const latest = mine[0];
  if (latest.status !== 'success') return { skip: false, reason: `latest PR run status is ${latest.status}` };
  if (latest.creator) return { skip: false, reason: 'PR status was posted by a user, not the Actions runner' };
  if (!/\/actions\/runs\/\d+/.test(String(latest.target_url ?? ''))) {
    return { skip: false, reason: 'PR status does not point at an Actions run' };
  }
  return { skip: true, reason: `tree ${headTree.slice(0, 10)} already passed fast-gate on PR head ${parents[1].slice(0, 10)} (${latest.target_url})` };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function main() {
  const { SERVER_URL, REPOSITORY, JOB_TOKEN, SHA } = process.env;
  let result = { skip: false, reason: 'not evaluated' };
  try {
    if (!SERVER_URL || !REPOSITORY || !JOB_TOKEN || !SHA) throw new Error('missing env');
    const auth = `Authorization: token ${JOB_TOKEN}`;
    execFileSync('git', ['-c', 'http.extraHeader=' + auth, 'fetch', '--no-tags', '--depth=2', 'origin', SHA], { stdio: 'ignore' });
    const parents = git('rev-list', '--parents', '-n', '1', SHA).split(' ').slice(1);
    let headTree = '';
    let prTree = '';
    let statuses = [];
    if (parents.length === 2) {
      headTree = git('rev-parse', `${SHA}^{tree}`);
      prTree = git('rev-parse', `${parents[1]}^{tree}`);
      if (headTree === prTree) {
        const res = await fetch(
          `${SERVER_URL}/api/v1/repos/${REPOSITORY}/commits/${parents[1]}/statuses?limit=50`,
          { headers: { Authorization: `token ${JOB_TOKEN}`, 'User-Agent': 'liminal-ci-reuse' } },
        );
        if (!res.ok) throw new Error(`statuses http ${res.status}`);
        statuses = await res.json();
      }
    }
    result = decide({ parents, headTree, prTree, statuses });
  } catch (err) {
    result = { skip: false, reason: `check failed (${err.message}); running the full gate` };
  }
  console.log(`reuse-pr-verdict: skip=${result.skip} reason=${result.reason}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip}\nreason=${result.reason}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## reuse-pr-verdict\n- skip: ${result.skip}\n- ${result.reason}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
