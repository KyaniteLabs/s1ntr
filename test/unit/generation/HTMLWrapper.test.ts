import { describe, it, expect } from "vitest";
import { HTMLWrapper } from "../../../src/utils/htmlWrapper.js";

describe("HTMLWrapper", () => {
	describe("detectDomain", () => {
		it("detects p5.js code from setup/draw functions", () => {
			const code =
				"function setup() { createCanvas(400, 400); } function draw() { background(0); }";
			expect(HTMLWrapper.detectDomain(code)).toBe("p5");
		});

		it("detects shader code from void main and uniforms", () => {
			const code =
				"precision highp float; uniform vec2 u_resolution; void main() { gl_FragColor = vec4(1.0); }";
			expect(HTMLWrapper.detectDomain(code)).toBe("shader");
		});

		it("detects Three.js code from complete HTML with imports", () => {
			const code =
				'<!DOCTYPE html><html><head><script type="module">import * as THREE from "three";</script></head></html>';
			expect(HTMLWrapper.detectDomain(code)).toBe("three");
		});

		it("detects already-wrapped HTML", () => {
			const code = "<!DOCTYPE html><html><body>p5</body></html>";
			expect(HTMLWrapper.detectDomain(code)).toBe("html"); // Wrapped HTML without p5 CDN defaults to html
		});

		it("detects already-wrapped Tone HTML as a Tone artifact", () => {
			const code =
				'<!DOCTYPE html><html><body><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script><script>const synth = new Tone.Synth();</script></body></html>';
			expect(HTMLWrapper.detectDomain(code)).toBe("tone");
		});

		it("does not misclassify p5 code as shader", () => {
			const code =
				"function setup() { createCanvas(400, 400); } function draw() { void main(); }";
			expect(HTMLWrapper.detectDomain(code)).toBe("p5");
		});
	});

	describe("isAlreadyWrapped", () => {
		it("returns true for DOCTYPE html", () => {
			const html = "<!DOCTYPE html><html><body>test</body></html>";
			expect(HTMLWrapper.isAlreadyWrapped(html)).toBe(true);
		});

		it("returns true for html tag", () => {
			const html = "<html><body>test</body></html>";
			expect(HTMLWrapper.isAlreadyWrapped(html)).toBe(true);
		});

		it("returns false for plain code", () => {
			const code = "function setup() {}";
			expect(HTMLWrapper.isAlreadyWrapped(code)).toBe(false);
		});

		it("treats a meta page whose SINTER-META-DESCRIPTOR comment precedes the doctype as already wrapped", () => {
			const page =
				'<!--SINTER-META-DESCRIPTOR {"name":"x","runtime":"canvas","libraries":[],"renderTarget":"canvas","notes":"n"} -->\n<!DOCTYPE html><html><body><canvas></canvas></body></html>';
			expect(HTMLWrapper.isAlreadyWrapped(page)).toBe(true);
		});
	});

	describe("wrap", () => {
		it("does not double-wrap already wrapped HTML", () => {
			const html = "<!DOCTYPE html><html><body>p5</body></html>";
			const result = HTMLWrapper.wrap(html);
			// No second shell; only the medium's policy is added (FABLE-R3.7).
			expect(result.match(/<!DOCTYPE html>/g)).toHaveLength(1);
			expect(result.match(/Content-Security-Policy/g)).toHaveLength(1);
			expect(result.replace(/<head>.*<\/head>/, '')).toBe(html);
		});

		it("passes a descriptor-first meta page through intact instead of dumping it into a p5 <script>", () => {
			const page =
				'<!--SINTER-META-DESCRIPTOR {"name":"x","runtime":"canvas","libraries":[],"renderTarget":"canvas","notes":"n"} -->\n<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><canvas id="c"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,10,10);</script></body></html>';
			const result = HTMLWrapper.wrap(page, { domain: "custom" });
			// Descriptor survives in the artifact and the page is NOT re-wrapped as p5.
			expect(result).toContain("SINTER-META-DESCRIPTOR");
			expect(result).toContain("<canvas");
			expect(result).not.toContain("createCanvas");
		});

		it("adds a transparent foreground override for already wrapped ASCII composition layers", () => {
			const html =
				'<!DOCTYPE html><html><head></head><body style="background:#0a0a0f"><pre>ASCII</pre></body></html>';
			const result = HTMLWrapper.wrap(html, { domain: "ascii", compositionForeground: true });
			expect(result).toContain("data-sinter-composition-foreground");
			expect(result).toContain("background: transparent !important");
			expect(result).toContain("<pre>ASCII</pre>");
		});

		it("enhances already-wrapped Tone HTML with the Tone preview shell", () => {
			const html =
				'<!DOCTYPE html><html><body><button id="startButton">Play</button><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script><script>const synth = new Tone.Synth();</script></body></html>';
			const result = HTMLWrapper.wrap(html, { domain: "tone" });

			expect(result).toContain("data-tone-preview-shell");
			expect(result).toContain('id="sinter-tone-visualizer"');
			expect(result).toContain('id="startButton"');
		});

		it("wraps p5.js code correctly", () => {
			const code = "function setup() { createCanvas(400, 400); }";
			const result = HTMLWrapper.wrap(code);
			expect(result).toContain(
				'<script src="/vendor/p5/1.9.0/p5.min.js">',
			);
			expect(result).toContain(code);
		});

		it("wraps shader code with WebGL context", () => {
			const code = "void main() { gl_FragColor = vec4(1.0); }";
			const result = HTMLWrapper.wrap(code);
			expect(result).toContain("getContext(");
			expect(result).toContain("webgl");
			expect(result).toContain(code);
		});

		it("includes p5.sound when requested", () => {
			const code = "function setup() { createCanvas(400, 400); }";
			const result = HTMLWrapper.wrap(code, { includeP5Sound: true });
			expect(result).toContain("p5.sound.min.js");
		});

		it("uses custom title when provided", () => {
			const code = "function setup() { createCanvas(400, 400); }";
			const result = HTMLWrapper.wrap(code, { title: "My Sketch" });
			expect(result).toContain("<title>My Sketch</title>");
		});

		it("does not inject PostHog when LIMINAL_POSTHOG_KEY is not set", () => {
			const origKey = process.env.LIMINAL_POSTHOG_KEY;
			delete process.env.LIMINAL_POSTHOG_KEY;
			const code = "function setup() { createCanvas(400, 400); }";
			const result = HTMLWrapper.wrap(code);
			expect(result).not.toContain("posthog");
			process.env.LIMINAL_POSTHOG_KEY = origKey;
		});

		it("keeps saved art tracking-free by default even when a key is set", () => {
			const origKey = process.env.LIMINAL_POSTHOG_KEY;
			process.env.LIMINAL_POSTHOG_KEY = "phc_testkey_default";
			try {
				const result = HTMLWrapper.wrap("function setup() { createCanvas(400, 400); }");
				expect(result).not.toContain("posthog");
				expect(result).not.toContain("phc_testkey_default");
				expect(result).not.toContain("puenteworks.com");
			} finally {
				if (origKey === undefined) delete process.env.LIMINAL_POSTHOG_KEY;
				else process.env.LIMINAL_POSTHOG_KEY = origKey;
			}
		});

		it("injects PostHog with memory persistence and opens CSP for its origin only when analytics is on", () => {
			const origKey = process.env.LIMINAL_POSTHOG_KEY;
			const origHost = process.env.LIMINAL_POSTHOG_HOST;
			process.env.LIMINAL_POSTHOG_KEY = "phc_testkey_inject";
			process.env.LIMINAL_POSTHOG_HOST = "https://ph.example.test/ingest";
			try {
				const result = HTMLWrapper.wrap("function setup() { createCanvas(400, 400); }", { analytics: true });
				expect(result).toContain('posthog.init("phc_testkey_inject",{api_host:"https://ph.example.test/ingest",persistence:\'memory\'');
				const csp = result.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
				expect(csp).toMatch(/script-src [^;]*https:\/\/ph\.example\.test;/);
				expect(csp).toMatch(/connect-src [^;]*https:\/\/ph\.example\.test;/);
				expect(csp).not.toContain("connect-src 'none'");
			} finally {
				if (origKey === undefined) delete process.env.LIMINAL_POSTHOG_KEY;
				else process.env.LIMINAL_POSTHOG_KEY = origKey;
				if (origHost === undefined) delete process.env.LIMINAL_POSTHOG_HOST;
				else process.env.LIMINAL_POSTHOG_HOST = origHost;
			}
		});

		it("escapes a hostile key so it cannot close the script tag", () => {
			const origKey = process.env.LIMINAL_POSTHOG_KEY;
			process.env.LIMINAL_POSTHOG_KEY = "x\"</script><script>alert(1)</script>";
			try {
				const result = HTMLWrapper.wrap("function setup() {}", { analytics: true });
				expect(result).not.toContain("<script>alert(1)");
				expect(result).toContain("\\u003c/script>");
			} finally {
				if (origKey === undefined) delete process.env.LIMINAL_POSTHOG_KEY;
				else process.env.LIMINAL_POSTHOG_KEY = origKey;
			}
		});

		it("skips analytics when the host is not https", () => {
			const origKey = process.env.LIMINAL_POSTHOG_KEY;
			const origHost = process.env.LIMINAL_POSTHOG_HOST;
			process.env.LIMINAL_POSTHOG_KEY = "phc_testkey_http";
			process.env.LIMINAL_POSTHOG_HOST = "http://ph.example.test";
			try {
				const result = HTMLWrapper.wrap("function setup() {}", { analytics: true });
				expect(result).not.toContain("posthog");
				expect(result).toContain("connect-src 'none'");
			} finally {
				if (origKey === undefined) delete process.env.LIMINAL_POSTHOG_KEY;
				else process.env.LIMINAL_POSTHOG_KEY = origKey;
				if (origHost === undefined) delete process.env.LIMINAL_POSTHOG_HOST;
				else process.env.LIMINAL_POSTHOG_HOST = origHost;
			}
		});

		it("frames a full-bleed SVG edge-to-edge (no white mat) when it paints its own background", () => {
			const code =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#020617"/><circle cx="400" cy="300" r="120" fill="#38bdf8"/></svg>';
			const result = HTMLWrapper.wrap(code, { domain: "svg" });
			expect(result).not.toContain("background: #ffffff");
			expect(result).toContain("background: transparent");
		});

		it("keeps a light mat for transparent line-art SVGs (washout-safe)", () => {
			const code =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><path d="M100,100 L700,500" stroke="#111827" stroke-width="4" fill="none"/></svg>';
			const result = HTMLWrapper.wrap(code, { domain: "svg" });
			expect(result).toContain("background: #ffffff");
		});

		it("gives host-token embed fragments preview colours so the evaluator does not judge an unthemed frame (#1162)", () => {
			const code =
				'<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0" fill="var(--art-red)" stroke="var( --art-ink )"/><circle fill="var(--glow)"/></svg>';
			const result = HTMLWrapper.wrap(code, { domain: "svg" });
			expect(result).toContain("--art-red: #d94a3d;");
			expect(result).toContain("--art-ink: #1c1f26;");
			expect(result).toMatch(/--glow: hsl\(\d+ 60% 50%\);/);
			// the fragment itself is embedded unchanged
			expect(result).toContain('fill="var(--art-red)"');
		});

		it("leaves tokens alone when the SVG defines them or gives a fallback", () => {
			const code =
				'<svg viewBox="0 0 10 10"><style>svg{--art-red:#f00}</style><path fill="var(--art-red)" stroke="var(--art-ink, #000)"/></svg>';
			const result = HTMLWrapper.wrap(code, { domain: "svg" });
			expect(result).not.toContain("--art-red: #d94a3d;");
			expect(result).not.toContain("--art-ink: #1c1f26;");
		});

		it("adds no token block to an SVG without CSS variables", () => {
			const result = HTMLWrapper.wrap('<svg viewBox="0 0 1 1"><rect fill="#fff"/></svg>', { domain: "svg" });
			expect(result).not.toContain("preview stand-ins");
		});
	});
	describe("re-wrapping a page that already has a preview shell", () => {
		const hyperframes =
			'<!doctype html><html><body><div data-composition-id="badge" data-width="1920" data-height="1080"><div class="clip"></div></div><script>window.__timelines = { badge: gsap.timeline() };</script></body></html>';
		const tone = "const synth = new Tone.Synth().toDestination(); Tone.Transport.start();";

		// Production wraps the playable, then HeadlessRenderer wraps it again. A second
		// HyperFrames shell pushed the artwork below the 800x600 evidence frame
		// (judged 0.13 in the 2026-11-10 matrix: "artwork is almost entirely below the viewport").
		it.each([
			["hyperframes", hyperframes, "data-hyperframes-preview-shell"],
			["tone", tone, "data-tone-preview-shell"],
		] as const)("leaves a wrapped %s page unchanged", (domain, code, marker) => {
			const once = HTMLWrapper.wrap(code, { domain, title: "Liminal Artwork" });
			const twice = HTMLWrapper.wrap(once, {});
			expect(twice.match(new RegExp(`<(?:main|body)[^>]*${marker}`, "g"))?.length).toBe(1);
			expect(twice.length).toBeLessThanOrEqual(once.length);
			expect(HTMLWrapper.wrap(twice, {})).toBe(twice);
		});

		it("still gives model-emitted HyperFrames HTML its first shell", () => {
			const wrapped = HTMLWrapper.wrap(hyperframes, { title: "Liminal Artwork" });
			expect(wrapped).toContain("<main data-hyperframes-preview-shell>");
			expect(wrapped).toContain("<h1>Liminal Artwork</h1>");
		});

		it("puts the live stage above the header so a viewport capture shows the artwork", () => {
			const wrapped = HTMLWrapper.wrap(hyperframes, { domain: "hyperframes" });
			expect(wrapped.indexOf('class="hyperframes-stage-wrap"')).toBeLessThan(wrapped.indexOf('class="hyperframes-header"'));
		});
	});
});
