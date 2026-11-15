import type { SwarmPersona, SwarmOutput, SwarmConfig, SwarmOllamaCaller, Vote } from './types.js';
import { PromptLibrary } from '../prompts/index.js';
import { isAbortError } from '../utils/abort.js';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';
import { withFileLockSync } from '../utils/fileLock.js';

/**
 * Where a calibration label came from. Only labels independent of the vote
 * being scored are accepted: calibrating voters against the swarm's own
 * winner is circular and would just reinforce the majority.
 */
export type CalibrationSource = 'human' | 'external-oracle';

export interface CalibrationOptions {
  source: CalibrationSource;
  /** Stable id of the labelled event; replays with the same id are ignored. */
  outcomeId: string;
}

const LEDGER_SCHEMA = 'liminal.voting-calibration.v1';

/**
 * How a winner was chosen. Only 'weighted-majority' is a decision by vote; the
 * other bases pick an output so the round can continue, and must not be read
 * as the voters' verdict.
 */
export type VotingDecisionBasis =
  | 'weighted-majority'
  | 'tie-insertion-order'
  | 'no-valid-votes-fallback'
  | 'no-caller-fallback';

export interface VotingDecision {
  basis: VotingDecisionBasis;
  /** True only when a unique top score came from parsed votes. */
  electedByVote: boolean;
  /** Declared denominator: every persona asked to vote, including abstentions. */
  declaredVoters: number;
  /** Votes with a parsed first choice. */
  validVotes: number;
  /** Declared voters with no valid vote (no output, call error, or unparseable reply). */
  abstainedVoterIds: string[];
  /** Candidates sharing the top score when basis is 'tie-insertion-order'. */
  tiedIds: string[];
  /**
   * Declared voters whose weight came from gold-labelled outcomes in this
   * domain. Everyone else used the uncalibrated prior (weight factor 1).
   */
  calibratedVoterIds: string[];
}

export interface VotingResult {
  scores: Map<string, number>;
  winnerId: string;
  votes: Map<string, Vote>;
  decision: VotingDecision;
}

/**
 * Performance record for an expert in a specific domain
 */
export interface ExpertPerformance {
  expertId: string;
  domain: string;
  correctVotes: number;
  totalVotes: number;
  lastUpdated: Date;
}

/**
 * VotingEngine with a gold-anchored calibration ledger.
 *
 * Calibration follows the crowdsourcing / LLM-judge literature:
 * - Labels must come from an independent gold source (human picks or an
 *   external oracle), never from the vote itself (CalibrationOptions.source).
 * - Accuracy is the Beta(1,1)-smoothed posterior mean (c+1)/(n+2).
 * - Weight uses K-class log-odds, ln((K-1)p/(1-p)), the optimal weighted
 *   majority rule for independent voters (Nitzan & Paroush 1982), normalised
 *   so an uncalibrated voter has factor 1 and clipped to [0, MAX]. Voters at or
 *   below chance get 0, never a negative (inverted) vote.
 * - Voters sharing an underlying model have correlated errors, so each model
 *   family's total influence is equalised (see conductVoting).
 *
 * Outcomes live in memory unless attachLedger(path) is called; then every
 * accepted outcome is persisted atomically and replays are deduplicated by
 * outcomeId. conductVoting only reads the ledger and never writes it.
 */
export class VotingEngine {
  private static performanceHistory: Map<string, ExpertPerformance> = new Map();
  private static seenOutcomes: Set<string> = new Set();
  private static ledgerPath: string | null = null;

  // Prior accuracy for experts with no gold-labelled history
  private static readonly DEFAULT_ACCURACY = 0.5;
  /** Upper clip on the calibration factor. */
  private static readonly MAX_CALIBRATION_FACTOR = 2;
  /** Log-odds needs K >= 3 for the 0.5 prior to sit above chance. */
  private static readonly MIN_CANDIDATES = 3;

  private static getPerformanceKey(expertId: string, domain: string): string {
    return `${expertId}:${domain}`;
  }

  /**
   * Persist calibration to `path` and load whatever it already holds.
   * Throws on a file that is not a valid ledger rather than silently
   * starting from empty.
   */
  static attachLedger(path: string): void {
    this.loadLedger(path);
    this.ledgerPath = path;
  }

