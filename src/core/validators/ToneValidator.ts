/**
 * ToneValidator - Tone.js audio validation logic
 *
 * Tone.js is a Web Audio framework for creating interactive music.
 * It uses classes like Tone.Synth, Tone.Oscillator, Tone.Transport, etc.
 */

import { parse } from '@babel/parser';

export interface ToneValidationResult {
  valid: boolean;
  errors: string[];
}

export class ToneValidator {
  /**
   * Valid Tone.js classes - comprehensive whitelist of all Tone.js API classes
   */
  private static readonly VALID_TONE_CLASSES = new Set([
    // Core
    'Transport', 'Destination', 'Master', 'Listener', 'Context', 'Draw', 'Tone',
    // Sources - Oscillators
    'Oscillator', 'PulseOscillator', 'PWMOscillator', 'FatOscillator', 'AMOscillator', 'FMOscillator',
    'OmniOscillator', 'LFO',
    // Sources - Synths
    'AMSynth', 'FMSynth', 'MonoSynth', 'PolySynth', 'Synth', 'MembraneSynth',
    'MetalSynth', 'NoiseSynth', 'DuoSynth', 'PluckSynth', 'GrainSynth', 'Sampler', 'Player', 'GrainPlayer',
    // Sources - Noise
    'Noise', 'Microphone', 'UserMedia',
    // Effects - Time
    'Reverb', 'Delay', 'FeedbackDelay', 'PingPongDelay', 'PreDelay',
    // Effects - Distortion
    'Distortion', 'Chebyshev', 'BitCrusher', 'WaveShaper',
    // Effects - Modulation
    'Chorus', 'Phaser', 'Tremolo', 'Vibrato', 'Tremolo', 'AutoPanner',
    // Effects - Filters
    'Filter', 'EQ3', 'AutoFilter', 'LowpassCombFilter', 'HighpassCombFilter',
    // Effects - Dynamics
    'Compressor', 'Limiter', 'Gate', 'MultibandCompressor', 'MidSideCompressor',
    // Effects - Spatial
    'Panner', 'Panner3D', 'StereoWidener', 'JCReverb', 'Convolver',
    // Effects - Pitch/Spectral
    'PitchShift', 'FrequencyShifter',
    // Effects - Utility
    'Gain', 'Volume', 'CrossFade', 'StereoFeedbackEffect', 'StereoEffect', 'Effect',
    // Components - Envelopes
    'Envelope', 'AmplitudeEnvelope', 'FrequencyEnvelope', 'ScaledEnvelope',
    // Components - Analysis
    'Analyser', 'Meter', 'FFT', 'Waveform', 'DCMeter', 'LevelMeter', 'Scope',
    // Components - Math
    'Signal', 'Multiply', 'Add', 'Subtract', 'Abs', 'Negate', 'Pow', 'Divide', 'Modulo', 'Max', 'Min', 'Clip', 'Scale', 'Pow',
    // Components - Core
    'Param', 'Timeline', 'Clock', 'Emitter', 'TimelineState',
    // Instruments
    'Instrument', 'Monophonic', 'Polyphonic',
    // Events
    'Loop', 'Part', 'Pattern', 'Sequence', 'Event', 'ToneEvent',
    // Patterns (alias for Pattern used in some Tone.js versions)
    'Pattern',
    // Transport
    'Transport', 'TransportTime', 'Ticks', 'Time', 'Frequency', 'Midi', 'BarsBeatsSixteenths',
    // Routing
    'AuxNode', 'PanVol', 'Panner', 'Panner3D', 'Merge', 'Split', 'Mono', 'Solo', 'Channel', 'Master',
    // Utilities
    'ToneAudioBuffer', 'ToneAudioBuffers', 'Buffer', 'Buffers',
    'Interval', 'Timeout', 'Draw', 'Context', 'OfflineContext',
    // Type conversion
    'TimeBase', 'FrequencyClass', 'TransportTimeClass',
  ]);

