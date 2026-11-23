import { describe, expect, it } from 'vitest';
import { decide, PR_CONTEXT } from '../../scripts/ci/reuse-pr-verdict.mjs';

const green = { id: 3, context: PR_CONTEXT, status: 'success', creator: null, target_url: '/KyaniteLabs/liminal/actions/runs/3484/jobs/0' };
const base = { parents: ['a'.repeat(40), 'b'.repeat(40)], headTree: 't'.repeat(40), prTree: 't'.repeat(40), statuses: [green] };

describe('reuse-pr-verdict decide', () => {
  it('reuses only an identical tree with a runner-posted green PR status', () => {
    expect(decide(base).skip).toBe(true);
  });
  it('runs main when the merged tree differs from the PR head tree', () => {
    expect(decide({ ...base, prTree: 'u'.repeat(40) }).skip).toBe(false);
  });
  it('runs main for a non-merge commit', () => {
    expect(decide({ ...base, parents: ['a'.repeat(40)] }).skip).toBe(false);
  });
  it('runs main when the PR status is missing, failed, newer-failed, forged or not an Actions run', () => {
    expect(decide({ ...base, statuses: [] }).skip).toBe(false);
    expect(decide({ ...base, statuses: [{ ...green, status: 'failure' }] }).skip).toBe(false);
    expect(decide({ ...base, statuses: [green, { ...green, id: 9, status: 'failure' }] }).skip).toBe(false);
    expect(decide({ ...base, statuses: [{ ...green, creator: { login: 'someone' } }] }).skip).toBe(false);
    expect(decide({ ...base, statuses: [{ ...green, target_url: 'https://example.com' }] }).skip).toBe(false);
    expect(decide({ ...base, statuses: [{ ...green, context: 'other' }] }).skip).toBe(false);
  });
  it('runs main when tree hashes are unavailable', () => {
    expect(decide({ ...base, headTree: '' }).skip).toBe(false);
  });
});
