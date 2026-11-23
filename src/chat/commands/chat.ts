// `sinter chat` is the old name for `sinter chat reflect`; both run the same studio reflection.
// The interactive ChatCLI panel was retired 2026-07-24 (the living conversational surface is
// `sinter studio`). ConversationManager stays: the bridge (TuiBridgeService) uses it as a history store.
import { runChatReflect } from './chatReflect.js';

export interface ChatOptions {
  verbose?: boolean;
  /** Max sessions to reflect on. */
  limit?: number;
}

export async function chatCommand(options: ChatOptions = {}): Promise<void> {
  const code = await runChatReflect({ limit: options.limit });
  if (code !== 0) process.exitCode = code;
}
