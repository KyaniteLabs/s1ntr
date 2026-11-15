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
}

export const LIBRARY_CARDS: readonly LibraryCard[] = [
  { id: 'culori', summary: 'Perceptual color science (OKLCH ramps, deltaE, format round-trips). Build palettes in OKLCH — never hex-lerp.',
    access: 'global `culori` (script)',
    highPayoffCalls: ['culori.oklch("#ff6b35")', 'culori.formatHex(culori.mix(a, b, 0.5, "oklch"))', 'culori.interpolate([c1,c2,c3])(t)', 'culori.differenceEuclideanOklch("")(a,b)', 'culori.palette? — build ramps via interpolate samples'] },
  { id: 'd3-delaunay', summary: 'Voronoi/Delaunay tessellation — stippling, organic-cell mosaics, nearest-neighbor deposition.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.Delaunay.from(points)', 'delaunay.voronoi([0,0,w,h])', 'voronoi.cellPolygon(i)', 'delaunay.hull', 'd3.Delaunay.from(pts).voronoi(bounds).render()' ] },
  { id: 'd3-contour', summary: 'Isolines from scalar fields (marching squares) — topographic paintings from any noise/audio field.',
    access: 'global `d3` (script)',
    highPayoffCalls: ['d3.contours().size([w,h]).thresholds(7)(values)', 'contour.value(d => d.v)', 'contour.coordinates', 'd3.contours().smooth(true)(field)', 'contour.thresholds(d3.range(-1.5, 2, 0.5))'] },
  { id: 'perfect-freehand', summary: 'Pressure-style hand-drawn strokes — the human-hand signature (anti-generated-look).',
    access: 'import { getStroke } from "perfect-freehand"',
    highPayoffCalls: ['getStroke(points)', 'getStroke(points, { size: 8, thinning: 0.6 })', 'getStroke(points, { simulatePressure: true })', 'getSvgPathFromStroke(getStroke(pts))', 'getStroke(pts, { streamline: 0.4, easing: t => t*t })'] },
  { id: 'roughjs', summary: 'Seeded sketchy rendering — hachure fills, tremored outlines, style-axis novelty from render mode.',
    access: 'global `rough` (script)',
    highPayoffCalls: ['rough.canvas(canvas).rectangle(x,y,w,h, {seed: 42})', 'rc.circle(cx,cy,r, {roughness: 2.2, seed})', 'rc.path(svgPath, { fill: "steelblue", fillStyle: "hachure" })', 'rough.generator().line(x1,y1,x2,y2)', 'rc.polygon(points, { bowing: 1.4 })'] },
  { id: 'tonaljs', summary: 'Theory-correct harmony — progressions that resolve, chord detection both directions.',
    access: 'import { Chord, Scale, Note } from "tonaljs"',
    highPayoffCalls: ['Chord.notes("Cmaj7")', 'Chord.detect(["D","F#","A","C"])', 'Scale.get("C major").notes', 'Note.midi("c4")', 'Chord.get("D7").intervals'] },
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
  { id: 'three-gpu-pathtracer', summary: 'Physically-based studio-lit stills — a print product line. PEER FLOOR three >=0.180: pair with libraries:["three-webgpu", ...] so this piece\'s bare three re-points to 0.182 (auto-remap). Still renders NOT verified headless — SwiftShader renderer lane owns that proof.',
    access: 'import { PathTracingRenderer } from "three-gpu-pathtracer" (importmap; peer three)',
    highPayoffCalls: ['new PathTracingRenderer(renderer)', 'pathTracer.scene = scene', 'pathTracer.camera = camera', 'new PhysicalPathTracingMaterial()', 'pathTracer.renderSample()'] },
 { id: 'thing', summary: 'thi.ng umbrella — 45 vendored packages of exact computational geometry & math (Karsten Schmidt, two decades of generative tooling). Import any: @thi.ng/geom, @thi.ng/vectors, @thi.ng/matrices, @thi.ng/color, @thi.ng/random, @thi.ng/arrays... Exact tessellation, subdivision curves, SDF forms, centroid-exact composition — mathematical form systems beyond primitives+noise.',
    access: 'import { ... } from "@thi.ng/geom" (any @thi.ng/ package via the prefix map)',
    highPayoffCalls: ['import { polygonFromPoints, area, centroid } from "@thi.ng/geom"', 'import { tessellate } from "@thi.ng/geom-tessellation"', 'import { subdivisionCurve } from "@thi.ng/geom-subdiv-curve"', 'import { group } from "@thi.ng/geom"; group([c1, c2]) with exact bounds/area', 'import { Deref } from "@thi.ng/api"' ] },
];

export function libraryCardFor(id: string): LibraryCard | undefined {
  return LIBRARY_CARDS.find((c) => c.id === id);
}
