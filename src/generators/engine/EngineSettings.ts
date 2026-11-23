/**
 * Engine settings contract, shared by every engine domain (nbe, and the next-release
 * reaction-diffusion / physarum / particle-life / lenia).
 *
 * An engine domain is deterministic code that always renders. The model's only job is to
 * pick the engine's settings from the brief, so a settings object is:
 *   - schema-checked (a wrong type or an unknown enum value is an error with the field named),
 *   - clamped (a number outside its range is pulled in and the clamp is recorded),
 *   - defaulted (a missing field takes the spec default and is recorded),
 *   - and carries one sentence saying why S1NTR chose it (`reason`, required).
 * An invalid reply returns every error at once, which the caller feeds back to the model as
 * one repair round.
 */
import { answerJson } from '../../llm/ModelOutput.js';

export type FieldSpec =
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly default: number; readonly integer?: boolean; readonly about: string }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly default: string; readonly about: string }
  | { readonly kind: 'color'; readonly default: string; readonly about: string }
  | { readonly kind: 'palette'; readonly min: number; readonly max: number; readonly default: readonly string[]; readonly about: string };

export type SettingsSpec = Readonly<Record<string, FieldSpec>>;
export type SettingValue = number | string | string[];

export interface EngineChoice<S extends object = Record<string, SettingValue>> {
  readonly engine: string;
  readonly settings: S;
  /** One sentence: why S1NTR chose these settings for this brief. */
  readonly reason: string;
  /** Fields pulled into range, as `field: from -> to`. */
  readonly clamped: readonly string[];
  /** Fields the model left out, filled from the spec default. */
  readonly defaulted: readonly string[];
}

export class EngineSettingsError extends Error {
  constructor(readonly engine: string, readonly problems: readonly string[]) {
    super(`${engine} settings invalid: ${problems.join('; ')}`);
    this.name = 'EngineSettingsError';
  }
}

export const MAX_REASON_CHARS = 280;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

/** `#abc` or `#aabbcc` to 0..255 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** Evenly spaced colour stops, dark to bright, as the [t, rgb] pairs the renderers interpolate. */
export function paletteStops(colors: readonly string[]): Array<[number, [number, number, number]]> {
  const last = Math.max(1, colors.length - 1);
  return colors.map((c, i): [number, [number, number, number]] => [i / last, hexToRgb(c)]);
}

function clampNumber(raw: number, spec: Extract<FieldSpec, { kind: 'number' }>): number {
  const bounded = Math.min(spec.max, Math.max(spec.min, raw));
  return spec.integer ? Math.round(bounded) : Math.round(bounded * 1e6) / 1e6;
}

export function validateEngineSettings<S extends object>(
  engine: string, spec: SettingsSpec, raw: unknown,
): EngineChoice<S> {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EngineSettingsError(engine, ['the reply must be one JSON object of settings']);
  }
  const input = raw as Record<string, unknown>;
  const settings: Record<string, SettingValue> = {};
  const clamped: string[] = [];
  const defaulted: string[] = [];
  for (const [name, field] of Object.entries(spec)) {
    const value = input[name];
    if (value === undefined || value === null) {
      settings[name] = Array.isArray(field.default) ? [...field.default] : (field.default as SettingValue);
      defaulted.push(name);
      continue;
    }
    if (field.kind === 'number') {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) { problems.push(`${name} must be a number from ${field.min} to ${field.max}`); continue; }
      const fixed = clampNumber(n, field);
      if (fixed !== n) clamped.push(`${name}: ${n} -> ${fixed}`);
      settings[name] = fixed;
    } else if (field.kind === 'enum') {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
      if (typeof v !== 'string' || !field.values.includes(v)) problems.push(`${name} must be one of ${field.values.join(', ')}`);
      else settings[name] = v;
    } else if (field.kind === 'color') {
      if (!isHexColor(value)) problems.push(`${name} must be a hex colour like #1a2b3c`);
      else settings[name] = value.trim().toLowerCase();
    } else {
      if (!Array.isArray(value) || value.length < field.min || value.length > field.max || !value.every(isHexColor)) {
        problems.push(`${name} must be ${field.min} to ${field.max} hex colours like #1a2b3c, darkest first`);
      } else settings[name] = value.map((c) => c.trim().toLowerCase());
    }
  }
  const reason = typeof input.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < 8) problems.push('reason must be one sentence saying why these settings fit the brief');
  if (problems.length > 0) throw new EngineSettingsError(engine, problems);
  return { engine, settings: settings as S, reason: reason.slice(0, MAX_REASON_CHARS), clamped, defaulted };
}

/** Pull the settings object out of raw model text (fences and think blocks tolerated). */
export function parseEngineReply(engine: string, text: string): unknown {
  const json = answerJson(text);
  try {
    return JSON.parse(json);
  } catch {
    throw new EngineSettingsError(engine, ['the reply was not valid JSON; return only the settings object']);
  }
}

/** The contract text the model sees: one line per field, then the reply rule. */
export function describeSettingsSpec(engine: string, spec: SettingsSpec): string {
  const lines = Object.entries(spec).map(([name, f]) => {
    if (f.kind === 'number') return `- ${name}: ${f.integer ? 'integer' : 'number'} ${f.min}..${f.max} (default ${f.default}). ${f.about}`;
    if (f.kind === 'enum') return `- ${name}: one of ${f.values.join(' | ')} (default ${f.default}). ${f.about}`;
    if (f.kind === 'color') return `- ${name}: hex colour (default ${f.default}). ${f.about}`;
    return `- ${name}: array of ${f.min}..${f.max} hex colours, darkest first (default ${f.default.join(', ')}). ${f.about}`;
  });
  return [
    `Reply with ONE JSON object of ${engine} engine settings and nothing else (no code, no markdown).`,
    'The engine renders whatever valid settings you give it; your job is to choose settings that make this brief look and move the way it describes.',
    ...lines,
    '- reason: one sentence saying why these settings fit the brief (required).',
  ].join('\n');
}
