// RETIRED 2026-07-25: the interactive ChatCLI panel is no longer wired.
// The ConversationManager class is still used by the bridge (TuiBridgeService)
// as a message-history store (appendMessage / getConversationContext). All other
// chat/InterviewPhase machinery is test-only code; it is kept to avoid breaking
// existing tests and the ConversationManager reuse path.
//
// The living conversational surface is liminal studio (pnpm gui / node bin/sinter studio).
// liminal chat reflect remains functional (handled in bin/sinter, not here).
import { ConversationManager } from '../ConversationManager.js';
import { ChatCLI } from '../ChatCLI.js';
import { RalphLoop } from '../../core/RalphLoop.js';

export interface ChatOptions {
  verbose?: boolean;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function chatCommand(options: ChatOptions = {}): Promise<void> {
  if (process.stdin.isTTY !== true) {
    // eslint-disable-next-line no-console
    console.error('sinter chat requires an interactive terminal. Run `sinter chat` in a TTY, or use another command for scripted input.');
    process.exitCode = 1;
    return;
  }

  // Initialize ConversationManager
  const conversation = new ConversationManager();

  // Start new session
  conversation.startNewSession();

  // Initialize ChatCLI and render the UI
  const cli = new ChatCLI(conversation);
  cli.render();

  // RalphLoop is available for Phase 2 integration
  void RalphLoop;
  void options;
}