  /**
   * Run a ledger mutation. With a ledger attached this is a locked
   * read-modify-write: the file is re-read first (another process may have
   * written since we attached), `mutate` applies on top of that, and the
   * result is written atomically. A corrupt file throws before anything is
   * written. `mutate` reports whether it changed state.
   */
  private static transact<T>(mutate: () => { changed: boolean; value: T }): T {
    const path = this.ledgerPath;
    if (!path) return mutate().value;
    mkdirSync(dirname(path), { recursive: true });
    return withFileLockSync(`${path}.lock`, () => {
      this.loadLedger(path);
      const { changed, value } = mutate();
      if (changed) this.persist();
      return value;
    });
  }

  /** Replace in-memory state with the file's contents (empty when absent). */
  private static loadLedger(path: string): void {
    this.performanceHistory.clear();
    this.seenOutcomes.clear();
    if (existsSync(path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8'));
      } catch (err) {
        throw new Error(`VotingEngine ledger ${path} is not valid JSON: ${(err as Error).message}`);
      }
      const ledger = parsed as { schema?: unknown; records?: unknown; outcomes?: unknown };
      if (ledger.schema !== LEDGER_SCHEMA || !Array.isArray(ledger.records) || !Array.isArray(ledger.outcomes)) {
        throw new Error(`VotingEngine ledger ${path} does not match schema ${LEDGER_SCHEMA}`);
      }
      for (const r of ledger.records as Array<Record<string, unknown>>) {
        const { expertId, domain, correctVotes, totalVotes } = r;
        if (typeof expertId !== 'string' || typeof domain !== 'string'
          || !Number.isInteger(correctVotes) || !Number.isInteger(totalVotes)
          || (correctVotes as number) < 0 || (correctVotes as number) > (totalVotes as number)) {
          throw new Error(`VotingEngine ledger ${path} has an invalid record`);
        }
        this.performanceHistory.set(this.getPerformanceKey(expertId, domain), {
          expertId, domain, correctVotes: correctVotes as number, totalVotes: totalVotes as number,
          lastUpdated: new Date(typeof r.lastUpdated === 'string' ? r.lastUpdated : 0),
        });
      }
      for (const id of ledger.outcomes) {
        if (typeof id === 'string') this.seenOutcomes.add(id);
      }
    }
  }

  /** Stop persisting; in-memory state is kept. */
  static detachLedger(): void {
    this.ledgerPath = null;
  }

  /**
   * True when any vote for `outcomeId` is already present in the attached
   * ledger. `calibrateFromResult` dedupes per vote (`<outcomeId>#r<i>:<voter>`),
   * so a plain exact-match would miss a partially recorded outcome.
   */
  static hasOutcome(outcomeId: string): boolean {
    if (typeof outcomeId !== 'string' || outcomeId.trim() === '') return false;
    if (this.seenOutcomes.has(outcomeId)) return true;
    const roundPrefix = `${outcomeId}#r`;
    const recordPrefix = `${outcomeId}:`;
    for (const key of this.seenOutcomes) {
      if (key.startsWith(roundPrefix) || key.startsWith(recordPrefix)) return true;
    }
    return false;
  }

  private static persist(): void {
    if (!this.ledgerPath) return;
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    writeFileAtomicSync(this.ledgerPath, JSON.stringify({
      schema: LEDGER_SCHEMA,
      records: [...this.performanceHistory.values()].map(r => ({ ...r, lastUpdated: r.lastUpdated.toISOString() })),
      outcomes: [...this.seenOutcomes],
    }, null, 2));
  }

  /**
   * Record a voting outcome against an independent gold label.
   *
   * @param expertId The expert who cast the vote
   * @param domain The domain/topic of the prompt (e.g., 'geometric', 'organic')
   * @param votedFor The expert ID that was voted for
   * @param actualWinner The gold winner (human pick or external oracle)
   * @param options When given, the outcome is deduplicated by outcomeId and persisted
   * @returns false when the outcome was a replay and was ignored
   */
  static recordOutcome(
    expertId: string,
    domain: string,
    votedFor: string,
    actualWinner: string,
    options?: CalibrationOptions,
  ): boolean {
    if (options) this.assertGold(options);
    return this.transact(() => {
      if (options) {
        const key = `${options.outcomeId}:${expertId}`;
        if (this.seenOutcomes.has(key)) return { changed: false, value: false };
        this.seenOutcomes.add(key);
      }
      this.applyOutcome(expertId, domain, votedFor === actualWinner);
      return { changed: true, value: true };
    });
  }

  private static assertGold(options: CalibrationOptions): void {
    if (options.source !== 'human' && options.source !== 'external-oracle') {
      throw new Error(`VotingEngine: calibration source must be 'human' or 'external-oracle' (got ${String(options.source)})`);
    }
    if (typeof options.outcomeId !== 'string' || options.outcomeId.trim() === '') {
      throw new Error('VotingEngine: calibration outcomeId must be a non-empty string');
    }
  }

