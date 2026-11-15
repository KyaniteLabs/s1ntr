import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockDetectModelTier, mockGetModelProfile } = vi.hoisted(() => ({
  mockDetectModelTier: vi.fn(),
  mockGetModelProfile: vi.fn(),
}));

vi.mock('../../../src/llm/ModelTier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/llm/ModelTier.js')>();
  return {
    ...actual,
    detectModelTier: mockDetectModelTier,
    getModelProfile: mockGetModelProfile,
  };
});

import {
  AUDIT_STANCE_MAX_CHARS,
  GENERATOR_AUDIT_STANCE,
  EVALUATOR_AUDIT_STANCE,
  STUDIO_AUDIT_STANCE,
  HARNESS_AUDIT_STANCE,
  SHARED_AUDIT_SPINE,
  auditStanceBlock,
} from '../../../src/prompts/AuditStance.js';
import { PromptBuilder } from '../../../src/llm/PromptBuilder.js';
import type { LLMConfig } from '../../../src/llm/LLMClient.js';
import { CHAT_SYSTEM_PROMPT } from '../../../src/prompts/specialized/chat.js';
import { EVALUATION_SYSTEM_PROMPT } from '../../../src/prompts/specialized/evaluation.js';
import { SELF_IMPROVE_SYSTEM_PROMPT } from '../../../src/harness/prompts/self-improve.js';

describe('AuditStance', () => {
  const roles = ['generator', 'evaluator', 'harness', 'studio'] as const;

  beforeEach(() => {
    mockDetectModelTier.mockReturnValue('flagship');
    mockGetModelProfile.mockReturnValue({
      tier: 'flagship',
      contextWindow: 100000,
      recommendedContextTokens: 8000,
      supportsSystemPrompt: true,
      needsExplicitInstructions: false,
      fewShotExamples: 0,
    });
  });

  it('includes shared spine + role stance for every seat', () => {
    for (const role of roles) {
      const block = auditStanceBlock(role);
      expect(block).toContain(`<audit_stance role="${role}">`);
      expect(block).toContain(SHARED_AUDIT_SPINE.slice(0, 40));
      expect(block).toMatch(/observed/);
      expect(block).toMatch(/inferred/);
      expect(block).toMatch(/guessed/);
      expect(block.toLowerCase()).toContain("can't tell");
      expect(block.length).toBeLessThan(AUDIT_STANCE_MAX_CHARS);
    }
  });

  it('role stances are distinct and non-empty', () => {
    expect(GENERATOR_AUDIT_STANCE).toMatch(/self-audit/i);
    expect(EVALUATOR_AUDIT_STANCE).toMatch(/adversarial/i);
    expect(STUDIO_AUDIT_STANCE).toMatch(/hard thing/i);
    expect(HARNESS_AUDIT_STANCE).toMatch(/tour-leg|K3/i);
  });

  it('does not interpolate secrets or env-looking tokens', () => {
    for (const role of roles) {
      const block = auditStanceBlock(role);
      expect(block).not.toMatch(/API_KEY|sk-|Bearer |password|secret/i);
      expect(block).not.toContain('${');
      expect(block).not.toContain(process.env.HOME ?? '___no_home___');
    }
  });

  it('PromptBuilder generator system includes generator audit stance', () => {
    const config: LLMConfig = { baseUrl: 'http://localhost:11434/v1', model: 'test-model' };
    const builder = new PromptBuilder(config);
    const built = builder.build({
      userRequest: 'make a circle',
      domain: 'p5',
      soul: 'You are Sinter.',
      rules: 'Output valid code.',
    });
    expect(built.system).toContain('<audit_stance role="generator">');
    expect(built.system).toContain(GENERATOR_AUDIT_STANCE.slice(0, 20));
    expect(built.system).toContain(SHARED_AUDIT_SPINE.slice(0, 20));
  });

  it('chat / evaluation / harness surfaces include their stance', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('<audit_stance role="studio">');
    expect(CHAT_SYSTEM_PROMPT).toContain(STUDIO_AUDIT_STANCE.slice(0, 20));
    expect(EVALUATION_SYSTEM_PROMPT).toContain('<audit_stance role="evaluator">');
    expect(EVALUATION_SYSTEM_PROMPT).toContain(EVALUATOR_AUDIT_STANCE.slice(0, 20));
    expect(SELF_IMPROVE_SYSTEM_PROMPT).toContain('<audit_stance role="harness">');
    expect(SELF_IMPROVE_SYSTEM_PROMPT).toContain(HARNESS_AUDIT_STANCE.slice(0, 20));
  });

  it('assembled role prompts stay length-bounded', () => {
    expect(CHAT_SYSTEM_PROMPT.length).toBeLessThan(4000);
    expect(EVALUATION_SYSTEM_PROMPT.length).toBeLessThan(5000);
    // Bound tracks harness audit-stance + skill catalog growth (#379 seats).
    expect(SELF_IMPROVE_SYSTEM_PROMPT.length).toBeLessThan(4500);
  });
});
