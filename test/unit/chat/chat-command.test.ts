import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRender } = vi.hoisted(() => ({
  mockRender: vi.fn(),
}));

vi.mock('../../../src/chat/ConversationManager.js', () => ({
  ConversationManager: vi.fn().mockImplementation(function () {
    return {
      startNewSession: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/chat/ChatCLI.js', () => ({
  ChatCLI: vi.fn().mockImplementation(function () {
    return {
      render: mockRender,
    };
  }),
}));

vi.mock('../../../src/core/RalphLoop.js', () => ({
  RalphLoop: {},
}));

import { chatCommand } from '../../../src/chat/commands/chat.js';

describe('chatCommand', () => {
  const originalExitCode = process.exitCode;
  let originalIsTTYDescriptor: PropertyDescriptor | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRender.mockClear();
  });

  afterEach(() => {
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTYDescriptor);
    }
    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });

  it('refuses non-interactive stdin before rendering the long-lived chat UI', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    await chatCommand();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sinter chat requires an interactive terminal'));
    expect(process.exitCode).toBe(1);
    expect(mockRender).not.toHaveBeenCalled();
  });
});