  private static applyOutcome(expertId: string, domain: string, isCorrect: boolean): void {
    const key = this.getPerformanceKey(expertId, domain);
    const existing = this.performanceHistory.get(key);
    if (existing) {
      existing.correctVotes += isCorrect ? 1 : 0;
      existing.totalVotes += 1;
      existing.lastUpdated = new Date();
    } else {
      this.performanceHistory.set(key, {
        expertId,
        domain,
        correctVotes: isCorrect ? 1 : 0,
        totalVotes: 1,
        lastUpdated: new Date(),
      });
    }
  }

  /**
   * Beta(1,1)-smoothed accuracy (c+1)/(n+2) for an expert in a domain.
   */
  static getExpertAccuracy(expertId: string, domain: string): number {
    const record = this.performanceHistory.get(this.getPerformanceKey(expertId, domain));
    if (!record || record.totalVotes === 0) {
      return this.DEFAULT_ACCURACY;
    }
    return (record.correctVotes + 1) / (record.totalVotes + 2);
  }

  /**
   * Calibration factor from K-class log-odds, normalised to the prior:
   * ln((K-1)p/(1-p)) / ln((K-1)p0/(1-p0)), clipped to [0, MAX].
   * Uncalibrated voters get exactly 1; voters at or below chance (p <= 1/K) get 0.
   */
  static getCalibrationFactor(expertId: string, domain: string, candidates: number = this.MIN_CANDIDATES): number {
    const k = Math.max(this.MIN_CANDIDATES, Math.floor(Number.isFinite(candidates) ? candidates : 0));
    const logOdds = (p: number) => Math.log(((k - 1) * p) / (1 - p));
    const factor = logOdds(this.getExpertAccuracy(expertId, domain)) / logOdds(this.DEFAULT_ACCURACY);
    return Math.min(this.MAX_CALIBRATION_FACTOR, Math.max(0, factor));
  }

  /**
   * Calibrated voting weight: votingPower × calibration factor.
   */
  static getCalibratedWeight(expert: SwarmPersona, domain: string, candidates?: number): number {
    return expert.votingPower * this.getCalibrationFactor(expert.id, domain, candidates);
  }

  /**
   * Infer domain from prompt content using keyword matching.
   * Simple heuristic for domain detection.
   * 
   * @param prompt The prompt to analyze
   * @returns Detected domain string
   */
  static inferDomain(prompt: string): string {
    const promptLower = prompt.toLowerCase();
    
    const domainKeywords: Record<string, string[]> = {
      geometric: ['geometric', 'grid', 'lines', 'shapes', 'circles', 'minimal', 'bauhaus'],
      organic: ['nature', 'organic', 'flowing', 'water', 'plants', 'leaves', 'fluid'],
      mathematical: ['fractal', 'math', 'recursive', 'fibonacci', 'spiral', 'mandala'],
      interactive: ['interactive', 'physics', 'gravity', 'collision', 'mouse', 'drag'],
      audio: ['audio', 'music', 'sound', 'frequency', 'beat', 'rhythm', 'synth'],
    };
    
    let bestDomain = 'general';
    let bestScore = 0;
    
    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      const score = keywords.filter(kw => promptLower.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }
    
    return bestDomain;
  }

  /**
   * Get all performance records for debugging/analysis
   */
  static getAllPerformanceRecords(): ExpertPerformance[] {
    return Array.from(this.performanceHistory.values());
  }

  /**
   * Clear all performance history (for testing)
   */
  static clearPerformanceHistory(): void {
    this.performanceHistory.clear();
    this.seenOutcomes.clear();
    this.ledgerPath = null;
  }

  /**
   * Parse vote text to extract first choice, second choice, and reasoning.
   * Looks for patterns like "1st: A", "first choice: B", "2nd: C", etc.
   * Falls back to finding any letter A-G in the text.
   */
  static parseVote(
    voteText: string,
    candidateMap: Map<string, string>,
    maxLetter: string = 'G'
  ): { first: string | null; second: string | null; reasoning: string } {
    const regex = `[A-${maxLetter}]`;

    // Try structured patterns first
    const firstMatch = voteText.match(new RegExp(`1st(?:\\s*choice)?[:\\s]+(${regex})`, 'i'));
    const secondMatch = voteText.match(new RegExp(`2nd(?:\\s*choice)?[:\\s]+(${regex})`, 'i'));

    let first = firstMatch ? candidateMap.get(firstMatch[1].toUpperCase()) ?? null : null;
    const second = secondMatch ? candidateMap.get(secondMatch[1].toUpperCase()) ?? null : null;

    // Fallback: find any letter in text
    if (!first) {
      for (let i = 65; i <= maxLetter.charCodeAt(0); i++) {
        const letter = String.fromCharCode(i);
        if (voteText.toUpperCase().includes(letter)) {
          first = candidateMap.get(letter) ?? null;
          break;
        }
      }
    }

    // Extract reasoning (last non-empty line)
    const lines = voteText.trim().split('\n').filter(l => l.trim().length > 0);
    const reasoning = lines.length > 0 ? lines[lines.length - 1].trim() : 'No reasoning provided';

    return { first, second, reasoning };
  }

