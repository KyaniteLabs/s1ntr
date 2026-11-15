/**
 * MotifIndexer — Phase 15
 *
 * Indexes reusable motifs, fragments, and failure patterns from compost.
 * Builds a searchable index of structural patterns that can be reused
 * in new branch candidates and mutation templates.
 */

import type { CompostFragment } from './types.js';

export interface MotifEntry {
  /** Normalized pattern string */
  pattern: string;
  /** Fragments containing this motif */
  fragmentIds: string[];
  /** How often this pattern appears */
  frequency: number;
  /** Domains where this pattern appears */
  domains: string[];
  /** Whether this is a success or failure pattern */
  kind: 'success' | 'failure' | 'structural';
}

export interface MotifIndexResult {
  motifs: MotifEntry[];
  /** Total unique motifs found */
  uniqueCount: number;
  /** Most common motif pattern */
  topPattern: string | null;
}

export interface MotifIndexerConfig {
  /** Minimum pattern length to index (default: 4) */
  minPatternLength?: number;
  /** Maximum motifs to track (default: 200) */
  maxMotifs?: number;
}

const DEFAULT_MIN_LEN = 4;
const DEFAULT_MAX_MOTIFS = 200;
// Whole words, so "banana" is not NaN and "nullable" is not null; any word containing
// "error" (TypeError, errors, onError) still counts.
const FAILURE_SIGNALS = /\b(\w*error\w*|catch|fail\w*|undefined|null|NaN)\b/i;
const STRUCTURAL_SIGNALS = /\b(if|for|while|function|class|return)\b/i;

export class MotifIndexer {
  private readonly motifs: Map<string, MotifEntry> = new Map();
  private readonly minPatternLength: number;
  private readonly maxMotifs: number;

  constructor(config: MotifIndexerConfig = {}) {
    this.minPatternLength = config.minPatternLength ?? DEFAULT_MIN_LEN;
    this.maxMotifs = config.maxMotifs ?? DEFAULT_MAX_MOTIFS;
  }

  /**
   * Index motifs from a set of compost fragments.
   */
  index(fragments: CompostFragment[]): MotifIndexResult {
    for (const fragment of fragments) {
      const patterns = this.extractPatterns(fragment.content);
      for (const { pattern, raw } of patterns) {
        const existing = this.motifs.get(pattern);
        if (existing) {
          existing.frequency++;
          existing.fragmentIds.push(fragment.id);
          if (!existing.domains.includes(fragment.domain)) {
            existing.domains.push(fragment.domain);
          }
        } else {
          if (this.motifs.size >= this.maxMotifs) continue;
          this.motifs.set(pattern, {
            pattern,
            fragmentIds: [fragment.id],
            frequency: 1,
            domains: [fragment.domain],
            kind: this.classifyPattern(raw),
          });
        }
      }
    }

    const sorted = [...this.motifs.values()].sort((a, b) => b.frequency - a.frequency);
    return {
      motifs: sorted,
      uniqueCount: this.motifs.size,
      topPattern: sorted.length > 0 ? sorted[0].pattern : null,
    };
  }

  /**
   * Search for motifs matching a query pattern.
   */
  search(query: string, limit?: number): MotifEntry[] {
    const normalized = query.toLowerCase().trim();
    const results: MotifEntry[] = [];

    for (const entry of this.motifs.values()) {
      // Patterns are stored with uppercase ID/N placeholders; the query is lowercased.
      const pattern = entry.pattern.toLowerCase();
      if (pattern.includes(normalized) || normalized.includes(pattern)) {
        results.push(entry);
      }
    }

    return results
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit ?? 20);
  }

  /**
   * Get motifs that appear across multiple domains (cross-domain patterns).
   */
  getCrossDomainMotifs(): MotifEntry[] {
    return [...this.motifs.values()]
      .filter(m => m.domains.length >= 2)
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Get motifs classified as failure patterns.
   */
  getFailurePatterns(): MotifEntry[] {
    return [...this.motifs.values()]
      .filter(m => m.kind === 'failure')
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Clear the motif index.
   */
  clear(): void {
    this.motifs.clear();
  }

  /** Each pattern keeps its raw source text: normalisation erases the keywords classification needs. */
  private extractPatterns(content: string): Array<{ pattern: string; raw: string }> {
    const patterns: Array<{ pattern: string; raw: string }> = [];
    const lines = content.split('\n').filter(l => l.trim().length >= this.minPatternLength);

    // Extract structural patterns: normalized line shapes
    for (const line of lines) {
      const normalized = this.normalizePattern(line);
      if (normalized.length >= this.minPatternLength) {
        patterns.push({ pattern: normalized, raw: line });
      }
    }

    // Extract block patterns: consecutive line shapes
    for (let i = 0; i < lines.length - 1; i++) {
      const pair = this.normalizePattern(lines[i]) + '|' + this.normalizePattern(lines[i + 1]);
      if (pair.length >= this.minPatternLength * 2) {
        patterns.push({ pattern: pair, raw: `${lines[i]}\n${lines[i + 1]}` });
      }
    }

    return patterns;
  }

  private normalizePattern(line: string): string {
    return line
      .trim()
      .replace(/\b\d+\.?\d*\b/g, 'N')        // Numbers → N
      .replace(/\b[a-zA-Z_]\w*\b/g, 'ID')     // Identifiers → ID
      .replace(/\s+/g, ' ')                     // Collapse whitespace
      .replace(/".*?"/g, '"S"')                 // Strings → "S"
      .replace(/'.*?'/g, "'S'");
  }

  private classifyPattern(raw: string): MotifEntry['kind'] {
    // Classify on the raw source: normalised patterns have every identifier replaced by "ID".
    if (FAILURE_SIGNALS.test(raw)) return 'failure';
    if (STRUCTURAL_SIGNALS.test(raw)) return 'structural';
    return 'success';
  }
}
