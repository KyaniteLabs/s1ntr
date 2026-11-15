import { describe, expect, it } from 'vitest';

import { getSelfImprovePrompt } from '../../src/harness/prompts/self-improve.js';

describe('self-improve prompt tool contract', () => {
  it('explicitly redirects shell-like tool calls to harness tools', () => {
    const prompt = getSelfImprovePrompt();

    expect(prompt).toContain('No shell tool exists');
    expect(prompt).toContain('never use "execute"');
    // executeSkill loads instructions only — cannot run shell; same contract.
    expect(prompt).toMatch(/cannot run shell/);
    expect(prompt).toContain('gitStatus');
    expect(prompt).toContain('runFocusedTests');
  });
});
