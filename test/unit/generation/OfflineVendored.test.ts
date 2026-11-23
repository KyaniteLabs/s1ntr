import { describe, it, expect } from "vitest";
import { HTMLWrapper } from "../../../src/utils/htmlWrapper.js";
import { isVendorAssetPath, RUNTIME_FETCHED_ASSETS } from "../../../src/utils/vendorAssets.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const VENDOR_ROOT = join(process.cwd(), "vendor");

// Samples for EVERY wrapper/generator route that emits external references.
// p5/P5GeneratorV2, three/ThreeWrapper (importmap), tone/ToneGenerator,
// hydra/HydraGenerator, dataviz (d3), hyperframes (gsap), generic (strudel).
const SAMPLES: Array<{ route: string; code: string }> = [
	{ route: "p5", code: "function setup() { createCanvas(400, 400); } function draw() { background(0); ellipse(200, 200, 100, 100); }" },
	{ route: "three", code: 'import * as THREE from "three"; const s = new THREE.Scene(); const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.4, 16, 48), new THREE.MeshNormalMaterial()); s.add(m);' },
	{ route: "tone", code: 'const synth = new Tone.PolySynth().toDestination(); Tone.Transport.start();' },
	{ route: "hydra", code: "osc(60, 0.1, 1.4).kaleid(6).out();" },
	{ route: "dataviz", code: "const svg = d3.select('body').append('svg'); svg.append('circle').attr('r', 50);" },
	{ route: "hyperframes", code: "gsap.to('#box', { x: 100, duration: 2 });" },
	{ route: "strudel", code: 'note("c3 e3 g3").slow(2).sfx()>' },
];

// Remote hosts that may legitimately remain in wrapped output:
// - strudel sample banks (remote data — #924 follow-up)
// These must appear ONLY inside CSP text, never as loaded resource URLs.
const LEGITIMATE_CSP_HOSTS = /strudel\.b-cdn\.net|raw\.githubusercontent\.com/;

