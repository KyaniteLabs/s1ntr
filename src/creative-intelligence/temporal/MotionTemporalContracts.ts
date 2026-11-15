import { createHash } from 'node:crypto';
import type { CreativePrincipleContract } from '../CreativeIntelligence.js';

export const MOTION_TEMPORAL_PRINCIPLE_SCHEMA = 'sinter.motion-temporal-principle' as const;
export const MOTION_TEMPORAL_PRINCIPLE_VERSION = 1 as const;

export type MotionTemporalPrincipleId = 'temporal-arc' | 'temporal-rhythm';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

const TEMPORAL_ARC_CONTRACT: CreativePrincipleContract = {
  schema: 'sinter.creative-principle-contract',
  schemaVersion: 1,
  identity: {
    id: 'temporal-arc',
    name: 'Temporal arc',
    aliases: ['time arc', 'temporal progression', 'arc over time', 'development over time'],
  },
  domain: { domain: 'motion', category: 'time-based-structure' },
  theory: {
    claim: 'A perceptible time-based work benefits from a legible arc that opens, develops, and resolves.',
    mechanism: 'Plan a sample schedule whose opening, development, and release samples carry the brief over a bounded duration.',
  },
  controllableVariables: [
    { id: 'duration', label: 'Duration', description: 'Total active duration in milliseconds or frames.' },
    { id: 'opening', label: 'Opening weight', description: 'How much the first samples establish the field.' },
    { id: 'release', label: 'Release weight', description: 'How much the last samples resolve the arc.' },
    { id: 'sample-density', label: 'Sample density', description: 'How many observable samples occur per interval.' },
  ],
  positiveApplicability: [
    'The brief asks for an evolving work, a moving scene, or a sampled sequence.',
    'The intended experience has a clear opening, development, and release.',
  ],
  negativeApplicability: [
    'The work is a single static moment with no time component.',
    'The brief is intentionally ambient with no readable arc.',
  ],
  prerequisites: [
    'A clock or fixed-step sample source is available.',
    'The intended experience can be expressed as a bounded number of samples.',
  ],
  compatiblePrinciples: ['temporal-rhythm', 'contrast'],
  conflictingPrinciples: ['static-field', 'undifferentiated-loop'],
  status: 'hard',
  domainAdapters: {
    motion: { translation: 'Bind the time-based generator to a sample schedule with opening and release samples.', controls: ['duration', 'opening', 'release'] },
    visual: { translation: 'Sequence frames along the arc; hold the focal subject across samples.', controls: ['sample-density', 'release'] },
    audio: { translation: 'Sequence amplitude or register across the same sample schedule.', controls: ['duration', 'sample-density'] },
  },
  observablePerceptualEvidence: [
    { id: 'arc-legibility', signal: 'arc legibility', description: 'The opening, development, and release are observable across the samples.' },
    { id: 'sample-coverage', signal: 'sample coverage', description: 'Every declared sample is produced and observed.' },
    { id: 'clock-traceability', signal: 'clock traceability', description: 'Each sample is bound to a clock identity the artifact records.' },
  ],
  revisionOperators: [
    { id: 'refine-arc', label: 'Refine arc', operation: 'Subdivide the arc into additional intermediate samples while preserving first and last sample identity.' },
    { id: 'phase-shift', label: 'Phase shift', operation: 'Rotate the sample order by a bounded number of samples.' },
  ],
  intentionalViolationRules: [
    { rule: 'Arc may be flattened when ambiguity is the declared meaning.', evidence: 'The flattening is localized, declared, and does not violate hard floors.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-motion-temporal-arc',
      title: 'Liminal motion/temporal principle: Temporal arc',
      locator: 'src/creative-intelligence/temporal/MotionTemporalContracts.ts#temporal-arc',
    }],
    curator: 'sinter-wave-8-w8-07',
  },
  confidence: { score: 0.82, rationale: 'The contract names observable sample, clock, and arc evidence instead of prescribing a style.' },
  supersession: { state: 'active' },
};

