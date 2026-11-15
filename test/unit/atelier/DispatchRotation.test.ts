import { describe, expect, it } from 'vitest';
import { auditRotation, executorForLane } from '../../../src/atelier/DispatchRotation.js';

describe('Dispatch rotation health', () => {
  it('maps only exact art adapters and model IDs', () => {
    expect(executorForLane({ modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' })).toBe('zai-glm');
    expect(executorForLane({ modelId: 'minimax-m3', provider: 'openai', baseUrl: 'https://api.minimax.io/v1' })).toBe('minimax-m3');
    expect(executorForLane({ modelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507', provider: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai' })).toBeNull();
    expect(executorForLane({ modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://other.example/v1' })).toBeNull();
    expect(executorForLane({ modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://other.example/api.z.ai/' })).toBeNull();
    expect(executorForLane({ modelId: 'gpt-5.6-sol', provider: 'cli', baseUrl: 'cli://codex' })).toBe('codex-sol');
    expect(executorForLane({ modelId: 'gpt-5.6-sol', provider: 'cli', baseUrl: 'cli://codex/chat/completions' })).toBe('codex-sol');
    expect(executorForLane({ modelId: 'gpt-6-luna', provider: 'cli', baseUrl: 'cli://codex' })).toBe('codex-luna');
    expect(executorForLane({ modelId: 'qwen/qwen3.8-27b:free', provider: 'openai', baseUrl: 'https://api.kilo.ai/api/gateway' })).toBe('kilo-free-auto');
    expect(executorForLane({ modelId: 'qwen/qwen3.8-27b:free', provider: 'openai', baseUrl: 'https://api.kilo.ai/v1' })).toBeNull();
    expect(executorForLane({ modelId: 'gemini-3.7-flash-medium', provider: 'cli', baseUrl: 'cli://agy' })).toBe('agy-gemini-flash');
    expect(executorForLane({ modelId: 'gemini-3.7-flash-medium', provider: 'cli', baseUrl: 'cli://agy/chat/completions' })).toBe('agy-gemini-flash');
    expect(executorForLane({ modelId: 'gemini-3.8-flash-high', provider: 'cli', baseUrl: 'cli://agy' })).toBeNull();
    expect(executorForLane({ modelId: 'deepseek/deepseek-v4-pro', provider: 'cli', baseUrl: 'cli://command-code' })).toBe('command-code');
    expect(executorForLane({ modelId: 'deepseek/deepseek-v4-pro', provider: 'cli', baseUrl: 'cli://command-code/chat/completions' })).toBe('command-code');
    expect(executorForLane({ modelId: 'deepseek/deepseek-v4-flash', provider: 'cli', baseUrl: 'cli://command-code/chat/completions' })).toBeNull();
    expect(executorForLane({ modelId: 'gpt-5.6-sol', provider: 'cli', baseUrl: 'cli://codex/other/chat/completions' })).toBeNull();
    expect(executorForLane({ modelId: 'deepseek/deepseek-v4-pro', provider: 'openai', baseUrl: 'cli://command-code' })).toBeNull();
    expect(executorForLane({ modelId: 'deepseek/deepseek-v4-flash', provider: 'cli', baseUrl: 'cli://command-code' })).toBeNull();
    expect(executorForLane({ modelId: 'gpt-6-sol', provider: 'cli', baseUrl: 'cli://codex' })).toBeNull();
    expect(executorForLane({ modelId: 'gpt-5.6-sol', provider: 'cli', baseUrl: 'cli://codex-other' })).toBeNull();
  });

  it('holds unavailable, cooling, unmapped, and unknown doctor lanes', () => {
    const lanes = [
      { modelId: 'glm-5.3', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' },
      { modelId: 'minimax-m3', provider: 'openai', baseUrl: 'https://api.minimax.io/v1' },
      { modelId: 'unknown', provider: 'openai' },
    ];
    const doctor = [
      { executor: 'zai-glm', available: true },
      { executor: 'minimax-m3', available: true, cooldown: true },
    ];
    expect(auditRotation(lanes, doctor).map(lane => lane.status)).toEqual(['available', 'unavailable', 'unmapped']);
    expect(auditRotation(lanes, null).map(lane => lane.status)).toEqual(['doctor-unavailable', 'doctor-unavailable', 'unmapped']);
  });

  it('requires an exact LAN HTTP lane and honors its CS availability gate', () => {
    const lane = { modelId: 'Qwen3.8-27B', provider: 'openai', baseUrl: 'http://example.internal:46380/v1', dispatchExecutor: 'lan-champion' };
    expect(executorForLane(lane)).toBe('lan-champion');
    expect(executorForLane({ ...lane, dispatchExecutor: undefined })).toBeNull();
    expect(executorForLane({ ...lane, modelId: 'qwen3.8-27b' })).toBeNull();
    expect(auditRotation([lane], [{ executor: 'lan-champion', available: false }])[0]?.status).toBe('unavailable');
    expect(auditRotation([lane], [{ executor: 'lan-champion', available: true }])[0]?.status).toBe('available');
  });
});
