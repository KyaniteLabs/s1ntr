/**
 * registerGenerators - Registers all generators with the GeneratorRegistry.
 *
 * Each generator declares what it can handle via canHandle(prompt) -> confidence (0-1).
 * Confidence values are ordered by specificity to avoid ambiguity:
 *   - 0.9: highly specific patterns (lenia, ray march, sdf, fragment)
 *   - 0.7: moderately specific patterns (particle, galaxy, cellular, automata, flow field, glsl, shader)
 *   - 0.5: broader patterns (3d, three.js, three)
 *   - 0.0: LLM fallback (always available, never wins against specialized generators)
 *
 * Keyword-based routing is centralized here so RalphLoop and P5Generator
 * use the same dispatch logic.
 */

import { generatorRegistry, GeneratorEntry, type GeneratorResult } from './GeneratorRegistry.js';
import type { TierBasedGenerator } from './TierBasedGenerator.js';
import { nextDomainActive } from '../config/nextDomains.js';

async function generateWithFitnessMetadata(
  generator: TierBasedGenerator,
  generate: () => Promise<string>,
): Promise<GeneratorResult> {
  const code = await generate();
  return { code, ...generator.getLastFitnessMetadata() };
}
import { pluginLoader } from '../plugins/PluginLoader.js';
import { Logger } from '../utils/Logger.js';

// --- Shared canHandle helpers ---

/** Confidence for shader/glsl patterns */
const shaderConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // ray march, sdf, fragment are very specific -> higher confidence
  if (/ray\s*march|sdf|fragment/.test(lower)) return 0.9;
  if (/shader|glsl/.test(lower)) return 0.7;
  return 0;
};

/** Confidence for 3D/Three.js patterns */
const threeConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (!/target creative domain:\s*three/.test(lower) && /\b(do not|don't|dont|never|avoid)\b[^.\n]*(three\.js|threejs|\bthree\b)/.test(lower)) return 0;
  // High confidence for explicit three.js mentions
  if (/three\.js|threejs|\bthree\b/.test(lower)) return 0.95;
  // Strong confidence for 3D with specific keywords
  if (/\b3d\b.*\b(scene|cube|sphere|model|mesh|geometry|import|webgl|camera|light|rotation|composition|depth)/.test(lower)) return 0.90;
  // Moderate for generic 3D
  if (/\b3d\b|webgl/.test(lower)) return 0.75;
  return 0;
};

/** Confidence for HTML/web patterns */
const htmlConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Portfolio, landing page, dashboard are specific -> higher confidence
  if (/portfolio|landing\s*page|dashboard|web\s*app/.test(lower)) return 0.95;
  // Explicit HTML/CSS mentions
  if (/\bhtml\b|\bcss\b|\bweb\s+(component|page|widget)/.test(lower)) return 0.90;
  if (/web\s*page|website|css\s*design/.test(lower)) return 0.75;
  if (/web\s*dev|ui\s*component|form|spa/.test(lower)) return 0.65;
  return 0;
};

/**
 * Confidence for D3 data-visualization patterns.
 *
 * DataViz output is an HTML page (it shares the html render path), so its
 * keywords overlap with html ("dashboard"). To keep chart/graph prompts routed
 * to D3 instead of plain HTML, explicit dataviz signals score ABOVE html's 0.95
 * dashboard match; a bare "dashboard" with no chart/data signal stays with html.
 */
const datavizConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (!/target creative domain:\s*dataviz/.test(lower) && /\b(do not|don't|dont|never|avoid)\b[^.\n]*(d3|chart|visualization|dataviz)/.test(lower)) return 0;
  // Explicit D3 / data-viz mentions win decisively.
  if (/\bd3(?:\.js)?\b|\bdata\s*viz\b|\bdata\s+visuali[sz]ation\b/.test(lower)) return 0.97;
  // Concrete chart genres are strong dataviz signals.
  if (/\b(bar|line|scatter|pie|donut|area|bubble)\s+chart\b|\bhistogram\b|\bnetwork\s+graph\b|\bforce\s+graph\b|\btreemap\b|\bheatmap\b|\bchord\s+diagram\b|\bsankey\b/.test(lower)) return 0.96;
  // Generic chart/plot/graph/visualization requests.
  if (/\bchart\b|\bplot\b|\bgraph\b(?!ic)|\bvisuali[sz]ation\b|\bvisuali[sz]e\s+data\b/.test(lower)) return 0.9;
  return 0;
};

/**
 * Confidence for the `custom` catch-all (formerly `meta`) generator.
 *
 * CRITICAL — `custom` is EXPLICIT-ONLY / LOW priority. It is the open-ended catch
 * for mediums OUTSIDE the 14 fixed domains, so it must NEVER outscore or hijack a
 * prompt that maps to a real domain (p5/three/dataviz/...), and it must NEVER be
 * the default/fallback for unknown prompts. It only fires on:
 *   1. The explicit `--domain custom` route (injected as "Target creative domain: custom"
 *      by the CLI/intent path — forced to confidence 1 by dispatchForRequestedDomain,
 *      but scored here too so detection agrees).
 *   2. Clear meta KEYWORDS that explicitly ask for a custom/arbitrary medium.
 * Everything else returns 0 so default routing is unchanged.
 */
const customConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Explicit route: the CLI/intent layer injects this when --domain custom is used.
  if (/target creative domain:\s*(?:custom|meta)\b/.test(lower)) return 0.99;
  // Explicit "use the custom-domain generator" style asks.
  if (/\b(custom|arbitrary|invent(?:ed)?|made[-\s]?up|novel)\s+(creative\s+)?(domain|medium)\b/.test(lower)) return 0.95;
  if (/\b(any|some)\s+medium\b/.test(lower)) return 0.95;
  if (/\binvent\s+a\s+medium\b|\bmake\s+up\s+a\b|\ba\s+medium\s+where\b|\bmeta[-\s]?generator\b|\bcustom[-\s]?domain\b/.test(lower)) return 0.95;
  return 0;
};

/**
 * Confidence for the `blender` (bpy headless render) generator. Explicit-only
 * like custom: the --domain route, or a prompt that clearly names bpy / a
 * Blender scene. A bare "blender" word (smoothies, metaphors) scores 0.
 */
const blenderConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (/target creative domain:\s*blender\b/.test(lower)) return 0.99;
  if (/\bbpy\b|\bblender\s+(?:scene|render|python|script|3d|file)\b|\b(?:in|with|using|for)\s+blender\b/.test(lower)) return 0.95;
  return 0;
};

/** Confidence for SVG/vector asset patterns */
const svgConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (!/target creative domain:\s*svg/.test(lower) && /\b(do not|don't|dont|never|avoid)\b[^.\n]*(svg|vector)/.test(lower)) return 0;
  if (/\bsvg\b|scalable\s+vector|vector\s+(logo|icon|diagram|art|asset)/.test(lower)) return 0.95;
  if (/\b(logo|icon|diagram|flowchart|laser|cutfile|cut\s*file|cnc|toolpath|sticker|decal)\b/.test(lower)) return 0.85;
  if (/\bvector\b|\billustration\b.*\bpaths?\b/.test(lower)) return 0.75;
  return 0;
};

/** Confidence for ASCII art patterns */
const asciiConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Explicit ASCII art mentions
  if (/\bascii\s*art\b/.test(lower)) return 0.95;
  if (/\bascii\b/.test(lower)) return 0.90;
  // Character/text art patterns
  if (/text\s*art|character\s*art|glyph|symbol.*art/.test(lower)) return 0.75;
  if (/\bart\b.*\btext\b|\btext\b.*\bpattern/.test(lower)) return 0.65;
  return 0;
};

/**
 * Confidence for text generative art (concrete poetry, word art, etc.)
 * 
 * HIGHER confidence than ASCII for creative text prompts to ensure
 * textgen wins over ascii for poetry/word-art requests.
 */
const textgenConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Explicit text generative mentions (highest priority)
  if (/\bconcrete\s+poetry\b|\bword\s+art\b|\btypographic\s+art\b/.test(lower)) return 0.95;
  if (/\btext\s+generative\b|\bexperimental\s+poetry\b/.test(lower)) return 0.95;
  
  // Strong creative text patterns
  if (/\bpoem\b|\bpoetry\b.*\b(visual|shape|form)\b/.test(lower)) return 0.90;
  if (/\bwords\b.*\b(arranged|scattered|cascade|flow|drip)\b/.test(lower)) return 0.90;
  if (/\btypography\b.*\b(experimental|creative|art)\b/.test(lower)) return 0.85;
  
  // Moderate creative text patterns
  if (/\btext\s+(only|based)\s+(art|composition)\b/.test(lower)) return 0.80;
  if (/\bletters?\b.*\b(form|shape|pattern)\b/.test(lower)) return 0.75;
  
  // Avoid capturing pure ASCII requests (let ascii generator handle those)
  if (/\bascii\b/.test(lower)) return 0;
  
  return 0;
};