const TEMPORAL_RHYTHM_CONTRACT: CreativePrincipleContract = {
  schema: 'sinter.creative-principle-contract',
  schemaVersion: 1,
  identity: {
    id: 'temporal-rhythm',
    name: 'Temporal rhythm',
    aliases: ['rhythm', 'pulse', 'beat pattern', 'temporal cadence'],
  },
  domain: { domain: 'motion', category: 'time-based-structure' },
  theory: {
    claim: 'A perceptible time-based work benefits from a regular, identifiable pulse that the audience can track.',
    mechanism: 'Plan a sample schedule with a fixed interval so the pulse is auditable and bound to the clock identity.',
  },
  controllableVariables: [
    { id: 'interval', label: 'Interval', description: 'Distance between successive samples in the chosen unit.' },
    { id: 'pulse-strength', label: 'Pulse strength', description: 'How strongly each sample reads as a beat.' },
    { id: 'cycle-length', label: 'Cycle length', description: 'Number of samples that complete one rhythmic cycle.' },
    { id: 'silence-ratio', label: 'Silence ratio', description: 'Fraction of low-energy samples that give the rhythm room to breathe.' },
  ],
  positiveApplicability: [
    'The brief implies a regular cadence, pulse, or tick.',
    'The intended experience relies on a perceivable time-based beat.',
  ],
  negativeApplicability: [
    'The brief is intentionally free-rhythm with no perceivable pulse.',
    'Additional cadence would compete with the declared arc.',
  ],
  prerequisites: [
    'A clock or fixed-step sample source is available.',
    'The brief implies a regular cadence.',
  ],
  compatiblePrinciples: ['temporal-arc', 'contrast'],
  conflictingPrinciples: ['stochastic-field', 'irregular-burst'],
  status: 'hard',
  domainAdapters: {
    motion: { translation: 'Drive the time-based generator from a fixed-interval sample schedule.', controls: ['interval', 'cycle-length'] },
    audio: { translation: 'Use the interval as the beat length and apply pulse-strength to amplitude.', controls: ['interval', 'pulse-strength'] },
    visual: { translation: 'Pulse brightness or scale at each interval tick.', controls: ['interval', 'silence-ratio'] },
  },
  observablePerceptualEvidence: [
    { id: 'interval-traceability', signal: 'interval traceability', description: 'Each sample interval matches the declared schedule.' },
    { id: 'pulse-traceability', signal: 'pulse traceability', description: 'Each sample is bound to the pulse at the matching tick.' },
    { id: 'clock-traceability', signal: 'clock traceability', description: 'Each sample is bound to a clock identity the artifact records.' },
  ],
  revisionOperators: [
    { id: 'compress', label: 'Compress', operation: 'Reduce the visible sample count by a bounded amount while preserving the first and last sample.' },
    { id: 'phase-shift', label: 'Phase shift', operation: 'Rotate the sample order by a bounded number of samples.' },
  ],
  intentionalViolationRules: [
    { rule: 'Rhythm may be broken or stretched when the declared experience demands rupture.', evidence: 'The break is localized, declared, and does not violate hard floors.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-motion-temporal-rhythm',
      title: 'Liminal motion/temporal principle: Temporal rhythm',
      locator: 'src/creative-intelligence/temporal/MotionTemporalContracts.ts#temporal-rhythm',
    }],
    curator: 'sinter-wave-8-w8-07',
  },
  confidence: { score: 0.8, rationale: 'The contract names observable interval and pulse evidence instead of prescribing a style.' },
  supersession: { state: 'active' },
};

export const MOTION_TEMPORAL_CONTRACTS: Readonly<Record<MotionTemporalPrincipleId, CreativePrincipleContract>> =
  deepFreeze({
    'temporal-arc': TEMPORAL_ARC_CONTRACT,
    'temporal-rhythm': TEMPORAL_RHYTHM_CONTRACT,
  });

export const MOTION_TEMPORAL_CONTRACT_IDS: readonly MotionTemporalPrincipleId[] = deepFreeze([
  'temporal-arc',
  'temporal-rhythm',
]);

export function resolveMotionTemporalContract(id: string): CreativePrincipleContract | undefined {
  const key = id.trim().toLowerCase();
  for (const candidate of MOTION_TEMPORAL_CONTRACT_IDS) {
    const contract = MOTION_TEMPORAL_CONTRACTS[candidate];
    if (contract.identity.id === key) return contract;
    if (contract.identity.name.toLowerCase() === key) return contract;
    if (contract.identity.aliases.some((alias) => alias.toLowerCase() === key)) return contract;
  }
  return undefined;
}

export function motionTemporalContractDigest(contract: CreativePrincipleContract): string {
  return digest(JSON.stringify(contract));
}
