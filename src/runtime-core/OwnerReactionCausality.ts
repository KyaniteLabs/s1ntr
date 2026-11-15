import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type OwnerReactionAction = 'pin' | 'reject';
export type OwnerReactionSource = 'studio-ui' | 'cli';

export interface OwnerSessionReceipt {
  ownerSessionId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface OwnerArtifactBinding {
  ownerSessionId: string;
  nonce: string;
  artifactId: string;
  artifactDigest: string;
  lineageId: string;
  revision: number;
  sourceFingerprint: string;
}

export interface OwnerReactionReceipt extends OwnerArtifactBinding {
  action: OwnerReactionAction;
  source: OwnerReactionSource;
  eventId: string;
  occurredAt: string;
  reactionDigest: string;
}

export interface NextCreateReactionContext {
  reactionDigest: string;
  hypothesis: string;
  hypothesisDigest: string;
  quotedContext: string;
  contextDigest: string;
  expiresAt: string;
}

export class OwnerReactionError extends Error {
  constructor(readonly code: string) {
    super(`OWNER_REACTION_${code}`);
    this.name = 'OwnerReactionError';
  }
}

export interface OwnerReactionCausalityOptions {
  now?: () => number;
  nonce?: () => string;
  ttlMs?: number;
  persistPath?: string;
}

export interface OwnerReactionSnapshot {
  session?: OwnerSessionReceipt;
  artifact?: OwnerArtifactBinding;
  reactions: OwnerReactionReceipt[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export class OwnerReactionCausality {
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly ttlMs: number;
  private readonly persistPath?: string;
  private readonly sessions = new Map<string, OwnerSessionReceipt>();
  private readonly artifacts = new Map<string, OwnerArtifactBinding>();
  private readonly events = new Set<string>();
  private readonly reactions = new Map<string, OwnerReactionReceipt>();

  constructor(options: OwnerReactionCausalityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString('hex'));
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.persistPath = options.persistPath;
    this.load();
  }

  openSession(ownerSessionId: string): OwnerSessionReceipt {
    if (!ownerSessionId.trim()) throw new OwnerReactionError('INVALID_SESSION');
    const issued = this.now();
    const receipt = {
      ownerSessionId,
      nonce: this.nonce(),
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + this.ttlMs).toISOString(),
    };
    this.sessions.set(ownerSessionId, receipt);
    this.persist();
    return Object.freeze(receipt);
  }

  bindArtifact(binding: OwnerArtifactBinding): OwnerArtifactBinding {
    this.assertSession(binding.ownerSessionId, binding.nonce);
    if (!binding.artifactId.trim() || !binding.lineageId.trim()) throw new OwnerReactionError('INVALID_ARTIFACT');
    if (!isSha256(binding.artifactDigest) || !isSha256(binding.sourceFingerprint)) throw new OwnerReactionError('INVALID_DIGEST');
    if (!Number.isInteger(binding.revision) || binding.revision < 1) throw new OwnerReactionError('INVALID_REVISION');
    const frozen = Object.freeze({ ...binding });
    this.artifacts.set(binding.ownerSessionId, frozen);
    this.persist();
    return frozen;
  }

  record(input: {
    ownerSessionId: string;
    nonce: string;
    artifactId: string;
    action: OwnerReactionAction;
    source: OwnerReactionSource;
    eventId: string;
    occurredAt: string;
  }): OwnerReactionReceipt {
    this.assertSession(input.ownerSessionId, input.nonce);
    if (input.source !== 'studio-ui' && input.source !== 'cli') throw new OwnerReactionError('INVALID_SOURCE');
    if (!input.eventId.trim()) throw new OwnerReactionError('INVALID_EVENT');
    if (this.events.has(input.eventId)) throw new OwnerReactionError('REPLAYED_EVENT');
    const occurred = Date.parse(input.occurredAt);
    if (!Number.isFinite(occurred) || Math.abs(this.now() - occurred) > 5 * 60 * 1000) {
      throw new OwnerReactionError('STALE_EVENT');
    }
    const artifact = this.artifacts.get(input.ownerSessionId);
    if (!artifact || artifact.artifactId !== input.artifactId || artifact.nonce !== input.nonce) {
      throw new OwnerReactionError('ARTIFACT_MISMATCH');
    }
    const body = { ...artifact, action: input.action, source: input.source, eventId: input.eventId, occurredAt: input.occurredAt };
    const receipt = Object.freeze({ ...body, reactionDigest: digest(body) });
    this.events.add(input.eventId);
    this.reactions.set(receipt.reactionDigest, receipt);
    this.persist();
    return receipt;
  }

  resolveNextCreateContext(ownerSessionId: string, reactionDigest: string): NextCreateReactionContext {
    const reaction = this.reactions.get(reactionDigest);
    if (!reaction || reaction.ownerSessionId !== ownerSessionId) throw new OwnerReactionError('REACTION_NOT_FOUND');
    const session = this.assertSession(ownerSessionId, reaction.nonce);
    const hypothesis = reaction.action === 'pin'
      ? `Preserve and deepen the qualities expressed by artifact ${reaction.artifactDigest}.`
      : `Avoid the rejected qualities expressed by artifact ${reaction.artifactDigest}; explore a materially different solution.`;
    const hypothesisDigest = digest({ reactionDigest, hypothesis });
    const quotedContext = [
      '[BEGIN VERIFIED OWNER REACTION]',
      JSON.stringify({ reactionDigest, action: reaction.action, artifactDigest: reaction.artifactDigest, hypothesis, hypothesisDigest }),
      '[END VERIFIED OWNER REACTION]',
    ].join('\n');
    const expiresAt = session.expiresAt;
    return Object.freeze({ reactionDigest, hypothesis, hypothesisDigest, quotedContext, contextDigest: digest(quotedContext), expiresAt });
  }

  currentArtifact(ownerSessionId: string): OwnerArtifactBinding | undefined {
    return this.artifacts.get(ownerSessionId);
  }

  snapshot(ownerSessionId: string): OwnerReactionSnapshot {
    return {
      session: this.sessions.get(ownerSessionId),
      artifact: this.artifacts.get(ownerSessionId),
      reactions: [...this.reactions.values()].filter(item => item.ownerSessionId === ownerSessionId),
    };
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const value = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as {
        sessions?: OwnerSessionReceipt[]; artifacts?: OwnerArtifactBinding[];
        reactions?: OwnerReactionReceipt[]; events?: string[];
      };
      for (const item of value.sessions ?? []) this.sessions.set(item.ownerSessionId, item);
      for (const item of value.artifacts ?? []) this.artifacts.set(item.ownerSessionId, item);
      for (const item of value.reactions ?? []) this.reactions.set(item.reactionDigest, item);
      for (const item of value.events ?? []) this.events.add(item);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new OwnerReactionError('PERSISTENCE_CORRUPT');
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    const temporary = `${this.persistPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1, sessions: [...this.sessions.values()], artifacts: [...this.artifacts.values()],
      reactions: [...this.reactions.values()], events: [...this.events],
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.persistPath);
  }

  private assertSession(ownerSessionId: string, nonce: string): OwnerSessionReceipt {
    const session = this.sessions.get(ownerSessionId);
    if (!session || session.nonce !== nonce) throw new OwnerReactionError('SESSION_MISMATCH');
    if (this.now() > Date.parse(session.expiresAt)) throw new OwnerReactionError('SESSION_EXPIRED');
    return session;
  }
}
