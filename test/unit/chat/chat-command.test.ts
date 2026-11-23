import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReflect } = vi.hoisted(() => ({ mockReflect: vi.fn() }));
vi.mock('../../../src/chat/commands/chatReflect.js', () => ({ runChatReflect: mockReflect }));

import { chatCommand } from '../../../src/chat/commands/chat.js';

describe('chatCommand (old name for chat reflect)', () => {
  const originalExitCode = process.exitCode;
  beforeEach(() => { process.exitCode = undefined; mockReflect.mockReset(); });
  afterEach(() => { process.exitCode = originalExitCode; });

  it('delegates to chat reflect with the requested session limit', async () => {
    mockReflect.mockResolvedValue(0);
    await chatCommand({ limit: 3 });
    expect(mockReflect).toHaveBeenCalledWith({ limit: 3 });
    expect(process.exitCode).toBeUndefined();
  });

  it('carries a failed reflection into the process exit code', async () => {
    mockReflect.mockResolvedValue(1);
    await chatCommand();
    expect(process.exitCode).toBe(1);
  });
});
