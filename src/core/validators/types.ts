/**
 * Shared types and constants for validators
 */
import type { EngineDomainString } from '../../types/domains.js';
import { hasThinkTags, fencedBlocks, splitThinking } from '../../llm/ModelOutput.js';

export interface ValidationResult {
  valid: boolean;
  cleanedCode: string;
  errors: string[];
  /** Non-blocking analysis carried for downstream consumers; today only the
   * strudel music-theory assessment (S4) populates this. */
  theoryAssessment?: readonly string[];
  /** Deterministic repairs applied to code the gate first rejected (`domain:class`);
   * absent when the code passed as written. */
  repairs?: readonly string[];
}

export interface DomainValidationResult {
  valid: boolean;
  errors: string[];
}

export type Domain = Extract<
  EngineDomainString,
  | 'p5' | 'shader' | 'glsl' | 'three' | 'revideo' | 'hyperframes' | 'music'
  | 'hydra' | 'strudel' | 'tone' | 'svg' | 'kinetic' | 'html' | 'dataviz' | 'custom' | 'ascii'
  | 'textgen' | 'blender' | 'nbe' | 'unknown'
>;

// -----------------------------------------------------------------------------
// Reasoning-text patterns (lines to strip from LLM output)
// -----------------------------------------------------------------------------
export const REASONING_PATTERNS: RegExp[] = [
  /^(The user wants?|I'll create|I need to|Based on|Let me|Here's a|Here is a|Key elements|Creating a|Generating a|I'm going to|I will|I've created|I have created)/i,
  /^As an AI/i,
  /^(Note:|Disclaimer:|Important:)/i,
  /^(Sure!?|Below is|This will|This creates?|This generates?)/i,
  /^(This code|The code|This sketch|This shader|This scene|This composition)/i,
  /^\d+\.\s+\S/i,
  /^-\s+[A-Za-z]/,
  /^(\*\*|__).*?(\*\*|__)\s*[:-]/,
  /^#{1,3}\s/,
  /^I'll\s+(use|make|add|create|ensure|include|apply|build|implement|draw|generate)/i,
  /^I need to/i,
  /^We need\b/i,
  /^Let's\b/i,
];

// -----------------------------------------------------------------------------
// LLM contamination patterns
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Code-start patterns (lines that indicate actual code begins)
// -----------------------------------------------------------------------------
export const CODE_START_PATTERNS: RegExp[] = [
  /^(let|const|var|function|class|if|for|while|switch|try|return|import|export|async|await|throw|new)\b/,
  /^(precision|void|vec[234]|float|int|bool|uniform|attribute|varying|in\s+|out\s+)\b/,
  /^<!DOCTYPE\s/i,
  /^<html/i,
  /^<head/i,
  /^<body/i,
  /^<svg\b/i,
  /^<script/i,
  /^<style/i,
  /^<canvas/i,
  /^<div/i,
  /^\$/,
  /^\{/,
  /^\[/,
  /^\(/,
  /^['"`]/,
  /^\/\//,
  /^\/\*/,
];

// -----------------------------------------------------------------------------
// Preprocessing functions
// -----------------------------------------------------------------------------
export function stripContamination(code: string, preserveWhitespace = false): string {
  const cleaned = splitThinking(code).answer;
  return preserveWhitespace ? cleaned : cleaned.trim();
}

/**
 * Domains whose legitimate artifact IS prose/text-art. The code-oriented
 * reasoning stripper mistakes their content for LLM reasoning ("Here is a…",
 * leading "- " bullets, markdown-looking lines) and truncates it. For these
 * domains the text must pass through intact — stripping is domain-aware.
 */
const TEXT_OUTPUT_DOMAINS = new Set<string>(['ascii', 'textgen']);

export function stripReasoningText(code: string, domain?: string): string {
  // Domain-aware: ascii/textgen art is the artifact, not reasoning. Return it
  // unchanged (trimmed only) so concrete poems / ASCII renderings survive.
  if (domain !== undefined && TEXT_OUTPUT_DOMAINS.has(domain)) {
    return code.replace(/^\s*\n/, '').trimEnd();
  }
  const lines = code.split(/\r?\n/);
  const kept: string[] = [];
  let foundCodeStart = false;
  let cursor = 0;
  // Fence bodies are code; everything after the first fence is kept too.
  const keepLine = (line: string): void => {
    const trimmed = line.trim();
    if (foundCodeStart) {
      kept.push(line);
      return;
    }
    if (!trimmed) return;
    if (REASONING_PATTERNS.some(p => p.test(trimmed))) return;
    if (/^-\s+[A-Z]/.test(trimmed) && !/^-\s+(\d|--?)/.test(trimmed)) return;
    if (
      CODE_START_PATTERNS.some(p => p.test(trimmed)) ||
      /^[\w$]+\s*[=([{:]/.test(trimmed) ||
      /[;{}]/.test(trimmed) || /\w+\(.*\)/.test(trimmed)
    ) {
      foundCodeStart = true;
      kept.push(line);
    }
  };
  for (const block of fencedBlocks(code)) {
    lines.slice(cursor, block.start).forEach(keepLine);
    kept.push(block.body);
    foundCodeStart = true;
    cursor = block.end;
  }
  lines.slice(cursor).forEach(keepLine);

  return kept.join('\n').trim();
}

export function isAlreadyWrapped(code: string): boolean {
  const trimmed = code.trim();
  return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
}

export function detectContamination(code: string): string[] {
  const errors: string[] = [];
  if (hasThinkTags(code)) {
    errors.push('LLM contamination detected: <think> or <thinking> tags found in output');
  }
  return errors;
}