/** Confidence for CSS kinetic typography / motion HTML art */
const kineticConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (/\bkinetic\s+(typography|type|text|css)\b|\bcss\s+kinetic\b/.test(lower)) return 0.95;
  if (/\b(animated|moving|orbiting|spinning|pulsing)\s+(words?|letters?|typography|text)\b/.test(lower)) return 0.85;
  if (/\b(typography|text)\b.*\b(animated|moving|kinetic|orbiting|spinning|pulsing)\b/.test(lower)) return 0.85;
  return 0;
};

/** Confidence for Strudel music patterns */
const strudelConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Explicit Strudel/Tidal mentions
  if (/\bstrudel\b|\btidal\b|live\s*coding\s*music/.test(lower)) return 0.95;
  // Strong pattern-based music indicators
  if (/\b(techno|drum|beat|rhythm|sequencer|pattern)\b.*\bmusic\b/.test(lower)) return 0.85;
  if (/\bcycle\b|\bnote\b|\bchord\b|\bmelody\b.*\bsequence/.test(lower)) return 0.75;
  // Moderate music matches. Bare "pattern" is dropped: it hijacked visual
  // prompts ("flowing pattern of hexagons") into the music generator (D1). The
  // music sense of "pattern" is still caught at 0.85 above when paired with
  // "music". Word boundaries keep "beat"/"bass" from substring-matching
  // "heartbeat"/non-music words; explicit "pattern + music" stays at 0.85.
  if (/\b(beat|drum|bass)\b|synth.*sequence/.test(lower)) return 0.65;
  return 0;
};

/** Confidence for Hydra video synth patterns */
const hydraConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (/\bglsl\b|\bfragment\s+shader\b|\bshader\b/.test(lower)) return 0;
  if (/hydra|video\s*synth|visual\s*synthesis/.test(lower)) return 0.95;
  if (/kaleid|oscillator|modulate.*video/.test(lower)) return 0.7;
  return 0;
};

/** Confidence for Tone.js audio synthesis */
const toneConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  // Explicit Tone.js mentions
  if (/\btone\.?js\b|\btonejs\b|web\s*audio\s*api/.test(lower)) return 0.95;
  // Strong synthesis indicators
  if (/\bsynth\b|\bsynthesizer\b.*\bjs\b/.test(lower)) return 0.90;
  // Audio effect indicators
  if (/\bbass\b|\bdrone\b|\barp\b|\bsequencer\b|\bdelay\b|\breverb\b/.test(lower)) return 0.80;
  // Generic synthesis
  if (/\bsynth\b|\bsynthesizer\b/.test(lower)) return 0.70;
  return 0;
};

/** Confidence for explicit p5.js / Processing-style sketch requests */
const p5Confidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (/\bp5(?:\.js)?\b|\bp5js\b|\bprocessing\b/.test(lower)) return 0.95;
  if (/\b(createcanvas|setup\(\)|draw\(\)|mousepressed|keypressed)\b/.test(lower)) return 0.9;
  if (/\b(sketch|canvas)\b.*\b(generative|interactive|animated|art)\b/.test(lower)) return 0.75;
  if (/\bgenerative\s+sketch\b|\binteractive\s+sketch\b/.test(lower)) return 0.75;
  return 0;
};
/**
 * Confidence for the NBE (Neural Bloom Engine) cascade neural-field domain.
 *
 * Specialized deterministic generator — see the exemption documented in
 * NbeGenerator.ts. Only routes on explicit NBE / neural-field cues so it never
 * competes with the LLM for ordinary prompts.
 */
