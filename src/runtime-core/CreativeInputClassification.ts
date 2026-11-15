import { createHash } from 'node:crypto';
import type { CompostTaint } from '../compost/types.js';

export type CreativeInputClassification =
  | Readonly<{ category: 'doctrine'; content: string; contentDigest: string;
      doctrineDigest: string }>
  | Readonly<{ category: 'activated-knowledge'; content: string; contentDigest: string;
      snapshotDigest: string }>
  | Readonly<{ category: 'tainted-exploration'; content: string; contentDigest: string;
      ancestorDigests: readonly string[]; taint: CompostTaint }>;

const DIGEST = /^[a-f0-9]{64}$/;
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const requireDigest = (value: string) => {
  if (!DIGEST.test(value)) throw new Error('CREATIVE_INPUT_DIGEST_INVALID');
  return value;
};

export const classifyDoctrineInput = (content: string, doctrineDigest: string):
  CreativeInputClassification => Object.freeze({ category: 'doctrine', content,
    contentDigest: digest(content), doctrineDigest: requireDigest(doctrineDigest) });
export const classifyActivatedKnowledgeInput = (content: string, snapshotDigest: string):
  CreativeInputClassification => Object.freeze({ category: 'activated-knowledge', content,
    contentDigest: digest(content), snapshotDigest: requireDigest(snapshotDigest) });
export const classifyTaintedExplorationInput = (content: string,
  ancestorDigests: readonly string[], taint: CompostTaint = 'unknown'):
  CreativeInputClassification => Object.freeze({ category: 'tainted-exploration', content,
    contentDigest: digest(content), ancestorDigests: Object.freeze(
      [...new Set(ancestorDigests.map(requireDigest))].sort()), taint });

export function formatClassifiedCreativeInput(input: CreativeInputClassification): string {
  const authority = input.category === 'doctrine' ? input.doctrineDigest
    : input.category === 'activated-knowledge' ? input.snapshotDigest
      : input.ancestorDigests.join(',');
  return `[creative-input:${input.category}; authority:${authority}; digest:${input.contentDigest}]\n${input.content}`;
}
