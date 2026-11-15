import { describe, expect, it } from 'vitest';
import { ownerReviewerSystemPrompt } from '../../../src/creative-run/OwnerReviewLifecycle.js';
import { digestCampaignProviderEndpoint } from '../../../src/creative-run/CampaignExecutionAuthority.js';

describe('owner reviewer transport scope', () => {
  it.each(['specialist', 'holistic'] as const)('%s never claims media perception over text transport', (role) => {
    const prompt = ownerReviewerSystemPrompt(role);
    expect(prompt).toContain('blind owner');
    expect(prompt).toMatch(/Do not claim|never claim/);
    expect(prompt).toContain('visual');
    expect(prompt).toContain('audio');
  });

  it('keeps the two independent evidence roles distinct', () => {
    expect(ownerReviewerSystemPrompt('specialist')).toContain('source, runtime, clock');
    expect(ownerReviewerSystemPrompt('holistic')).toContain('cross-modal coherence');
    expect(ownerReviewerSystemPrompt('holistic')).toContain('text transport cannot render, play, or interact');
  });

  it('binds kimi coding capacity to a distinct endpoint digest from classic moonshot /v1', () => {
    // Wave 8 product freeze funds holistic/kimi-k3 at api.kimi.com/coding/v1.
    // Classic moonshot-direct default (api.moonshot.ai/v1) must not silently
    // share that digest or CAMPAIGN_FUNDING_TRANSPORT_BINDING_MISMATCH fires.
    const coding = digestCampaignProviderEndpoint('https://api.kimi.com/coding/v1');
    const classic = digestCampaignProviderEndpoint('https://api.moonshot.ai/v1');
    expect(coding).toMatch(/^[a-f0-9]{64}$/);
    expect(classic).toMatch(/^[a-f0-9]{64}$/);
    expect(coding).not.toBe(classic);
    expect(coding).toBe('f5acde8ba5d28ed325557d2d0afc837363987e8e599c77d9e38c1d0d2548050d');
  });
});
