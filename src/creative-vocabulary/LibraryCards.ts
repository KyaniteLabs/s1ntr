/**
 * LibraryCards — the generator-facing vocabulary for every vendored
 * capability library (#1000 integration phase 1). One card per library:
 * what it is in one line, the 5 highest-payoff calls, and the global or
 * import name the piece uses. The prompt surfaces (prompt-organ, PM lane)
 * consume these verbatim — token-cheap by design.
 *
 * Usage in a wrapped piece: request the ids via WrapOptions.libraries; the
 * wrapper injects the tags. Script builds expose a window global; module
 * builds are importmap ids (`import { x } from "culori"` style works).
 */
export interface LibraryCard {
  readonly id: string;
  readonly summary: string;
  readonly access: string;
  readonly highPayoffCalls: readonly string[];
  /** Composition rules the library itself demands (its own AGENTS.md law);
   * absent on libraries with no usage doctrine. Rendered like the calls. */
  readonly rules?: readonly string[];
  /** When set, the card is only ever offered to these domains (never as random filler elsewhere). */
  readonly domains?: readonly string[];
}

export const LIBRARY_CARDS: readonly LibraryCard[] = [
  { id: 'culori', summary: 'Perceptual color science (OKLCH ramps, deltaE, format round-trips). Build palettes in OKLCH — never hex-lerp.',
    access: 'global `culori` (script)',
    highPayoffCalls: ['culori.oklch("#ff6b35")', 'culori.formatHex(culori.mix(a, b, 0.5, "oklch"))', 'culori.interpolate([c1,c2,c3])(t)', 'culori.differenceEuclideanOklch("")(a,b)', 'culori.palette? — build ramps via interpolate samples'] },
  { id: 'd3', domains: ['html', 'custom', 'kinetic'], summary: 'Full d3 7 (ISC) — force layouts, hierarchies, scales, shapes and easing as raw material for a custom piece.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.forceSimulation(nodes).force("charge", d3.forceManyBody())', 'd3.hierarchy(tree).sum(d => d.v)', 'd3.treemap().size([w,h])(root)', 'd3.scaleSequential(d3.interpolateTurbo)', 'd3.line().curve(d3.curveCatmullRom)(points)'],
    rules: ['a piece, not a chart: map the layout onto the composition instead of labelling axes', 'seed or fix the simulation (tick a set count) so frames are reproducible'] },
  { id: 'd3-delaunay', summary: 'Voronoi/Delaunay tessellation — stippling, organic-cell mosaics, nearest-neighbor deposition.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.Delaunay.from(points)', 'delaunay.voronoi([0,0,w,h])', 'voronoi.cellPolygon(i)', 'delaunay.hull', 'd3.Delaunay.from(pts).voronoi(bounds).render()' ] },
  { id: 'd3-contour', summary: 'Isolines from scalar fields (marching squares) — topographic paintings from any noise/audio field.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.contours().size([w,h]).thresholds(7)(values)', 'contour.value(d => d.v)', 'contour.coordinates', 'd3.contours().smooth(true)(field)', 'contour.thresholds(d3.range(-1.5, 2, 0.5))'] },
  { id: 'perfect-freehand', summary: 'Pressure-style hand-drawn strokes — the human-hand signature (anti-generated-look).',
    access: 'import { getStroke } from "perfect-freehand"',
    highPayoffCalls: ['getStroke(points)', 'getStroke(points, { size: 8, thinning: 0.6 })', 'getStroke(points, { simulatePressure: true })', 'const o = getStroke(pts); ctx.beginPath(); ctx.moveTo(...o[0]); for (const p of o) ctx.lineTo(...p); ctx.fill() // the outline polygon; draw it yourself', 'getStroke(pts, { streamline: 0.4, easing: t => t*t })'] },
  { id: 'roughjs', summary: 'Seeded sketchy rendering — hachure fills, tremored outlines, style-axis novelty from render mode.',
    access: 'global `rough` (script)',
    highPayoffCalls: ['rough.canvas(canvas).rectangle(x,y,w,h, {seed: 42})', 'rc.circle(cx,cy,r, {roughness: 2.2, seed})', 'rc.path(svgPath, { fill: "steelblue", fillStyle: "hachure" })', 'rough.generator().line(x1,y1,x2,y2)', 'rc.polygon(points, { bowing: 1.4 })'] },
  { id: 'tonaljs', summary: 'Theory-correct harmony — progressions that resolve, chord detection both directions.',
    access: 'import { Chord, Scale, Note } from "tonaljs"',
    highPayoffCalls: ['Chord.get("Cmaj7").notes', 'Chord.detect(["D","F#","A","C"])', 'Scale.get("C major").notes', 'Note.midi("c4")', 'Chord.get("D7").intervals'] },
  { id: 'matter-js', summary: 'Believable 2D physics — weight, collision, stacking. The largest perceived-craft jump per byte.',
    access: 'global `Matter` (script)',
    highPayoffCalls: ['Matter.Engine.create()', 'Matter.Bodies.circle(x,y,r)', 'Matter.Composite.add(engine.world, body)', 'Matter.Engine.update(engine, 16.67)', 'Matter.Events.on(engine, "collisionStart", cb)'] },
  { id: 'paper', summary: 'Boolean vector ops (union/offset/intersect) + print-grade SVG export.',
    access: 'global `paper` (script)',
    highPayoffCalls: ['new paper.Path.Circle(...)', 'path1.unite(path2)', 'path.intersect(other)', 'path.exportSVG()', 'paper.project.activeLayer.children'] },
  { id: 'fontkit', summary: 'Font parsing + SUBSETTING (750KB font -> 12KB self-contained specimen) + layout metrics.',
    access: 'global `fontkit` (script)',
    highPayoffCalls: ['fontkit.create(buffer)', 'font.layout("Liminal")', 'font.subsetOutput?.(glyphs)', 'font.glyphsForString("Hi")', 'font.getAdvanceWidth("Hi", fontSize)'] },
  { id: 'd3-geo', summary: 'Map projections as aesthetic distortion — globes, unfoldings, great-circle arcs.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.geoOrthographic()', 'd3.geoPath(projection)', 'd3.geoGraticule10()', 'd3.geoDistance(a, b)', 'd3.geoInterpolate(lisbon, nyc)(0.5)'] },
  { id: 'twgl', summary: 'Raw-WebGL helpers without framework weight — GPGPU ping-pong sims inside the p5/glsl lanes.',
    access: 'global `twgl` (script)',
    highPayoffCalls: ['twgl.createBufferInfoFromArrays(gl, arrays)', 'twgl.setBuffersAndAttributes(gl, programInfo, bi)', 'twgl.drawBufferInfo(gl, bi)', 'twgl.createProgramInfo(gl, [vs, fs])', 'twgl.createFramebufferInfo(gl)'] },
  { id: 'rapier2d', summary: 'DETERMINISTIC wasm physics — same seed replays identically (judgeable accidents).',
    access: 'import RAPIER from "rapier2d"',
    highPayoffCalls: ['await RAPIER.init()', 'new RAPIER.World({x:0, y:-9.81})', 'world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x,y))', 'world.step()', 'RAPIER.ColliderDesc.ball(r)'] },
  { id: 'harfbuzz', summary: 'True text shaping incl. Arabic/Indic joining — multilingual kinetic typography.',
    access: 'import hb from "harfbuzz" (wasm companion auto-fetched)',
    highPayoffCalls: ['hb.createBlob(fontData)', 'hb.createFace(blob, 0)', 'hb.createFont(face)', 'font.shape(text, buffer)', 'font.glyphToPath(glyphId)'] },
  { id: 'three-webgpu', summary: 'WebGPU compute substrate (compute shaders, 10M-particle fields) — OPT-IN; default three stays 0.160 for legacy byte-tie. HEADLESS STATUS: module resolution verified; WebGPU FRAMES NOT verified (SwiftShader fleets expose WebGL2 only — WebGPU needs Dawn flags not present in CI). Treat render-green as unproven until the renderer lane adds them.',
    access: 'import * as THREE from "three-webgpu" (importmap)',
    highPayoffCalls: ['new THREE.WebGPURenderer({ antialias: true })', 'await renderer.init()', 'renderer.computeAsync(computePipeline)', 'THREE.TSL.uniform()', 'renderer.setAnimationLoop(fn)'] },
  { id: 'three-tsl', summary: 'TSL node shaders — one vocabulary compiling to BOTH GLSL and WGSL.',
    access: 'import ... from "three-tsl" (importmap; pairs three-webgpu)',
    highPayoffCalls: ['import { uv, vec4, float, mx_noise_float } from "three-tsl"', 'material.colorNode = uv().mul(...)', 'const n = mx_noise_float(uv(), 1)', 'positionNode = positionLocal.add(...)', 'node.toVar()'] },
  { id: 'three-gpu-pathtracer', summary: 'Physically-based studio-lit stills — a print product line. PEER FLOOR three >=0.180: pair with libraries:["three-webgpu", ...] so this piece\'s bare three re-points to 0.185.1 (auto-remap). Still renders NOT verified headless — SwiftShader renderer lane owns that proof.',
    access: 'import { PathTracingRenderer } from "three-gpu-pathtracer" (importmap; peer three)',
    highPayoffCalls: ['new PathTracingRenderer(renderer)', 'pathTracer.scene = scene', 'pathTracer.camera = camera', 'new PhysicalPathTracingMaterial()', 'pathTracer.renderSample()'] },
  { id: 'holospot', summary: 'Holographic foils for three.js meshes — seven foils, material ids ONLY: "prism" (Prism Rainbow), "shatter" (Gold Shatter), "nebula" (Nebula Glitter), "sparkle" (Sky Sparkle), "vortex" (Gilded Vortex), "volume" (Volume Hologram), "emboss" (Foil Emboss); applied via holo.apply(mesh, { material: id })/holo.card. Peer three >=0.170; pair with three-webgpu so bare three remaps to the 0.185.1 WebGL build. Assets load from /vendor/holospot/0.1.0/assets/.',
    access: 'import * as THREE from "three"; import { Holo } from "holospot" (importmap). WebGL only: renderer = new THREE.WebGLRenderer() from bare "three" (never "three-webgpu", which has no WebGLRenderer), and the renderer is Holo\'s FIRST argument',
    highPayoffCalls: ['const holo = new Holo(new THREE.WebGLRenderer({ antialias: true }))', 'holo.apply(mesh, { material: "nebula", sizeMm: 120 })', 'holo.card({ material: "emboss", settings: { "emboss.logo": "/logos/koru.svg" } })', 'renderer.setAnimationLoop(() => holo.render(scene, camera)) // holo.render is the whole per-frame call; Holo has no update()', 'holo.get(card).set({ "nebula.baseColor": "#101030" })'],
    rules: ['one hero holo object, few total — each holo object is its own heavy render pass', 'scene holds ONLY holo objects so holo.render uses replace mode (kit background/glare/DOF); other meshes/grids/particles force flat over mode', 'new Holo(renderer, { background: "black" }) — match the page; it also drives the foil lighting', 'frame with the kit: const obj = holo.apply(mesh, {...}); await obj.ready; shotCamera(camera, obj, { aspect }); shotRotation(obj.pose)', 'holo.card returns the mesh: scene.add(cardMesh); const obj = holo.get(cardMesh); await obj.ready, then shotCamera(camera, obj)', 'real exports only: Holo, shotCamera, shotRotation, MATERIAL_IDS', 'light with holo.setScene({"studio.preset": "studio"}) (or spot, softbox, strip, dark, desk, office, raking); three.js lights do nothing; no `studio` export', 'colour play needs slow motion — slow rotation, pointer tilt, or orbit; a static object is a dead foil', 'holo.render(scene, camera) is the only frame call — never also renderer.render for that frame', 'never fake foil with MeshPhysicalMaterial iridescence (or CSS gradients/textures) — use holo.apply/holo.card', 'sizeMm is the object\'s real size in mm (default 90) — pattern scale depends on it', 'holo.apply options: material, sizeMm, settings, look, mapping, doubleSided, structureScale, scene', 'holo.card options: material, widthMm, heightMm, size, settings, look, scene — NO sizeMm (ignored: sub-pixel mesh)', 'card size: widthMm/heightMm in mm (default 63 x 88); size = longer side in scene units', 'unknown option names fail validation', 'start from the closest recipe and change it: paper card (holo.card), primitive mesh (holo.apply), or a loaded GLB mesh (holo.apply)'] },
  { id: 'sinter-glsl', domains: ['glsl', 'shader'], summary: 'Sinter GLSL chunk kit — tested building blocks pulled into your fragment shader with #include lines (GLSL ES 1.00). No libraries: line needed; the include is the whole mechanism.',
    access: 'put `#include <sinter/NAME>` on its own line at the top of the shader (noise, warp, palette, sdf, crt); each chunk is expanded once, shaders without an include are untouched',
    highPayoffCalls: ['#include <sinter/noise> -> sn_fbm(vec2 p), sn_vnoise(vec2 p), sn_hash21(vec2 p)', '#include <sinter/warp> -> sn_warp(vec2 p, float t) domain-warped coordinates (pulls in noise)', '#include <sinter/palette> -> sn_pal(float t), sn_palette(t, a, b, c, d) cosine palettes', '#include <sinter/sdf> -> sn_sdCircle, sn_sdBox, sn_sdRing, sn_smin, sn_fill(d, edge)', '#include <sinter/crt> -> sn_crt(vec3 col, vec2 uv, vec2 res, float t) scanlines, phosphor mask, vignette, grain (pulls in noise)'] },
  { id: 'sinter-look', domains: ['p5', 'three', 'html', 'custom', 'hydra'], summary: 'Sinter look kit — a CRT / phosphor / film-grain overlay from the S1NTR launch-reel look, drawn on its own transparent canvas above your piece so it works over p5, three, html, custom and hydra without touching your code. Option for pieces that want an analogue screen, terminal or filmed-monitor feel.',
    access: 'window.SinterLook (script global; no import)',
    highPayoffCalls: ['const look = SinterLook.apply({ phosphor: "s1ntr", tint: 0.5 }) // overlay on the whole page; look.destroy() removes it', 'SinterLook.apply({ raster: 0.06, vignette: 0.6, grain: 1 }) // raster = darkness of every third line, vignette = stops lost at the corners, grain 0 turns film grain off', 'SinterLook.PHOSPHOR.cursor.body // "#44d6cf"; keys kai, claude, you, codex, cursor, hermes, s1ntr (7 hues 51.4 deg apart in OKLCH, body + core hex)', 'call once after your canvas exists; it does not read or alter your pixels', 'look.destroy() // removes the overlay; a static piece still gets animated grain'] },
  { id: 'sinter-flow', domains: ['p5', 'html', 'custom', 'kinetic'], summary: 'Sinter flow kit — seeded Perlin noise, divergence-free curl fields and a canvas-2D flow-particle system. Option for flow fields, drifting particles and organic motion; works on any 2D context (p5: drawingContext).',
    access: 'window.SinterFlow (script global; no import)',
    highPayoffCalls: ['SinterFlow.seed(42) // reproducible noise', 'SinterFlow.noise2(x, y) / SinterFlow.noise3(x, y, t) // Perlin in 0..1', 'SinterFlow.curl(x, y, t) // [vx, vy], swirls that never converge', 'const flow = new SinterFlow.Flow(width, height, { count: 800, scale: 0.004, speed: 1.4, mode: "curl" })', 'ctx.strokeStyle = "rgba(255,255,255,0.15)"; flow.step(ctx) // one frame of short strokes'] },
  { id: 'sinter-music', domains: ['tone', 'strudel', 'music'], summary: 'Sinter music kit — pure pattern helpers: Euclidean rhythms, arpeggio orderings, seeded Markov melodies and song-structure plans. Option when a piece wants generative rhythm or form; it only returns arrays and strings, you still make the sound.',
    access: 'window.SinterMusic (script global; no import)',
    highPayoffCalls: ['SinterMusic.euclid(8, 3, 0) // [1,0,0,1,0,0,1,0] steps/pulses/rotation', 'SinterMusic.euclidMini("bd", 8, 3) // strudel mini-notation "bd ~ ~ bd ~ ~ bd ~"', 'SinterMusic.arp(["C4","E4","G4"], "updown") // up, down, updown, converge, random', 'SinterMusic.markov(["C4","E4","G4","E4"], 16, 7) // seeded walk over learned transitions', 'SinterMusic.structure("verse-chorus", 8) // [{name, bars}]; forms: verse-chorus, aaba, arc, rondo'] },
  { id: 'three-mesh-bvh', domains: ['three'], summary: 'Fast BVH spatial queries for three.js meshes — raycasts, closest-point, shapecasts on million-triangle geometry; the engine behind mesh painting, sculpting and collision-aware scatter.',
    access: 'import * as THREE from "three"; import { MeshBVH, acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh" (importmap; peer three)',
    highPayoffCalls: ['THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree', 'THREE.Mesh.prototype.raycast = acceleratedRaycast', 'geometry.computeBoundsTree()', 'geometry.boundsTree.closestPointToPoint(point, target)', 'new MeshBVH(geometry)'] },
 { id: 'thing', summary: 'thi.ng umbrella — 45 vendored packages of exact computational geometry & math (Karsten Schmidt, two decades of generative tooling). Import any: @thi.ng/geom, @thi.ng/vectors, @thi.ng/matrices, @thi.ng/color, @thi.ng/random, @thi.ng/arrays... Exact tessellation, subdivision curves, SDF forms, centroid-exact composition — mathematical form systems beyond primitives+noise.',
    access: 'import { ... } from "@thi.ng/geom" (any @thi.ng/ package via the prefix map)',
    highPayoffCalls: ['import { polygonFromPoints, area, centroid } from "@thi.ng/geom"', 'import { tessellate } from "@thi.ng/geom-tessellation"', 'import { subdivisionCurve } from "@thi.ng/geom-subdiv-curve"', 'import { group } from "@thi.ng/geom"; group([c1, c2]) with exact bounds/area', 'import { Deref } from "@thi.ng/api"' ] },
];

export function libraryCardFor(id: string): LibraryCard | undefined {
  return LIBRARY_CARDS.find((c) => c.id === id);
}