  /**
   * Conduct voting: ask each persona to vote on the outputs.
   * Uses Ollama API to get each persona's vote.
   * Applies calibrated weights based on historical performance.
   * 
   * @param outputs The outputs to vote on
   * @param personas The voting personas (experts)
   * @param roundNum The current round number
   * @param _config Swarm configuration
   * @param callOllama Optional Ollama caller
   * @param prompt Optional prompt for domain inference (used for calibration)
   * @param signal Optional cancellation signal for in-flight voting calls
   */
  static async conductVoting(
    outputs: Map<string, SwarmOutput>,
    personas: SwarmPersona[],
    _roundNum: number,
    _config: SwarmConfig,
    callOllama?: SwarmOllamaCaller,
    prompt?: string,
    signal?: AbortSignal,
  ): Promise<VotingResult> {
    // Build candidate map (A, B, C...)
    const candidateMap = new Map<string, string>();
    const candidatesText: string[] = [];
    let idx = 0;

    for (const [personaId, output] of outputs) {
      const letter = String.fromCharCode(65 + idx);
      candidateMap.set(letter, personaId);
      candidatesText.push(`Piece ${letter} (${personaId}): ${output.content}`);
      idx++;
    }

    const candidatesStr = candidatesText.join('\n\n');
    const votes = new Map<string, Vote>();
    
    // Infer domain for calibration
    const domain = prompt ? this.inferDomain(prompt) : 'general';

    // If no Ollama caller provided, return placeholder (for testing)
    if (!callOllama) {
      // Fallback: first output wins with equal votes
      const firstPersonaId = outputs.keys().next().value ?? '';
      for (const voter of personas) {
        votes.set(voter.id, {
          voterId: voter.id,
          firstChoice: firstPersonaId,
          secondChoice: '',
          reasoning: 'Fallback vote (no Ollama connection)',
          voteSource: 'fallback',
        });
      }
      const scores = new Map<string, number>();
      scores.set(firstPersonaId, personas.reduce((sum, p) => sum + p.votingPower * 2, 0));
      return {
        scores,
        winnerId: firstPersonaId,
        votes,
        decision: {
          basis: 'no-caller-fallback',
          electedByVote: false,
          declaredVoters: personas.length,
          validVotes: 0,
          abstainedVoterIds: personas.map(p => p.id),
          tiedIds: [],
          calibratedVoterIds: [],
        },
      };
    }

    // Ask each persona to vote (in parallel)
    const results = await Promise.all(
      personas.filter(v => outputs.has(v.id)).map(async voter => {
        // Build the voting prompt
        const rendered = PromptLibrary.render('swarm.voting', {
          displayName: voter.displayName,
          voice: voter.voice,
          votingBias: voter.votingBias,
          candidates: candidatesStr,
        });

        try {
          const voteText = await callOllama(
            voter.model,
            rendered.system,
            rendered.user,
            {
              // All voters use same temperature - differentiation from system prompts
              temperature: 0.7,
              num_predict: voter.maxTokens,
              signal,
            }
          );

          const parsed = this.parseVote(voteText, candidateMap);

          return [voter.id, {
            voterId: voter.id,
            firstChoice: parsed.first ?? '',
            secondChoice: parsed.second ?? '',
            reasoning: parsed.reasoning,
            voteSource: 'llm',
          }] as const;
        } catch (error) {
          if (isAbortError(error)) throw error;
          return [voter.id, {
            voterId: voter.id,
            firstChoice: '',
            secondChoice: '',
            reasoning: `Voting error: ${error instanceof Error ? error.message : 'unknown'}`,
          }] as const;
        }
      })
    );

    for (const [id, vote] of results) {
      votes.set(id, vote);
    }

    // Tally scores with calibrated weights
    const scores = new Map<string, number>();
    for (const persona of personas) {
      scores.set(persona.id, 0);
    }

    // Voters on the same model make correlated errors, so N personas on one
    // model are not N independent votes. Equalise each model family's total
    // influence: factor (N / F) / n_f, which is 1 when every voter shares one
    // model or every voter has its own.
    const castVoters = personas.filter(p => votes.get(p.id)?.firstChoice);
    const familySize = new Map<string, number>();
    for (const p of castVoters) familySize.set(p.model, (familySize.get(p.model) ?? 0) + 1);
    const familyCount = Math.max(1, familySize.size);

    for (const [voterId, vote] of votes) {
      const voter = personas.find(p => p.id === voterId);
      if (!voter) continue;

      const correlationFactor = castVoters.length / familyCount / (familySize.get(voter.model) ?? 1);
      const calibratedWeight = this.getCalibratedWeight(voter, domain, outputs.size) * correlationFactor;

      if (vote.firstChoice) {
        scores.set(vote.firstChoice, (scores.get(vote.firstChoice) ?? 0) + calibratedWeight * 2);
      }
      if (vote.secondChoice) {
        scores.set(vote.secondChoice, (scores.get(vote.secondChoice) ?? 0) + calibratedWeight * 1);
      }
    }

    // Find winner
    let winnerId = '';
    let maxScore = -1;
    for (const [personaId, score] of scores) {
      if (score > maxScore) {
        maxScore = score;
        winnerId = personaId;
      }
    }

    const validVoterIds = new Set(
      [...votes.values()].filter(v => v.firstChoice && personas.some(p => p.id === v.voterId)).map(v => v.voterId),
    );
    const abstainedVoterIds = personas.map(p => p.id).filter(id => !validVoterIds.has(id));
    const tiedIds = maxScore > 0 ? [...scores].filter(([, s]) => s === maxScore).map(([id]) => id) : [];

    let basis: VotingDecisionBasis = tiedIds.length > 1 ? 'tie-insertion-order' : 'weighted-majority';
    if (maxScore <= 0) {
      // Local/lightweight models often return unparseable vote text. In that
      // case, preserve a viable generation instead of electing an error marker.
      const viableOutput = [...outputs.values()].find(output =>
        output.content.trim().length > 0 && !output.content.startsWith('[Generation error')
      );
      winnerId = viableOutput?.personaId ?? winnerId;
      basis = 'no-valid-votes-fallback';
    }

    return {
      scores,
      winnerId,
      votes,
      decision: {
        basis,
        electedByVote: basis === 'weighted-majority',
        declaredVoters: personas.length,
        validVotes: validVoterIds.size,
        abstainedVoterIds,
        tiedIds: basis === 'tie-insertion-order' ? tiedIds : [],
        calibratedVoterIds: personas
          .filter(p => (this.performanceHistory.get(this.getPerformanceKey(p.id, domain))?.totalVotes ?? 0) > 0)
          .map(p => p.id),
      },
    };
  }

