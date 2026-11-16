/**
 * Deterministic repair for code the gate rejected over one mechanical slip.
 *
 * Each repair is a known failure class from real generations (LFM3 shard A,
 * 2026-11-15): a missing tone-mapping line, an import in a Hydra sketch, an
 * em-dash in Strudel. CodeValidator calls this only after a rejection and keeps
 * the result only if the repaired code then passes every check, so code that
 * already passes is never touched, and a repair can never make a verdict worse.
 * No repair invents content: each one adds the line the gate asks for, maps a
 * character or class name to its one valid equivalent, or drops a line the
 * runtime cannot execute.
 */

export interface RepairResult {
  readonly code: string;
  /** `domain:class` for each repair applied, in order. */
  readonly repairs: string[];
}

type Repair = { readonly id: string; readonly apply: (code: string) => string };

/** Index just past the statement that starts at `from`: the first `;` or newline after its parentheses balance. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) return c === ';' ? i + 1 : i;
  }
  return code.length;
}

function insertAfterStatement(code: string, pattern: RegExp, line: (name: string) => string): string {
  const m = pattern.exec(code);
  if (!m) return code;
  const end = statementEnd(code, m.index);
  return `${code.slice(0, end)}\n${line(m[1])}${code.slice(end)}`;
}

const LIT_MATERIAL = /THREE\.Mesh(?:Standard|Physical|Phong|Lambert|Toon)Material\b/;
const ANY_LIGHT = /THREE\.(?:Ambient|Directional|Point|Spot|Hemisphere|RectArea)Light\b/;
const TONE_MAPPED = /\.toneMapping\s*=|\btoneMappingExposure\b/;

const THREE_REPAIRS: Repair[] = [
  {
    id: 'three:lights',
    apply: code => (LIT_MATERIAL.test(code) && !ANY_LIGHT.test(code))
      ? insertAfterStatement(code, /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.Scene\s*\(/, scene =>
        `${scene}.add(new THREE.AmbientLight(0xffffff, 0.4));\n`
        + `const __keyLight = new THREE.DirectionalLight(0xffffff, 1.2);\n__keyLight.position.set(3, 4, 5);\n${scene}.add(__keyLight);`)
      : code,
  },
  {
    id: 'three:toneMapping',
    apply: code => (LIT_MATERIAL.test(code) && !TONE_MAPPED.test(code))
      ? insertAfterStatement(code, /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+THREE\.WebGLRenderer\s*\(/, r =>
        `${r}.toneMapping = THREE.ACESFilmicToneMapping;\n${r}.toneMappingExposure = 1.0;`)
      : code,
  },
];

const HYDRA_REPAIRS: Repair[] = [
  {
    id: 'hydra:imports',
    apply: code => code.replace(/^[ \t]*import\b[^\n]*\n?/gm, '').replace(/^([ \t]*)export\s+(?:default\s+)?/gm, '$1'),
  },
  {
    id: 'hydra:out',
    apply: code => {
      if (/\.out\s*\(/.test(code)) return code;
      const trimmed = code.replace(/\s+$/, '');
      const body = trimmed.replace(/;$/, '');
      return /\)$/.test(body) ? `${body}.out()\n` : code;
    },
  },
];

const TYPOGRAPHY: ReadonlyArray<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2013\u2014\u2015\u2212]/g, '-'],
  [/\u2192/g, '->'],
  [/\u2190/g, '<-'],
  [/\u2026/g, '...'],
  [/[\u00A0\u2002-\u200B\u202F]/g, ' '],
];

const STRUDEL_REPAIRS: Repair[] = [
  { id: 'strudel:ascii', apply: code => TYPOGRAPHY.reduce((c, [re, to]) => c.replace(re, to), code) },
];

/** Uniforms GenericWrapper sets every frame, with their types. Any other u_* stays the model's to declare. */
const WRAPPER_UNIFORMS: Record<string, string> = { u_time: 'float', u_resolution: 'vec2', u_mouse: 'vec2' };

const GLSL_REPAIRS: Repair[] = [
  {
    id: 'glsl:uniforms',
    apply: code => {
      const declared = new Set([...code.matchAll(/\buniform\s+\w+\s+([A-Za-z_]\w*)\s*[,;]/g)].map(m => m[1]));
      const missing = Object.keys(WRAPPER_UNIFORMS).filter(u => !declared.has(u) && new RegExp(`\\b${u}\\b`).test(code));
      if (missing.length === 0) return code;
      const decl = missing.map(u => `uniform ${WRAPPER_UNIFORMS[u]} ${u};`).join('\n');
      const precision = /^[ \t]*precision\s+\w+\s+float\s*;[^\n]*\n?/m.exec(code);
      if (!precision) return `${decl}\n${code}`;
      const at = precision.index + precision[0].length;
      return `${code.slice(0, at)}${precision[0].endsWith('\n') ? '' : '\n'}${decl}\n${code.slice(at)}`;
    },
  },
];

/** Invented Tone classes with exactly one real counterpart. Others (Tone.Note, Tone.AudioContext) have none. */
const TONE_ALIASES: Record<string, string> = { OSC: 'Oscillator', NoiseSource: 'Noise' };

const TONE_REPAIRS: Repair[] = [
  {
    id: 'tone:aliases',
    apply: code => code.replace(/\bTone\.([A-Za-z]+)\b/g, (m, name: string) => TONE_ALIASES[name] ? `Tone.${TONE_ALIASES[name]}` : m),
  },
];

const REPAIRS: Record<string, Repair[]> = {
  three: THREE_REPAIRS,
  hydra: HYDRA_REPAIRS,
  strudel: STRUDEL_REPAIRS,
  glsl: GLSL_REPAIRS,
  shader: GLSL_REPAIRS,
  tone: TONE_REPAIRS,
};

/** Apply every repair for the domain; null when none changed anything. */
export function repairRejected(code: string, domain: string): RepairResult | null {
  const repairs: string[] = [];
  let current = code;
  for (const repair of REPAIRS[domain] ?? []) {
    const next = repair.apply(current);
    if (next !== current) {
      repairs.push(repair.id);
      current = next;
    }
  }
  return repairs.length > 0 ? { code: current, repairs } : null;
}