describe("offline vendored wrapping (#924)", () => {
	it("emits ZERO remotely-loaded script/style resources for every route", () => {
		for (const { route, code } of SAMPLES) {
			const html = HTMLWrapper.wrap(code);
			const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
				.map((m) => m[1])
				.filter((u) => !LEGITIMATE_CSP_HOSTS.test(u));
			expect(remote, `${route}: remote resources survived wrapping: ${remote.join(", ")}`).toEqual([]);
		}
	});

	it("loads every library from /vendor/ and every referenced file exists on disk", () => {
		for (const { route, code } of SAMPLES) {
			const html = HTMLWrapper.wrap(code);
			const refs = [...html.matchAll(/(?:src|href)="(\/vendor\/[^"]+)"/g)]
				.map((m) => m[1])
				// importmap prefix entries may map directories; file-existence only for file refs
				.filter((ref) => /\.(js|css|json)$/.test(ref));
			// module-based wrappers (three) route through an importmap: any /vendor/ mention counts
			expect(
				refs.length > 0 || html.includes('"/vendor/'),
				`${route}: expected at least one vendored reference (file or importmap)`
			).toBe(true);
			for (const ref of refs) {
				expect(existsSync(join(process.cwd(), ref.replace(/^\//, ""))), `${route}: missing vendor file ${ref}`).toBe(true);
			}
		}
	});

	it("wrapper CSP allows self-origin vendor paths without widening anything else", () => {
		for (const { code } of SAMPLES) {
			const html = HTMLWrapper.wrap(code);
			const csp = html.match(/http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/)?.[1] ?? "";
			expect(csp, "expected a CSP meta in wrapped output").not.toBe("");
			// script-src must include 'self' (vendor loads) and must NOT be '*'
			expect(csp).toMatch(/script-src[^;]*'self'/);
			expect(csp).not.toMatch(/script-src[^;]*\*/);
		}
	});

	it("vendor manifest is the enforcing integrity pin (bytes + sizes recomputed)", () => {
		const manifest = JSON.parse(readFileSync(join(VENDOR_ROOT, "manifest.json"), "utf8"));
		for (const asset of manifest.assets) {
			const p = join(VENDOR_ROOT, asset.file);
			if (asset.dir || asset.load === "module-tree") {
				// tree asset: digest = sorted (path + bytes) chain, same as the vendor script
				const files: string[] = [];
				const collect = (d: string, rel: string) => {
					for (const f of readdirSync(d, { withFileTypes: true } as never)) {
						const r = rel ? rel + "/" + f.name : f.name;
						if (f.isDirectory()) collect(join(d, f.name), r);
						else files.push(r);
					}
				};
				collect(p, "");
				files.sort();
				const h = createHash("sha256"); let total = 0;
				for (const r of files) { h.update(Buffer.from(r, "utf-8")); const b = readFileSync(join(p, r)); h.update(b); total += b.length; }
				expect(h.digest("hex"), `tree integrity drift for ${asset.file}`).toBe(asset.sha256);
				expect(total, `tree size drift for ${asset.file}`).toBe(asset.bytes);
			} else if (!existsSync(p) && RUNTIME_FETCHED_ASSETS[`/vendor/${asset.file}`]) {
				// Public tree: GSAP is not shipped; it is fetched from its CDN against this same pin.
				expect(RUNTIME_FETCHED_ASSETS[`/vendor/${asset.file}`].sha256, `pin drift for ${asset.file}`).toBe(asset.sha256);
			} else {
				const buf = readFileSync(p);
				expect(createHash("sha256").update(buf).digest("hex"), `integrity drift for ${asset.file}`).toBe(asset.sha256);
				expect(buf.length, `size drift for ${asset.file}`).toBe(asset.bytes);
			}
		}
	});

	it("vendor versions byte-match the exact CDN versions legacy artifacts reference", () => {
		const manifest = JSON.parse(readFileSync(join(VENDOR_ROOT, "manifest.json"), "utf8"));
		for (const asset of manifest.assets) {
			// The manifest's source url IS the exact URL the pre-cutover wrappers emitted.
			// Tie new artifacts to the same bytes: every version token in the source URL
			// must appear in the vendored path (p5.sound lives under the p5 1.9.0 CDN dir,
			// so its addon version stays only in the `version` field).
			// byte-tie applies to CDN-sourced assets (legacy artifacts referenced those
			// exact URLs); npm-tarball provenance ties via the version field instead.
			if (!/registry\.npmjs\.org/.test(asset.url)) {
				const urlTokens = (asset.url.match(/\d+\.\d+[\d.]*/g) ?? []).map((t: string) => t.replace(/\.$/, ""));
				for (const token of urlTokens) {
					expect(asset.file, `${asset.id}: vendored path must carry url version ${token}`).toContain(token);
				}
			} else if (asset.load !== "module-tree") {
				// flattened thi.ng trees carry the version in the manifest, not the path
				expect(asset.file, `${asset.id}: vendored path must carry npm version`).toContain(asset.version.split(" ")[0]);
			}
			// provenance: legacy assets pin their CDN source; phase-1 capability
			// libraries pin the npm tarball they were vendored from.
			expect(asset.url, `${asset.id}: manifest must record a source URL`).toMatch(
				/^https:\/(\/registry\.npmjs\.org|\/cdnjs\.cloudflare\.com|\/cdn\.jsdelivr\.net|\/unpkg\.com|\/d3js\.org|\/github\.com)\/|^in-repo:vendor\/sinter-kits\//);
		}
	});
});

import { VENDORED_LIBRARIES, libraryIncludes } from "../../../src/core/wrappers/VendoredLibraries.js";
import { THING_IMPORTMAP } from "../../../src/core/wrappers/thing-importmap.generated.js";

describe("vendored capability libraries (#1000 integration)", () => {
	it("index and vendor manifest cannot drift", () => {
		const manifest = JSON.parse(readFileSync(join(VENDOR_ROOT, "manifest.json"), "utf8"));
		const byId = new Map(manifest.assets.map((a: { id: string; file: string }) => [a.id, a.file]));
		for (const [id, entry] of Object.entries(VENDORED_LIBRARIES)) {
			if (id === "thing") {
				// the umbrella prefix maps into a TREE represented by per-package assets
				const treeAssets = manifest.assets.filter((a: { id: string }) => a.id.startsWith("thing-"));
				expect(treeAssets.length, "thi.ng umbrella tree assets").toBeGreaterThanOrEqual(40);
				continue;
			}
			const mfile = byId.get(id);
			expect(mfile, `path drift for ${id}`).toBe(entry.file.replace(/^\/vendor\//, ""));
		}
	});

	it("every indexed library file exists on disk and stays remote-free", () => {
		for (const [id, entry] of Object.entries(VENDORED_LIBRARIES)) {
			const p = join(process.cwd(), entry.file.replace(/^\//, ""));
			expect(existsSync(p), `${id}: missing ${entry.file}`).toBe(true);
		}
	});

	it("script and module load types both inject correctly across domains", () => {
		for (const domain of ["p5", "three", "tone", "shader"]) {
			const html = HTMLWrapper.wrap(SAMPLES[0].code, {
				domain: domain as never,
				libraries: ["culori", "perfect-freehand", "roughjs"],
			});
			expect(html).toContain("/vendor/culori/4.0.2/culori.min.js");
			expect(html).toContain("/vendor/roughjs/4.6.6/rough.js");
			// module lib lands in an importmap (new or merged), never a bare src
			const im = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
			expect(im?.length, `${domain}: importmap present`).toBe(2);
			expect(JSON.parse(im![1]).imports["perfect-freehand"]).toContain("/vendor/perfect-freehand/");
		}
	});

	it("holospot widens the CSP for its /vendor assets and blob workers; other pieces keep connect-src 'none'", () => {
		const three = SAMPLES.find((s) => s.route === "three")!;
		const csp = (h: string) => h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1];
		const holo = csp(HTMLWrapper.wrap(three.code, { domain: "three", libraries: ["three-webgpu", "holospot"] }));
		expect(holo).toMatch(/connect-src 'self'/);
		expect(holo).not.toMatch(/connect-src[^;]*'none'/);
		expect(holo).toMatch(/worker-src blob: 'self'/);
		const plain = csp(HTMLWrapper.wrap(three.code, { domain: "three", libraries: ["perfect-freehand"] }));
		expect(plain).toMatch(/connect-src 'none'/);
		expect(plain).not.toMatch(/worker-src/);
	});

	it("three importmap merge preserves the existing three entries", () => {
		const three = SAMPLES.find((s) => s.route === "three")!;
		const html = HTMLWrapper.wrap(three.code, { domain: "three", libraries: ["perfect-freehand"] });
		const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
		expect(imports["three"]).toContain("/vendor/three/");
		expect(imports["perfect-freehand"]).toContain("/vendor/perfect-freehand/");
	});


it("phase-2 opt-ins inject as importmap ids without touching default three", () => {
  const html = HTMLWrapper.wrap(SAMPLES.find((s) => s.route === "three")!.code, {
    domain: "three", libraries: ["three-tsl", "three-gpu-pathtracer", "three-mesh-bvh", "xatlas-web"],
  });
  const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
  expect(imports["three"]).toContain("/vendor/three/0.160.0/"); // byte-tie intact without the opt-in
  expect(imports["three-tsl"]).toContain("0.185.1");
  expect(imports["three-gpu-pathtracer"]).toContain("0.0.24");
  // the three-webgpu opt-in deliberately re-points THIS piece's bare `three`
  const remapped = HTMLWrapper.wrap(SAMPLES.find((s) => s.route === "three")!.code, {
    domain: "three", libraries: ["three-webgpu", "three-gpu-pathtracer"],
  });
  const rimports = JSON.parse(remapped.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
  // bare `three` -> the WebGL module build (pathtracer + holospot need WebGLRenderer);
  // WebGPU and TSL ride their own specifiers, sharing one three.core.min.js
  expect(rimports["three"]).toContain("0.185.1/three.module.min.js");
  expect(rimports["three/webgpu"]).toContain("0.185.1/three.webgpu.min.js");
  expect(rimports["three/tsl"]).toContain("three.tsl.min.js");
  expect(rimports["three-gpu-pathtracer"]).toContain("0.0.24");
  // three.tsl.min.js imports "three/webgpu": requesting tsl alone must still map it
  expect(imports["three/webgpu"]).toContain("three.webgpu.min.js");
});

it("every vendored ESM file's relative imports exist on disk and are served", async () => {
  // three.webgpu.min.js shipped without its ./three.core.min.js sibling: every
  // three-webgpu piece 404'd at load and rendered black. Walk the module graph.
  const manifest = JSON.parse(readFileSync(new URL("../../../vendor/manifest.json", import.meta.url), "utf8")) as {
    assets: { file: string; load?: string }[];
  };
  const missing: string[] = [];
  for (const a of manifest.assets.filter((x) => x.load === "module" && /\.(m?js)$/.test(x.file))) {
    const src = readFileSync(new URL(`../../../vendor/${a.file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
    for (const spec of new Set(specs)) {
      const served = new URL(spec, `http://h/vendor/${a.file}`).pathname;
      const onDisk = existsSync(new URL(`../../..${served}`, import.meta.url));
      if (!onDisk) missing.push(`${a.file} -> ${spec} (missing on disk)`);
      else if (!isVendorAssetPath(served) && !served.startsWith("/vendor/thi.ng/")) missing.push(`${a.file} -> ${spec} (not served)`);
    }
  }
  expect(missing).toEqual([]);
});

it("holospot importmap id resolves to the vendored holo.js", () => {
  const html = HTMLWrapper.wrap(SAMPLES.find((s) => s.route === "three")!.code, {
    domain: "three", libraries: ["holospot"],
  });
  const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
  expect(imports["holospot"]).toContain("/vendor/holospot/0.1.0/dist/holo.js");
  // holo.js imports bare "three" and needs r170+ (peer >=0.170, WebGLRenderer):
  // requesting holospot alone must re-point `three` at the 0.185.1 WebGL module
  // build, or the piece links against 0.160 and the foil never renders.
  expect(imports["three"]).toContain("/vendor/three-webgpu/0.185.1/three.module.min.js");
  // the holospot asset dir is registered so the vendor server can serve runtime assets
  expect(isVendorAssetPath("/vendor/holospot/0.1.0/assets/bumps/scratches.jpg")).toBe(true);
  expect(isVendorAssetPath("/vendor/holospot/0.1.0/assets/holo3d/wolf.sdf")).toBe(true);
  expect(isVendorAssetPath("/vendor/holospot/0.1.0/assets/logos/koru.svg")).toBe(true);
  // Holo's default asset base is new URL("../assets/", import.meta.url): the
  // vendored layout must keep holo.js one level below assets/ or every piece
  // that omits { assets } 404s on its bump maps.
  const holoUrl = new URL(`http://x${imports["holospot"]}`);
  const assetBase = new URL("../assets/", holoUrl).pathname;
  expect(assetBase).toBe("/vendor/holospot/0.1.0/assets/");
  expect(existsSync(join(process.cwd(), assetBase, "bumps/scratches.jpg"))).toBe(true);
});

	it("thi.ng umbrella injects the generated exact-key importmap", () => {
		const html = HTMLWrapper.wrap(SAMPLES[0].code, { libraries: ["thing", "tonaljs"] });
		const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
		const thingKeys = Object.keys(imports).filter((k: string) => k.startsWith("@thi.ng/"));
		expect(thingKeys.length, "generated @thi.ng entries injected").toBeGreaterThanOrEqual(250);
		expect(imports[thingKeys[0]]).toContain("/vendor/thi.ng/");
		expect(imports["tonaljs"]).toContain("/vendor/tonaljs/");
	});

	it("thi.ng resolvability + closure: every specifier in every vendored file maps to a real file, and nothing external is imported (GLM round-1 gate)", () => {
		const specRe = /(?:from\s+|import\(\s*)"([^."][^"]*)"/g;
		const treeRoot = join(process.cwd(), "vendor/thi.ng");
		const files: string[] = [];
		const collect = (d: string) => {
			for (const f of readdirSync(d, { withFileTypes: true } as never)) {
				const fp = join(d, f.name);
				if (f.isDirectory()) collect(fp); else if (f.name.endsWith(".js")) files.push(fp);
			}
		};
		collect(treeRoot);
		// vacuous-pass guard (GLM round-2): an empty tree would make the walk prove
		// nothing — pin per-package counts and the total so emptiness can never pass.
		expect(files.length, "vendored thi.ng js files (pinned)").toBeGreaterThanOrEqual(1157);
		const pkgs = readdirSync(treeRoot, { withFileTypes: true } as never).filter((d: { isDirectory: () => boolean }) => d.isDirectory());
		for (const pkg of pkgs) {
			const n = readdirSync(join(treeRoot, pkg.name), { withFileTypes: true } as never).length;
			expect(n, `empty package tree: ${pkg.name}`).toBeGreaterThan(0);
		}
		const unmapped: string[] = []; const missing: string[] = []; const external: string[] = [];
		for (const fp of files) {
			const src = readFileSync(fp, "utf8");
			for (const m of src.matchAll(specRe)) {
				const spec = m[1];
				if (spec.startsWith("@thi.ng/")) {
					const target = THING_IMPORTMAP[spec];
					if (!target) unmapped.push(spec);
					else if (!existsSync(join(process.cwd(), target.replace(/^\//, "")))) missing.push(spec);
				} else if (!spec.startsWith("http") && spec !== "node:process") external.push(spec);
			}
		}
		expect(unmapped, `unmapped @thi.ng specifiers: ${[...new Set(unmapped)].slice(0, 5).join(", ")}`).toEqual([]);
		expect(missing, `specifiers mapping to missing files: ${[...new Set(missing)].slice(0, 5).join(", ")}`).toEqual([]);
		expect(external, `NON-thi.ng bare imports break closure: ${[...new Set(external)].slice(0, 5).join(", ")}`).toEqual([]);
	});
	it("unknown library ids fail LOUD at wrap time", () => {
		expect(() => libraryIncludes(["culri" as never])).toThrow(/Unknown vendored library/);
		expect(() => HTMLWrapper.wrap(SAMPLES[0].code, { libraries: ["not-a-lib"] })).toThrow(/Unknown vendored library/);
	});
});