  /**
   * Calibrate voters against an independent gold winner for a finished session.
   * Every round's first choices are scored; the outcome is deduplicated by
   * options.outcomeId so replaying the same labelled session changes nothing.
   *
   * @param result The swarm result to learn from
   * @param goldWinner The expert ID chosen by a human or external oracle
   * @param prompt The original prompt for domain inference
   * @param options Gold source and stable outcome id (required)
   * @returns number of votes recorded (0 for a replay)
   */
  static calibrateFromResult(
    result: { rounds: Array<{ votes: Map<string, Vote> }> },
    goldWinner: string,
    prompt: string,
    options: CalibrationOptions,
  ): number {
    this.assertGold(options);
    if (typeof goldWinner !== 'string' || goldWinner === '') {
      throw new Error('VotingEngine: goldWinner must be a non-empty expert id');
    }
    const domain = this.inferDomain(prompt);
    return this.transact(() => {
      let recorded = 0;
      result.rounds.forEach((round, i) => {
        for (const [voterId, vote] of round.votes) {
          if (!vote.firstChoice) continue;
          // Only real LLM votes are calibration evidence. Heuristic self-votes
          // and fallback placeholders stay in the session record but say nothing
          // about voter skill. An unmarked vote is a legacy/direct-API caller and
          // keeps counting. Skipping inside the loop preserves the round index.
          if (vote.voteSource !== undefined && vote.voteSource !== 'llm') continue;
          const key = `${options.outcomeId}#r${i}:${voterId}`;
          if (this.seenOutcomes.has(key)) continue;
          this.seenOutcomes.add(key);
          this.applyOutcome(voterId, domain, vote.firstChoice === goldWinner);
          recorded++;
        }
      });
      return { changed: recorded > 0, value: recorded };
    });
  }
}
