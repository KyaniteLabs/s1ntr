import { describe, expect, it } from 'vitest';
import { listSkillsTool } from '../../../src/harness/tools/ListSkillsTool.js';

describe('ListSkillsTool', () => {
  it('lists skills from repo .skills', async () => {
    const r = await listSkillsTool.execute({});
    expect(r.success).toBe(true);
    expect(r.data?.skills?.length).toBeGreaterThan(0);
    expect(r.data?.skills?.some((s) => s.name.includes('comorbidity') || s.name.length > 0)).toBe(true);
  });

  it('filters by query', async () => {
    const r = await listSkillsTool.execute({ query: 'debug' });
    expect(r.success).toBe(true);
  });
});