const nbeConfidence = (prompt: string): number => {
  const lower = prompt.toLowerCase();
  if (/\b(do not|don't|dont|never|avoid)\s+(?:use\s+)?nbe\b/.test(lower)) return 0;
  if (/\bnbe\b|\bneural\s*bloom\b/.test(lower)) return 0.95;
  if (/\b(cascade\s+neural\s+field|neural[-\s]field\s+(?:fluid|render|sim|simulation|art))\b/.test(lower)) return 0.9;
  if (/\bflowing\s+fluid\s+art\b/.test(lower)) return 0.7;
  return 0;
};

// --- Generator entries ---



const shaderEntry: GeneratorEntry = {
  name: 'shader',
  canHandle: shaderConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { ShaderGenerator } = await import('./glsl/ShaderGenerator.js');
    const gen = new ShaderGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const threeEntry: GeneratorEntry = {
  name: 'three',
  canHandle: threeConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { ThreeGenerator } = await import('./three/ThreeGenerator.js');
    const gen = new ThreeGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

/** Datamosh routes only on an explicit target domain: the bare word never selects it. */
export const datamoshConfidence = (prompt: string): number =>
  /target creative domain:\s*datamosh\b/i.test(prompt) ? 0.99 : 0;

const datamoshEntry: GeneratorEntry = {
  name: 'datamosh',
  canHandle: datamoshConfidence,
  generate: async (prompt: string) => {
    const { DatamoshGenerator } = await import('./next/DatamoshGenerator.js');
    const { LLMClient } = await import('../llm/LLMClient.js');
    return { code: await new DatamoshGenerator(new LLMClient({ role: 'generator' })).generate(prompt) };
  },
};

const htmlEntry: GeneratorEntry = {
  name: 'html',
  canHandle: htmlConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { HTMLWebGenerator } = await import('./html/HTMLWebGenerator.js');
    const gen = new HTMLWebGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, {
      responsive: true,
      includeAnimations: true,
      darkMode: true,
      ...params,
    }));
  },
};

const datavizEntry: GeneratorEntry = {
  name: 'dataviz',
  canHandle: datavizConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { DataVizGenerator } = await import('./dataviz/DataVizGenerator.js');
    const gen = new DataVizGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const customEntry: GeneratorEntry = {
  name: 'custom',
  canHandle: customConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { CustomGenerator } = await import('./custom/CustomGenerator.js');
    const gen = new CustomGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const blenderEntry: GeneratorEntry = {
  name: 'blender',
  canHandle: blenderConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { BlenderGenerator } = await import('./blender/BlenderGenerator.js');
    const gen = new BlenderGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const svgEntry: GeneratorEntry = {
  name: 'svg',
  canHandle: svgConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { SVGGenerator } = await import('./svg/SVGGenerator.js');
    const gen = new SVGGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const asciiEntry: GeneratorEntry = {
  name: 'ascii',
  canHandle: asciiConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { ASCIIArtGenerator } = await import('./ascii/ASCIIArtGenerator.js');
    const gen = new ASCIIArtGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, {
      style: 'abstract',
      width: 60,
      height: 12,
      ...params,
    }));
  },
};

const strudelEntry: GeneratorEntry = {
  name: 'strudel',
  canHandle: strudelConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { StrudelGenerator } = await import('./strudel/StrudelGenerator.js');
    const gen = new StrudelGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const hydraEntry: GeneratorEntry = {
  name: 'hydra',
  canHandle: hydraConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { HydraGenerator } = await import('./hydra/HydraGenerator.js');
    const gen = new HydraGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const toneEntry: GeneratorEntry = {
  name: 'tone',
  canHandle: toneConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { ToneGenerator } = await import('./tone/ToneGenerator.js');
    const gen = new ToneGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

/**
 * Text Generative Art entry
 * 
 * Handles concrete poetry, word art, experimental typography.
 * Optimized for small/fast models due to low token count.
 */
const textgenEntry: GeneratorEntry = {
  name: 'textgen',
  canHandle: textgenConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { TextGenerativeGenerator } = await import('./textgen/TextGenerativeGenerator.js');
    const gen = new TextGenerativeGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, {
      form: 'freeform',
      style: 'minimal',
      maxLines: 30,
      maxWidth: 60,
      unicode: true,
      ...params,
    }));
  },
};

const kineticEntry: GeneratorEntry = {
  name: 'kinetic',
  canHandle: kineticConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { KineticGenerator } = await import('./kinetic/KineticGenerator.js');
    const gen = new KineticGenerator();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

const p5Entry: GeneratorEntry = {
  name: 'p5',
  canHandle: p5Confidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { P5GeneratorV2 } = await import('./p5/P5GeneratorV2.js');
    const gen = new P5GeneratorV2();
    return generateWithFitnessMetadata(gen, () => gen.generate(prompt, params));
  },
};

/**
 * NBE (Neural Bloom Engine) entry.
 *
 * Specialized DETERMINISTIC generator (cascade neural-field physics simulation),
 * not an LLM-routed generator and not a template fallback. The exemption from
 * the "No Template Fallbacks" rule is documented in NbeGenerator.ts. Accepts
 * params for which cascade weights to use ({@link NbeGeneratorParams}).
 */
const nbeEntry: GeneratorEntry = {
  name: 'nbe',
  canHandle: nbeConfidence,
  generate: async (prompt: string, params?: Record<string, unknown>) => {
    const { NbeGenerator } = await import('./nbe/NbeGenerator.js');
    const gen = new NbeGenerator();
    return gen.generate(prompt, params as never);
  },
};

let pluginSummary: PluginLoadSummary = { loaded: 0, total: 0, failed: 0 };

const staticGeneratorEntries: GeneratorEntry[] = [
  shaderEntry,
  threeEntry,
  datavizEntry,
  customEntry,
  blenderEntry,
  svgEntry,
  htmlEntry,
  asciiEntry,
  kineticEntry,
  textgenEntry,
  strudelEntry,
  hydraEntry,
  toneEntry,
  p5Entry,
  nbeEntry,
];

/**
 * Outcome of a plugin-load attempt.
 *
 * `total` is how many plugin directories declared a manifest, `loaded` how many
 * imported successfully, and `failed` how many threw (e.g. a declared
 * `entry: "index.js"` that was never compiled, so the dynamic import throws
 * ENOENT). Reporting all three keeps a 0/N load HONEST instead of masking it as
 * a plain success/failure boolean.
 */
interface PluginLoadSummary {
  loaded: number;
  total: number;
  failed: number;
}

/**
 * Try to load plugins from plugins/ directory.
 *
 * Never throws on a missing compiled entry — the loader skips each broken plugin
 * gracefully (see PluginLoader.loadPlugin) and we surface the real counts so a
 * 0/N load is visible, not swallowed.
 */
async function loadPlugins(): Promise<PluginLoadSummary> {
  try {
    const results = await pluginLoader.loadAll();

    // Register loaded plugins with GeneratorRegistry
    for (const plugin of pluginLoader.getAllPlugins()) {
      generatorRegistry.register({
        name: plugin.manifest.id,
        canHandle: plugin.canHandle || (() => 0.1),
        generate: plugin.generate.bind(plugin),
      });
    }

    const loaded = results.filter((r) => r.success).length;
    return { loaded, total: results.length, failed: results.length - loaded };
  } catch (error) {
    Logger.warn('registerGenerators', 'Failed to load plugins:', error);
    return { loaded: 0, total: 0, failed: 0 };
  }
}

/**
 * Register missing built-in generators without duplicating plugin-provided domains.
 */
function registerMissingStaticGenerators(): number {
  const registeredNames = new Set(generatorRegistry.getAll().map((entry) => entry.name));
  let registered = 0;

  // Next-release domains stay unregistered until their flag is on (SINTER_NEXT_DOMAINS).
  const entries = nextDomainActive('datamosh') ? [...staticGeneratorEntries, datamoshEntry] : staticGeneratorEntries;
  for (const entry of entries) {
    if (registeredNames.has(entry.name)) continue;
    generatorRegistry.register(entry);
    registeredNames.add(entry.name);
    registered += 1;
  }

  return registered;
}

let initInFlight: Promise<void> | null = null;

/**
 * Register all generators with the singleton registry.
 * Call once at application startup.
 *
 * First tries to load from plugins/, falls back to static registration.
 *
 * Cold-start is awaited through a single shared promise (`initInFlight`) so that
 * N concurrent callers (e.g. parallel candidates) run plugin loading once instead
 * of racing the registry and double-loading. The promise is cleared on completion,
 * after which the cheap `alreadyRegistered` short-circuit handles subsequent calls.
 */
export async function registerAllGenerators(): Promise<void> {
  if (generatorRegistry.getAll().length > 0) {
    return;
  }
  if (initInFlight) {
    return initInFlight;
  }

  // Await a local handle (not the shared mutable) and only clear the shared slot
  // if it still points at our promise — this coalesces concurrent cold-starts
  // without the `require-atomic-updates` race of reassigning across an await.
  const pending = (async () => {
    // Try to load plugins first on an empty registry.
    pluginSummary = await loadPlugins();

    const missingStaticCount = registerMissingStaticGenerators();

    if (pluginSummary.total === 0) {
      // No plugin manifests were found at all — pure static registration.
      Logger.info('registerGenerators', `Registered ${missingStaticCount} static generators`);
    } else {
      // Plugins were attempted. Report the HONEST outcome — including any that
      // failed (e.g. a declared compiled entry that does not exist) — instead of
      // masking a 0/N load as a success.
      const { loaded, total, failed } = pluginSummary;
      const failureNote = failed > 0 ? ` (${failed} missing compiled entry)` : '';
      Logger.info(
        'registerGenerators',
        `plugins: ${loaded}/${total} loaded${failureNote}; registered ${missingStaticCount} static generators`,
      );
    }
  })();
  initInFlight = pending;

  try {
    await pending;
  } finally {
    if (initInFlight === pending) {
      initInFlight = null;
    }
  }
}

// Re-export for convenience
export {
  shaderConfidence,
  threeConfidence,
  svgConfidence,
  htmlConfidence,
  datavizConfidence,
  customConfidence,
  blenderConfidence,
  asciiConfidence,
  textgenConfidence,
  strudelConfidence,
  hydraConfidence,
  toneConfidence,
  kineticConfidence,
  p5Confidence,
  nbeConfidence,
};
