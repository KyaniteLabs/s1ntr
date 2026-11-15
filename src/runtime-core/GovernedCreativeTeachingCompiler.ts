import { createHash } from 'node:crypto';
import { KnowledgeApplication } from
  '../dreaming/research/DreamKnowledgeActivation.js';
import type { LiminalCreativeCommand } from './LiminalCommandService.js';
import type { LiminalTeachingCompiler } from './LiminalProductCommandPort.js';
import type { AuthoredCreativeDoctrineStore } from './AuthoredCreativeDoctrine.js';

const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
const byteDigest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Sole product adapter for source-reviewed doctrine and activated empirical knowledge. */
export class GovernedCreativeTeachingCompiler implements LiminalTeachingCompiler {
  constructor(private readonly application?: KnowledgeApplication,
    private readonly doctrine?: AuthoredCreativeDoctrineStore) {}

  compile(command: LiminalCreativeCommand) {
    return new Promise<ReturnType<typeof this.compileCategories>>(resolve => {
      if (!command.teaching) throw new Error('LIMINAL_TEACHING_REQUEST_REQUIRED');
      const keys = Object.keys(command.teaching).sort();
      if (keys.some(key => !['doctrineDigest', 'snapshotDigest', 'targetScope'].includes(key))
        || (!command.teaching.snapshotDigest && !command.teaching.doctrineDigest)) {
        throw new Error('LIMINAL_TEACHING_CATEGORY_UNCLASSIFIED');
      }
      resolve(this.compileCategories(command));
    });
  }

  private compileCategories(command: LiminalCreativeCommand) {
    const teaching = command.teaching!;
    let providerInput = command.prompt;
    let doctrineReceipt: { doctrineDigest: string; sourceReviewDigest: string;
      inputDeltaDigest: string } | undefined;
    if (teaching.doctrineDigest) {
      const doctrine = this.doctrine?.read(teaching.doctrineDigest);
      if (!doctrine) throw new Error('LIMINAL_DOCTRINE_NOT_FOUND');
      if (!doctrine.scope.includes(teaching.targetScope)) {
        throw new Error('LIMINAL_DOCTRINE_SCOPE_MISMATCH');
      }
      const delta = [...doctrine.principles, ...doctrine.promptContracts,
        `Vocabulary: ${doctrine.vocabulary.join(', ')}`].join('\n');
      providerInput = `${providerInput}\n\nAuthored creative doctrine:\n${delta}`;
      doctrineReceipt = Object.freeze({ doctrineDigest: doctrine.doctrineDigest,
        sourceReviewDigest: doctrine.sourceReviewDigest,
        inputDeltaDigest: digest(delta) });
    }
    const empirical = teaching.snapshotDigest
      ? this.applyEmpirical(command, providerInput, teaching.snapshotDigest,
        teaching.targetScope) : undefined;
    if (empirical) providerInput = empirical.finalProviderInput;
    return this.finish(command, providerInput, doctrineReceipt, empirical);
  }

  private applyEmpirical(command: LiminalCreativeCommand, providerInput: string,
    snapshotDigest: string, targetScope: string) {
    if (!this.application) throw new Error('LIMINAL_EMPIRICAL_APPLICATION_REQUIRED');
    return this.application.apply({ snapshotDigest, targetScope,
      basePlan: { prompt: command.prompt, domain: command.domain,
        layers: command.layers, doctrineInputDigest: digest(providerInput) },
      providerInput });
  }

  private finish(command: LiminalCreativeCommand, providerInput: string,
    doctrine: { doctrineDigest: string; sourceReviewDigest: string;
      inputDeltaDigest: string } | undefined,
    empirical: ReturnType<KnowledgeApplication['apply']> | undefined) {
    const body = { doctrine, empirical,
      preProviderInputDigest: byteDigest(command.prompt),
      finalProviderInputDigest: byteDigest(providerInput) };
    const receipt = Object.freeze({ ...body, compilationDigest: digest(body) });
    return Object.freeze({ receipt, command: Object.freeze({ ...command,
      prompt: providerInput, creativeContextDigest: receipt.compilationDigest,
    }) });
  }
}