  /**
   * Common Tone.js hallucinations (invalid APIs)
   */
  private static readonly HALLUCINATIONS = [
    { pattern: /Tone\.Reverberator/, suggestion: 'Tone.Reverb' },
    { pattern: /Tone\.DrivingPattern/, suggestion: 'Tone.Pattern or Tone.Loop' },
    { pattern: /Tone\.ReverbNode/, suggestion: 'Tone.Reverb' },
    { pattern: /Tone\.Echo/, suggestion: 'Tone.FeedbackDelay or Tone.PingPongDelay' },
    { pattern: /Tone\.Sound/, suggestion: 'Tone.Player or Tone.Synth' },
    { pattern: /Tone\.Play/, suggestion: 'Tone.Transport.start() or synth.triggerAttackRelease()' },
    { pattern: /Tone\.Lfo\b/, suggestion: 'Tone.LFO' },
    { pattern: /\.startAttack\s*\(/, suggestion: 'lfo.start()' },
    { pattern: /\.setFrequency\s*\(/, suggestion: 'lfo.frequency.value = ...' },
  ];

  /**
   * Instruments that do NOT expose a `.filter` property. MonoSynth is
   * deliberately absent — it genuinely has a filter (BiquadFilter) in Tone v14.
   */
  private static readonly FILTERLESS_INSTRUMENTS = new Set([
    'Synth', 'PolySynth', 'AMSynth', 'FMSynth', 'MembraneSynth', 'MetalSynth',
    'NoiseSynth', 'DuoSynth', 'PluckSynth', 'Sampler', 'Player', 'GrainPlayer',
  ]);

  /**
   * Validate Tone.js code structure
   */
  static validate(code: string): ToneValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    // Syntax gate: malformed code is rejected at validation so repair/escalation
    // runs instead of shipping a playable that throws on load.
    errors.push(...this.validateJavaScriptSyntax(trimmed));

    // Basic structure validation
    errors.push(...this.validateStructure(trimmed));

    // Check for Tone.js references
    errors.push(...this.validateToneReferences(trimmed));

    // Check for hallucinations
    errors.push(...this.validateHallucinations(trimmed));

    // Check for common graph/property mistakes found by evaluator dogfood.
    errors.push(...this.validateGraphSemantics(trimmed));

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Compile-don't-execute gate (mirrors HydraValidator's new Function gate,
   * via the static @babel/parser already used by P5/Three validators).
   */
  private static validateJavaScriptSyntax(code: string): string[] {
    if (/^<!DOCTYPE|^<html/i.test(code.trim())) return [];

    try {
      // The shell runs the piece in a try block of a classic <script>: no
      // top-level return, await or import.
      parse(code, { sourceType: 'script' });
      return [];
    } catch (error) {
      return [`Tone.js code has invalid JavaScript syntax: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Validate Tone.js structure
   */
  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    // Must have Tone. reference or import
    const hasTone = /\bTone\./.test(code) || /import.*['"]tone['"]/.test(code);
    if (!hasTone) {
      errors.push('Tone.js code must reference Tone object or import from "tone"');
    }

    return errors;
  }

  /**
   * Validate Tone.js class references
   */
  private static validateToneReferences(code: string): string[] {
    const errors: string[] = [];

    // Check for new Tone.XXX() calls
    const classMatches = code.matchAll(/new\s+Tone\.(\w+)/g);
    for (const match of classMatches) {
      const className = match[1];
      if (!this.VALID_TONE_CLASSES.has(className)) {
        errors.push(`Tone.js: Invalid class 'Tone.${className}'`);
      }
    }

    return errors;
  }

  /**
   * Validate against common hallucinations
   */
  private static validateHallucinations(code: string): string[] {
    const errors: string[] = [];

    for (const { pattern, suggestion } of this.HALLUCINATIONS) {
      if (pattern.test(code)) {
        errors.push(`Tone.js: Invalid API - did you mean '${suggestion}'?`);
      }
    }

    return errors;
  }

  /**
   * Identifiers declared as `new Tone.<Class>` for a given set of classes —
   * used to scope property checks to actual Tone instrument receivers so
   * plain array `.filter(...)` calls are not condemned as Tone API misuse.
   */
  private static collectInstrumentNames(code: string, classNames: Set<string>): Set<string> {
    const names = new Set<string>();
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Tone\.(\w+)/g)) {
      if (classNames.has(match[2])) names.add(match[1]);
    }
    return names;
  }

  private static validateGraphSemantics(code: string): string[] {
    const errors: string[] = [];

    // Only instruments lacking a .filter property are flagged — Array.prototype
    // .filter on plain arrays/values is legitimate JavaScript and was a live
    // false-rejection class.
    const filterless = this.collectInstrumentNames(code, this.FILTERLESS_INSTRUMENTS);
    for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*filter\b/g)) {
      if (filterless.has(match[1])) {
        errors.push(`Tone.js: "${match[1]}" does not expose .filter; create Tone.Filter and connect through it`);
        break;
      }
    }

    // Only PolySynth detune is flagged: on Oscillator/Synth/MonoSynth, detune
    // is a real Signal whose .value is the supported way to set it.
    const polySynths = this.collectInstrumentNames(code, new Set(['PolySynth']));
    for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*detune\s*\.\s*value\b/g)) {
      if (polySynths.has(match[1])) {
        errors.push(`Tone.js: Do not mutate "${match[1]}.detune.value" directly on PolySynth; use set({ detune }) or an explicit LFO target`);
        break;
      }
    }

    if (/\.filter\.lfo\b/.test(code)) {
      errors.push('Tone.js: Invalid LFO target .filter.lfo; connect LFO to an explicit Tone.Filter frequency parameter');
    }

    if (/new\s+Tone\.PolySynth\s*\(\s*["']/.test(code)) {
      errors.push('Tone.js: Tone.PolySynth constructor should receive a synth class/config object, not an oscillator type string');
    }

    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Tone\.(Part|Sequence|Loop|Pattern)\b/g)) {
      const name = match[1];
      const escapedName = this.escapeRegExp(name);
      const startsInline = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*new\\s+Tone\\.(?:Part|Sequence|Loop|Pattern)[\\s\\S]*?\\)\\.start\\s*\\(`).test(code);
      const startsLater = new RegExp(`\\b${escapedName}\\.start\\s*\\(`).test(code);
      if (!startsInline && !startsLater) {
        const kind = match[0].match(/Tone\.(Part|Sequence|Loop|Pattern)/)?.[1] ?? 'event';
        errors.push(`Tone.js: Scheduled Tone.${kind} "${name}" is never started; call ${name}.start(0) before Tone.Transport.start()`);
      }
    }

    return errors;
  }

  private static escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  /**
   * Get minimum size requirement for Tone.js code
   */
  static getMinSize(): number {
    return 100; // Tone.js can be concise
  }
}
