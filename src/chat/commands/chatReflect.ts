/**
 * `sinter chat reflect [N]`: the studio model distills persisted chat sessions into a taste signal,
 * recorded in HarnessMemory where GuidanceEngine reads it forward into future generations. This is the
 * chat's human signal feeding the self-improvement flywheel.
 */
export interface ChatReflectOptions {
  /** Max sessions to reflect on (default 10). */
  limit?: number;
  cwd?: string;
}

/** Runs the reflection and returns the process exit code (0 ok, 1 on any failed session or error). */
export async function runChatReflect(options: ChatReflectOptions = {}): Promise<number> {
  const { SinterFS } = await import('../../fs/index.js');
  const { LLMClient } = await import('../../llm/LLMClient.js');
  const { reflectUnreflectedSessions } = await import('../../learning/StudioReflection.js');
  const { bootstrapProductionLiminalRuntime } = await import('../../runtime-core/ProductionLiminalRuntime.js');
  const { createHash, randomUUID } = await import('node:crypto');
  const sinterFs = SinterFS.open(options.cwd ?? process.cwd());
  let runtime: Awaited<ReturnType<typeof bootstrapProductionLiminalRuntime>> | null = null;
  let exitCode = 0;
  try {
    await LLMClient.loadRoles();
    runtime = await bootstrapProductionLiminalRuntime();
    const live = runtime;
    const llm = new LLMClient({ role: 'studio' });
    // Studio transports need a role-bound product grant, like every other product call.
    const runNonce = randomUUID();
    const governed = {
      generate: (system: string, user: string, signal?: AbortSignal) => live.port.runResearchProviderEffect({
        idempotencyKey: `studio-reflect:${runNonce}:${createHash('sha256').update(system + user).digest('hex')}`,
        binding: { surface: 'cli-chat-reflect', run: runNonce },
        identity: live.identities.studio, role: 'studio', maxTransportAttempts: 1,
        effect: () => llm.generate(system, user, signal),
      }),
    };
    const limit = Math.max(1, options.limit ?? 10);
    console.log('');
    console.log('=== Chat Reflect (studio model distills persisted sessions → taste signal) ===');
    const res = await reflectUnreflectedSessions(sinterFs, governed, { limit });
    console.log(`  reflected ${res.reflected} session(s), skipped ${res.skipped}, failed ${res.failed}`);
    for (const s of res.signals) {
      console.log(`  [${s.sessionId.slice(0, 8)}] intent="${s.intentSummary.slice(0, 48)}" likes=${JSON.stringify(s.likes.slice(0, 3))} satisfaction=${s.satisfaction.toFixed(2)}`);
    }
    for (const e of res.errors) console.error(`  ✗ ${e.slice(0, 300)}`);
    if (res.reflected > 0) {
      console.log('  → recorded to HarnessMemory (GuidanceEngine reads these forward into future generations)');
    }
    if (res.failed > 0) {
      console.log('  failed sessions stay un-reflected and are retried on the next run');
      exitCode = 1;
    }
  } catch (err) {
    console.error('Chat reflect failed:', err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    sinterFs.close();
    if (runtime) await runtime.close();
  }
  return exitCode;
}
