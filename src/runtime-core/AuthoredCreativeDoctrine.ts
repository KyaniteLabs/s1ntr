import { createHash } from 'node:crypto';

const DIGEST = /^[a-f0-9]{64}$/;
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');

export interface AuthoredCreativeDoctrineInput {
  readonly version: number;
  readonly sourceReviewDigest: string;
  readonly scope: readonly string[];
  readonly principles: readonly string[];
  readonly promptContracts: readonly string[];
  readonly vocabulary: readonly string[];
}

export interface AuthoredCreativeDoctrine extends AuthoredCreativeDoctrineInput {
  readonly namespace: 'authored-doctrine';
  readonly doctrineDigest: string;
}

export interface DoctrineUpdateReceipt {
  readonly eventType: 'doctrine-input-changed';
  readonly learnedFindingEvent: false;
  readonly previousDoctrineDigest: string | null;
  readonly inputDeltaDigest: string;
  readonly record: AuthoredCreativeDoctrine;
}

export interface QuarantinedSemanticRecord {
  readonly digest: string;
  readonly bytesBase64: string;
  readonly classification: 'quarantined';
}

export class AuthoredCreativeDoctrineStore {
  readonly #records = new Map<string, AuthoredCreativeDoctrine>();
  readonly #versions = new Map<number, string>();
  readonly #legacy = new Map<string, QuarantinedSemanticRecord>();
  #latest: string | null = null;

  register(input: AuthoredCreativeDoctrineInput): DoctrineUpdateReceipt {
    this.validate(input);
    const body = {
      namespace: 'authored-doctrine' as const, version: input.version,
      sourceReviewDigest: input.sourceReviewDigest,
      scope: Object.freeze([...input.scope]),
      principles: Object.freeze([...input.principles]),
      promptContracts: Object.freeze([...input.promptContracts]),
      vocabulary: Object.freeze([...input.vocabulary]),
    };
    const record = Object.freeze({ ...body, doctrineDigest: digest(body) });
    const versionDigest = this.#versions.get(input.version);
    if (versionDigest && versionDigest !== record.doctrineDigest) {
      throw new Error('AUTHORED_DOCTRINE_VERSION_REBOUND');
    }
    if (this.#latest && input.version <= this.#records.get(this.#latest)!.version
      && !versionDigest) throw new Error('AUTHORED_DOCTRINE_VERSION_NOT_MONOTONIC');
    const previousDoctrineDigest = this.#latest;
    this.#records.set(record.doctrineDigest, record);
    this.#versions.set(input.version, record.doctrineDigest);
    this.#latest = record.doctrineDigest;
    return Object.freeze({ eventType: 'doctrine-input-changed' as const,
      learnedFindingEvent: false as const, previousDoctrineDigest,
      inputDeltaDigest: digest({ previousDoctrineDigest,
        doctrineDigest: record.doctrineDigest }), record });
  }

  read(doctrineDigest: string): AuthoredCreativeDoctrine | undefined {
    return this.#records.get(doctrineDigest);
  }

  list(): readonly AuthoredCreativeDoctrine[] {
    return Object.freeze([...this.#records.values()]);
  }

  quarantineLegacy(bytes: Uint8Array): QuarantinedSemanticRecord {
    const rawDigest = createHash('sha256').update(bytes).digest('hex');
    const record = Object.freeze({ digest: rawDigest,
      bytesBase64: Buffer.from(bytes).toString('base64'),
      classification: 'quarantined' as const });
    this.#legacy.set(rawDigest, record);
    return record;
  }

  private validate(input: AuthoredCreativeDoctrineInput): void {
    if (!Number.isSafeInteger(input.version) || input.version < 1
      || !DIGEST.test(input.sourceReviewDigest) || input.scope.length === 0
      || input.principles.length === 0 || input.promptContracts.length === 0
      || input.vocabulary.length === 0
      || [...input.scope, ...input.principles, ...input.promptContracts,
        ...input.vocabulary].some(value => !value.trim())) {
      throw new Error('AUTHORED_CREATIVE_DOCTRINE_INVALID');
    }
  }
}
