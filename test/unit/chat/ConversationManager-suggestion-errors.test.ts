import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../../../src/chat/ConversationManager.js';
import type { Suggestion } from '../../../src/chat/types.js';
import { Logger } from '../../../src/utils/Logger.js';

const suggestion = (action?: Suggestion['action']): Suggestion => ({
  type: 'archive', title: 'Apply learned taste', description: 'Use restraint',
  priority: 'medium', action,
});
const failureMessage = '[Suggestion failed] Apply learned taste: action could not be applied. Generation will continue.';

describe('ConversationManager suggestion failures', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['throw', 'reject'])('reports a suggestion action that fails by %s', async mode => {
    const manager = new ConversationManager();
    manager.startNewSession();
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const action = mode === 'throw'
      ? () => { throw new Error('secret-provider-response'); }
      : () => Promise.reject(new Error('secret-provider-response'));
    await expect(manager.applySuggestion(suggestion(action))).resolves.toBeUndefined();
    expect(manager.getCurrentSessionMessages()).toEqual([
      expect.objectContaining({ role: 'system', content: failureMessage }),
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith('ConversationManager',
      'Suggestion action failed; generation will continue.', { type: 'archive' });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-provider-response');
    expect(manager.getConversationContext()).not.toContain('secret-provider-response');
  });

  it('does not report a successful action or an absent action as a failure', async () => {
    const manager = new ConversationManager();
    manager.startNewSession();
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const action = vi.fn().mockResolvedValue(undefined);
    await manager.applySuggestion(suggestion(action));
    await manager.applySuggestion(suggestion());
    expect(action).toHaveBeenCalledExactlyOnceWith();
    expect(warning).not.toHaveBeenCalled();
    expect(manager.getCurrentSessionMessages()).toEqual([]);
  });

  it('reports a failure without an active session without rejecting', async () => {
    const manager = new ConversationManager();
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    await expect(manager.applySuggestion(suggestion(() => Promise.reject('offline'))))
      .resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledExactlyOnceWith('ConversationManager',
      'Suggestion action failed; generation will continue.', { type: 'archive' });
    expect(manager.getCurrentSessionMessages()).toEqual([]);
  });

  it('keeps a delayed failure out of a replacement session', async () => {
    const manager = new ConversationManager();
    manager.startNewSession();
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const action = new Promise<unknown>((_, fail) => { reject = fail; });
    const pending = manager.applySuggestion(suggestion(() => action));
    manager.startNewSession();
    reject(new Error('old-session-failure'));
    await pending;
    expect(manager.getCurrentSessionMessages()).toEqual([]);
    expect(warning).toHaveBeenCalledExactlyOnceWith('ConversationManager',
      'Suggestion action failed; generation will continue.', { type: 'archive' });
  });
});
