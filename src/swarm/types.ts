export interface SwarmPersona {
  id: string;
  name: string;
  displayName: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  voice: string;
  thinkingStyle: string;
  votingBias: string;
  constraints: string[];
  votingPower: number;
}

export interface SwarmCallOptions {
  temperature?: number;
  num_predict?: number;
  signal?: AbortSignal;
}

export type SwarmOllamaCaller = (
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: SwarmCallOptions,
) => Promise<string>;

export enum SwarmMode {
  COMPETITIVE = 'competitive',
  HYBRID = 'hybrid',
  RING = 'ring',
  MESH = 'mesh',
}

export interface SwarmConfig {
  ollamaHost: string;
  ollamaTimeout: number;
  maxRounds: number;
  convergenceThreshold: number;
  musicalChairs: boolean;
  mode: SwarmMode;
  personas: SwarmPersona[];
  refinementConstraints: string[];
  streamDir: string;
  /**
   * When set, every finished run also writes a durable
   * `liminal.swarm-session.v1` record (prompt, domain, per-round votes,
   * blind candidate sources) under this directory so a human can label it.
   */
  sessionDir?: string;
  /**
   * Durable gold-label calibration ledger. Forwarded to the orchestrator
   * options so a run reads existing labels before voting.
   */
  calibrationLedgerPath?: string;
  /** Skip expert routing and use configured personas directly (useful for testing) */
  skipRouting?: boolean;
}

export interface SwarmOutput {
  personaId: string;
  personaName: string;
  content: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  roundNum: number;
  /**
   * Optional render-signal metadata. When present, the heuristic scorer
   * (D12) is bypassed in favor of the actual measured render verdict.
   */
  metadata?: SwarmOutputMetadata;
}
export interface SwarmOutputMetadata {
  renderSignals?: SwarmRenderSignals;
  domain?: string;
  variant?: string;
}

export interface SwarmRenderSignals {
  passesRenderGate?: boolean;
  luminance?: number;
  renderScore?: number;
  measuredAt?: string;
}

/**
 * Where a vote came from. Only `llm` votes are calibration evidence: heuristic
 * rounds are intra-swarm self-votes and fallback placeholders carry no signal.
 * `undefined` on an older record means the source was not recorded; readers
 * treat it as a real vote (backwards compatibility).
 */
export type VoteSource = 'llm' | 'heuristic' | 'fallback';

export interface Vote {
  voterId: string;
  firstChoice: string;
  secondChoice: string;
  reasoning: string;
  /** Set by every production constructor; absent on legacy/direct-API votes. */
  voteSource?: VoteSource;
}

export interface RoundResult {
  /** Votes and heuristic winners rank exploration; they grant no creative trust. */
  admissionStatus: 'exploratory';
  roundNum: number;
  seed: string;
  outputs: Map<string, SwarmOutput>;
  votes: Map<string, Vote>;
  scores: Map<string, number>;
  winnerId: string | null;
  winnerContent: string;
  constraint: string;
  /** Final-round vote receipt; absent for heuristic (non-final) rounds. */
  votingDecision?: import('./VotingEngine.js').VotingDecision;
  composedExpression?: {
    expression: string;
    estimatedEffectiveness: number;
    strategy: string;
    symbolCount: number;
    creativeInput: import('../runtime-core/CreativeInputClassification.js').CreativeInputClassification;
  };
}

export interface SwarmResult {
  rounds: RoundResult[];
  converged: boolean;
  convergenceRound: number | null;
  finalOutput: string;
  totalDurationMs: number;
  mode: SwarmMode;
  allOutputs: SwarmOutput[];
  /** Persona→model assignment the panel actually generated with (after any musical-chairs shuffle). */
  panelAssignment?: Array<{ personaId: string; model: string }>;
  /** Set when musicalChairs is on: false means the panel had <2 distinct models, so the shuffle could not change anything. */
  musicalChairsEffective?: boolean;
  /** Durable session id, set when `sessionDir` is configured. */
  sessionId?: string;
  /** Absolute path of the `liminal.swarm-session.v1` record, when written. */
  sessionPath?: string;
}

export interface MinedFragment {
  id: string;
  text: string;
  source: string;
  round: number;
  persona: string;
  score: number;
  mode: string;
  tags: string[];
  sessionPrompt: string;
  extractedAt: string;
}

/** Default refinement constraints used across swarm rounds. */
export const DEFAULT_REFINEMENT_CONSTRAINTS: string[] = [
  'Add more spectral imagery',
  'Deconstruct the physical form',
  'Focus on the sound of the machine',
  'Introduce a paradox of memory',
];
