import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalCliSeatUrl } from '../../../src/identity/cliSeatUrl.js';
import { bootstrapExecutorAuthority, classifyProviderSurface } from '../../../src/identity/executorAuthorityBootstrap.js';

// #1590: a seat URL that carries its effort (cli://claude/high, cli://codex/xhigh)
// must reach the same subscription admission as the bare seat.

describe('cli seat admission', () => {
  it.each(['cli://codex/xhigh', 'cli://codex/high/chat/completions', 'cli://claude/max', 'cli://claude/chat/completions'])(
    'canonicalises %s to its bare seat', (url) => {
      expect(canonicalCliSeatUrl(url)).toBe(url.startsWith('cli://codex') ? 'cli://codex' : 'cli://claude');
    });

  it('does not strip a non-effort segment', () => {
    expect(canonicalCliSeatUrl('cli://codex/turbo')).toBe('cli://codex/turbo');
  });

  it.each(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol'])('admits codex model %s at any seat effort', (model) => {
    expect(classifyProviderSurface('cli', 'cli://codex/xhigh', { model })).toBe('codex-cli-seat');
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5'])('admits Claude Code model %s as a subscription seat', (model) => {
    expect(classifyProviderSurface('cli', 'cli://claude/high', { model })).toBe('claude-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://claude', { model })).toBe('claude-cli-seat');
  });

  it('keeps an unlisted Claude model fail-closed', () => {
    expect(classifyProviderSurface('cli', 'cli://claude/high', { model: 'claude-mystery' })).toBe('unknown');
  });
});

describe('claude-cli-seat funding', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('binds to subscription funding with its own quota surface', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'claude-seat-'));
    dirs.push(rootDir);
    const authority = bootstrapExecutorAuthority({ rootDir });
    const identity = { provider: 'cli' as const, model: 'claude-fable-5-2', effort: 'high' as const, alias: 'claude-fable-5-2' };
    const reservation = await authority.reserveAttempt({
      role: 'generator' as const, requestDigest: 'r', routeDigest: 'rt',
      requestedIdentity: identity, resolvedIdentity: identity, phase: 'pre-primary-transport' as const,
      fallbackOrdinal: 0, retryOrdinal: 0, attemptOrdinal: 0, priorTraceDigest: null,
      policyTraceDigest: 'p', fallbackChain: [{ ordinal: 0, identity }],
      surface: 'claude-cli-seat' as const, seatDigest: 'c'.repeat(64),
    } as never);
    expect(reservation?.subject.funding).toMatchObject({ mode: 'subscription-seat', quotaSurface: 'claude-cli-seat' });
  });
});

describe('cli://claude through LLMClient', () => {
  it.each([['cli://claude/high', 'claude-fable-5-2'], ['cli://codex/xhigh/chat/completions', 'gpt-6-astra']])(
    'passes URL validation and attests %s as a subscription seat', async (baseUrl, model) => {
      const { chmodSync, writeFileSync } = await import('node:fs');
      const { LLMClient } = await import('../../../src/llm/LLMClient.js');
      const directory = mkdtempSync(join(tmpdir(), 'claude-seat-e2e-'));
      const executable = join(directory, 'seat');
      const reply = baseUrl.startsWith('cli://codex')
        ? `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"generated artwork"}}'`
        : 'printf "generated artwork"';
      writeFileSync(executable, `#!/bin/sh\n${reply}\n`);
      chmodSync(executable, 0o700);
      const saved = { CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN };
      process.env.CLAUDE_BIN = executable;
      process.env.CODEX_BIN = executable;
      try {
        const authority = bootstrapExecutorAuthority({ rootDir: join(directory, 'authority') });
        const client = new LLMClient({ role: 'generator', provider: 'cli', baseUrl, model,
          timeout: 3000, harnessTransportAuthority: authority } as never);
        const result = await client.complete({ systemPrompt: 'system', prompt: 'art' });
        expect(result).toMatchObject({ success: true, text: 'generated artwork' });
        const surface = baseUrl.startsWith('cli://claude') ? 'claude-cli-seat' : 'codex-cli-seat';
        expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'verified',
          attempts: [{ attestation: { subject: { surface, funding: { mode: 'subscription-seat', quotaSurface: surface } } } }] });
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        rmSync(directory, { recursive: true, force: true });
      }
    });
});
