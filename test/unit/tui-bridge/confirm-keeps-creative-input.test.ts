import { describe, expect, it, vi } from 'vitest';
import { confirmAction } from '../../../src/tui-bridge/service/InputHandling.js';
import type { TuiBridgeService } from '../../../src/tui-bridge/TuiBridgeService.js';
import type { LLMClient } from '../../../src/llm/LLMClient.js';

function makeHost(pendingAction: Record<string, unknown>) {
  const stream = vi.fn(async () => undefined);
  const emit = vi.fn();
  const host = {
    getStatus: () => ({ pendingAction }),
    sessions: { update: () => ({}) },
    emit,
    conversations: new Map([['s1', {}]]),
    streamGovernedProductCreate: stream,
  } as unknown as TuiBridgeService;
  return { host, stream, emit };
}

describe('reviewed Studio creation keeps its structured input (Sol G12)', () => {
  it('confirms a plain pending action with empty options and reports confirmation', async () => {
    const { host, stream, emit } = makeHost({ id: 'a2', title: 't', description: 'Creative: x', prompt: 'x', route: 'creative' });
    await confirmAction(host, 's1', 'a2', {} as LLMClient);
    expect(stream).toHaveBeenCalledWith('s1', 'x', expect.anything(), {});
    expect(emit).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'action.confirmed', actionId: 'a2' }));
  });
  it('rejects confirmation of an unknown action id', async () => {
    const { host, stream } = makeHost({ id: 'a3', title: 't', description: 'Creative: x', prompt: 'x', route: 'creative' });
    await expect(confirmAction(host, 's1', 'nope', {} as LLMClient)).rejects.toThrow(/not found/);
    expect(stream).not.toHaveBeenCalled();
  });
  it('passes preferences and guidance unchanged to the governed Create on confirmation', async () => {
    const options = { creativePreferences: { palette: 'ember', priorRunReceipt: 'r-1' }, guidanceAnswers: { mood: 'quiet' } };
    const pendingAction = { id: 'a1', title: 't', description: 'Creative: an ember tide', prompt: 'an ember tide',
      route: 'creative' as const, kind: 'llm' as const, requiresConfirmation: true as const, createdAt: 'now', creativeOptions: options };
    const stream = vi.fn(async () => undefined);
    const host = {
      getStatus: () => ({ pendingAction }),
      sessions: { update: () => ({}) },
      emit: vi.fn(),
      conversations: new Map([['s1', {}]]),
      streamGovernedProductCreate: stream,
    } as unknown as TuiBridgeService;
    await confirmAction(host, 's1', 'a1', {} as LLMClient);
    expect(stream).toHaveBeenCalledWith('s1', 'an ember tide', expect.anything(), options);
  });
});
