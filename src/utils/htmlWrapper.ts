/**
 * Centralized HTML wrapping utility for Sinter outputs
 * Routes to domain-specific wrappers
 *
 * Supported domains:
 * - p5: p5.js sketches with canvas (P5Wrapper)
 * - shader: GLSL fragment shaders (GenericWrapper)
 * - three: Three.js 3D scenes (ThreeWrapper)
 * - strudel: Strudel live music patterns (GenericWrapper)
 * - hydra: Hydra video synthesizer patterns (GenericWrapper)
 * - tone: Tone.js audio (GenericWrapper)
 * - revideo: Revideo video compositions (GenericWrapper)
 * - hyperframes: HTML + GSAP asset compositions (GenericWrapper)
 * - svg: Raw SVG documents displayed inline
 * - html: Complete HTML pages (pass-through)
 * - dataviz: Complete D3.js HTML pages (pass-through, same path as html)
 * - meta: Complete custom-medium HTML pages (pass-through, same path as html)
 * - ascii: ASCII art display (GenericWrapper)
 */

import { P5Wrapper } from '../core/wrappers/P5Wrapper.js';
import { libraryIncludes } from '../core/wrappers/VendoredLibraries.js';
import { ThreeWrapper } from '../core/wrappers/ThreeWrapper.js';
import { GenericWrapper } from '../core/wrappers/GenericWrapper.js';
import { vendorPathForUrl } from './browserAssetFallbacks.js';
import type { DomainString } from '../types/domains.js';

export type Domain = Extract<DomainString, 'p5' | 'shader' | 'three' | 'strudel' | 'hydra' | 'tone' | 'revideo' | 'hyperframes' | 'svg' | 'html' | 'dataviz' | 'meta' | 'ascii' | 'blender'>;

export interface WrapOptions {
  domain?: Domain;
  title?: string;
  includeP5Sound?: boolean;
  /** For Strudel: auto-start playback */
  autoPlay?: boolean;
  /** For Revideo: show code or try to render preview */
  showPreview?: boolean;
  /** For ASCII: use monospace styling */
  asciiWidth?: number;
  /** For Hydra: canvas resolution */
  hydraResolution?: { width: number; height: number };
  /** True when this output is stacked above another composition layer. */
  compositionForeground?: boolean;
  /** Vendored capability libraries the piece requests (#1000 integration):
   *  ids from VendoredLibraries; unknown ids fail loud at wrap time. */
  libraries?: string[];
  /** Inject the PostHog snippet. Off by default: saved and exported art stays
   *  tracking-free. Only the public living site turns it on, and only when
   *  LIMINAL_POSTHOG_KEY is set. */
  analytics?: boolean;
}

export class HTMLWrapper {
  private static readonly BASE_SECURITY_HEADERS = [
    '<meta http-equiv="X-Content-Type-Options" content="nosniff">',
    '<meta http-equiv="Referrer-Policy" content="strict-origin-when-cross-origin">',
  ];

  // Vendor-local CSPs (issue #924): libraries load from /vendor on the serving
  // origin, so script-src needs only 'self'. No CDN hosts — zero fallback.
  private static readonly DEFAULT_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; font-src 'self';";

  private static readonly HYDRA_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self';";

  // LIVE-PATH CSPs (this file owns playable.html; GenericWrapper's CSPs are
  // stripped by injectSecurityHeaders). Strudel MUST carry 'unsafe-eval' (the
  // runtime transpiles patterns via new Function — without it, hollow silence)
  // and the sample-bank hosts (still remote — see #924 follow-up).
  private static readonly STRUDEL_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'; worker-src blob: 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://strudel.b-cdn.net https://raw.githubusercontent.com; font-src 'self';";

  private static readonly TONE_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; worker-src blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; media-src 'self' data: blob:;";

  private static securityHeadersFor(domain: Domain): string[] {
    const csp = domain === 'hydra'
      ? this.HYDRA_CSP
      : domain === 'strudel'
        ? this.STRUDEL_CSP
        : domain === 'tone'
          ? this.TONE_CSP
          : this.DEFAULT_CSP;
    return [
      ...this.BASE_SECURITY_HEADERS,
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    ];
  }

  private static injectSecurityHeaders(html: string, domain: Domain): string {
    const sanitized = this.stripInvalidMetaHeaders(html);
    const headers = this.securityHeadersFor(domain).join('\n    ');
    return sanitized.replace('</head>', `    ${headers}\n</head>`);
  }

  /** Puts the medium's headers first in <head>, creating a head when the page has none. */
  private static withFullPagePolicy(page: string, domain: Domain): string {
    const headers = this.securityHeadersFor(domain).join('');
    if (/<head\b[^>]*>/i.test(page)) return page.replace(/<head\b[^>]*>/i, (head) => `${head}${headers}`);
    if (/<html\b[^>]*>/i.test(page)) return page.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${headers}</head>`);
    if (/<!DOCTYPE[^>]*>/i.test(page)) return page.replace(/<!DOCTYPE[^>]*>/i, (tag) => `${tag}<head>${headers}</head>`);
    // A bare body: the parser puts leading meta tags into the implied head.
    return `${headers}${page}`;
  }

  /** Points <script src> at the shipped copy for CDN libraries Sinter vendors. */
  private static vendorKnownScripts(page: string): string {
    return page.replace(/<script\b[^>]*>/gi, (tag) => {
      const src = /\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(tag);
      const local = src ? vendorPathForUrl(src[2]) : null;
      if (!src || !local) return tag;
      // The shipped copy's bytes differ from the CDN build the hash names.
      return tag.replace(src[0], `src=${src[1]}${local}${src[1]}`)
        .replace(/\s+integrity\s*=\s*(["'])[^"']*\1/i, '');
    });
  }

  private static stripInvalidMetaHeaders(html: string): string {
    return html
      .replace(/^\s*<meta\s+http-equiv=["']X-Frame-Options["'][^>]*>\s*$/gim, '')
      .replace(/^\s*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*$/gim, '');
  }

  private static injectCompositionForegroundTransparency(html: string): string {
    const override = `
    <style data-sinter-composition-foreground>
      html, body { background: transparent !important; background-color: transparent !important; }
      body { box-shadow: none !important; }
      [data-ascii-preview-shell], .container, pre {
        background: transparent !important;
        background-color: transparent !important;
        box-shadow: none !important;
      }
    </style>`;
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${override}\n</head>`);
    return html.replace(/<body\b/i, `${override}\n<body`);
  }

  private static escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Detect if code is already wrapped in HTML
   * Checks for complete, valid HTML document structure
   */
  static isAlreadyWrapped(code: string): boolean {
    if (!code || typeof code !== 'string') return false;

    const cleaned = this.stripLLMContaminants(code).trim();

    const hasDoctype = /^<!DOCTYPE\s+html/i.test(cleaned) ||
                       /^<!doctype\s+html/i.test(cleaned);
    const hasHtmlTag = /^<html/i.test(cleaned);
    const hasHtmlEnd = /<\/html>\s*$/i.test(cleaned);

    return (hasDoctype || hasHtmlTag) && hasHtmlEnd;
  }

  /**
   * Strip common LLM output contaminants that break HTML detection
   */
  private static stripLLMContaminants(code: string): string {
    return code
      .replace(/```\w*\n/g, '')
      .replace(/```\s*$/g, '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^Here is (the|your|a) (code|HTML|sketch|shader|scene):?\s*/i, '')
      .replace(/^\*\*[^*]+\*\*\s*/g, '')
      // A meta (custom-domain) artifact carries a leading SINTER-META-DESCRIPTOR
      // comment before <!DOCTYPE html>. Strip it for wrap-detection only so the
      // doctype check below still recognizes the page as already-wrapped (the
      // pass-through branch returns the ORIGINAL code, so the descriptor survives
      // in the artifact). Without this, a descriptor-first page is mis-wrapped as
      // p5 and dumped inside a <script>, breaking the render.
      .replace(/^\s*<!--SINTER-META-DESCRIPTOR[\s\S]*?-->\s*/i, '');
  }

  /**
   * Detect domain from code content
   */
  static detectDomain(code: string): Domain {
    if (this.isAlreadyWrapped(code)) {
      // Already wrapped - try to detect from content
      if (code.includes('@strudel/repl') || code.includes('strudel')) return 'strudel';
      if (code.includes('hydra-synth') || code.includes('new Hydra(')) return 'hydra';
      if (/data-composition-id/i.test(code) && (/gsap\.(?:timeline|from|to)\s*\(/.test(code) || /window\.__timelines/.test(code))) return 'hyperframes';
      if (code.includes('tone@') || /\bTone\./.test(code) || /from\s+['"]tone['"]/.test(code)) return 'tone';
      if (code.includes('import * as THREE') ||
          code.includes('from "three"') ||
          code.includes("from 'three'") ||
          /<script\s+type="importmap"[^>]*>[\s\S]*?"three"[\s\S]*?<\/script>/i.test(code)) {
        return 'three';
      }
      if (code.includes('makeScene') || code.includes('createSignal') || code.includes('useTime') || code.includes('@revideo/core')) return 'revideo';
      if (code.includes('font-family: monospace') && code.includes('<pre>') && !code.includes('createCanvas')) {
        const bodyMatch = code.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
        if (bodyMatch && /[█▓▒░@#%]/.test(bodyMatch[1])) return 'ascii';
      }
      if (code.includes('p5.js') || code.includes('p5.min.js')) return 'p5';
      return 'html';
    }

    // A bpy script is Python, not a web page; it must not fall to the p5 default.
    if (/^\s*(?:import\s+bpy\b|from\s+bpy\b)/m.test(code)) return 'blender';

    // Use GenericWrapper detection for most domains
    const genericDomain = GenericWrapper.detectDomain(code);
    if (genericDomain) return genericDomain;

    if (/^<svg\b/i.test(code.trim())) return 'svg';

    if (/data-composition-id/i.test(code) && (/gsap\.(?:timeline|from|to)\s*\(/.test(code) || /window\.__timelines/.test(code))) {
      return 'hyperframes';
    }

    // Use specific wrappers for P5 and Three
    if (ThreeWrapper.detect(code)) return 'three';
    if (P5Wrapper.detect(code)) return 'p5';

    // Complete HTML detection
    if (/<!DOCTYPE html/i.test(code) || (/<html/i.test(code) && /<body/i.test(code))) {
      return 'html';
    }

    // Default to p5
    return 'p5';
  }

  /**
   * Wrap code in appropriate HTML template
   */
  static wrap(code: string, options?: WrapOptions | Domain): string {
    // Support legacy call with just domain string
    let domain: Domain | undefined;
    let includeP5Sound = false;
    let title = 'Generated Output';
    let autoPlay = false;
    let showPreview = false;
    let asciiWidth = 60;
    let hydraResolution = { width: 1280, height: 800 };
    let compositionForeground = false;
    let libraries: string[] = [];
    let analytics = false;

    if (typeof options === 'string') {
      domain = options;
    } else if (options) {
      domain = options.domain;
      includeP5Sound = options.includeP5Sound ?? false;
      title = options.title ?? 'Generated Output';
      autoPlay = options.autoPlay ?? false;
      showPreview = options.showPreview ?? false;
      asciiWidth = options.asciiWidth ?? 60;
      hydraResolution = options.hydraResolution ?? { width: 1280, height: 800 };
      compositionForeground = options.compositionForeground ?? false;
      libraries = options.libraries ?? [];
      analytics = options.analytics ?? false;
    }

    // Detect domain if not specified
    const detectedDomain = domain || this.detectDomain(code);

    // Don't double-wrap general HTML, but enhance already-wrapped Tone and
    // HyperFrames pages so model-emitted HTML still gets Studio's preview shell.
    if (this.isAlreadyWrapped(code)) {
      const stripped = this.stripInvalidMetaHeaders(code);
      if (compositionForeground) {
        return this.injectCompositionForegroundTransparency(stripped);
      }
      // A page that already carries our shell is final: the renderer re-wraps
      // production playables, and a second shell pushed the artwork out of frame.
      const hasPreviewShell = /data-(?:tone|hyperframes)-preview-shell/.test(code);
      if (detectedDomain === 'tone' && !hasPreviewShell) return GenericWrapper.wrap(code, { domain: 'tone' });
      if (detectedDomain === 'hyperframes' && !hasPreviewShell) {
        return this.injectSecurityHeaders(GenericWrapper.wrap(code, { domain: 'hyperframes', title }), 'hyperframes');
      }
      if (hasPreviewShell) return stripped;
      // A full page the model wrote gets the policy a fragment of its medium
      // gets (FABLE-R3.7), and known CDN libraries load from /vendor so the
      // policy does not blank the page.
      return this.withFullPagePolicy(this.vendorKnownScripts(stripped), detectedDomain as Domain);
    }

    // Route to appropriate wrapper
    let wrapped: string;
    switch (detectedDomain) {
      case 'strudel':
        wrapped = GenericWrapper.wrap(code, { domain: 'strudel', autoPlay });
        break;
      case 'hydra':
        wrapped = GenericWrapper.wrap(code, { domain: 'hydra', hydraResolution });
        break;
      case 'tone':
        wrapped = GenericWrapper.wrap(code, { domain: 'tone' });
        break;
      case 'shader':
        wrapped = GenericWrapper.wrap(code, { domain: 'shader' });
        break;
      case 'three':
        wrapped = ThreeWrapper.wrap(code, { title });
        break;
      case 'revideo':
        wrapped = GenericWrapper.wrap(code, { domain: 'revideo', showPreview });
        break;
      case 'hyperframes':
        wrapped = GenericWrapper.wrap(code, { domain: 'hyperframes', title });
        break;
      case 'ascii':
        // A caller-named page (production's 'Liminal Artwork') must not show the
        // generic "ASCII Art" chrome: textgen poems render through this wrapper.
        wrapped = GenericWrapper.wrap(code, {
          domain: 'ascii', asciiWidth, compositionForeground,
          ...(typeof options === 'object' && options.title ? { title: options.title } : {}),
        });
        break;
      case 'svg':
        wrapped = this.wrapSVG(code, title);
        break;
      // Blender source is Python; the page shows the script as text. The real
      // artifact is the PNG rendered by render/BlenderRenderer.
      case 'blender':
        wrapped = GenericWrapper.wrap(code, { domain: 'ascii', title, asciiWidth });
        break;
      // D3 (dataviz) and custom-medium (meta) output are complete self-contained
      // HTML pages — same pass-through as html.
      case 'dataviz':
      case 'meta':
      case 'html':
        return this.withFullPagePolicy(this.vendorKnownScripts(this.stripInvalidMetaHeaders(code)), detectedDomain);
      case 'p5':
      default:
        wrapped = P5Wrapper.wrap(code, { includeP5Sound, title });
        break;
    }

    const layerReady = compositionForeground
      ? this.injectCompositionForegroundTransparency(wrapped)
      : wrapped;
    // Inject security headers at a single central point for all wrapped outputs
    const withSecurity = this.injectSecurityHeaders(layerReady, detectedDomain);
    // Vendored capability libraries (#1000): single injection point for ALL domains
    const withLibraries = libraries.length
      ? this.injectVendoredLibraries(withSecurity, libraries)
      : withSecurity;

    // PostHog only when the caller asks for it and a key is configured.
    return analytics ? this.injectPostHog(withLibraries) : withLibraries;
  }

  /**
   * Inject vendored capability libraries into a wrapped page's <head>.
   * UMD builds become <script src> tags; ESM builds become importmap entries
   * (merged into an existing importmap when present, else a new block inserted
   * as the first head element so it precedes every module script).
   * Unknown ids throw — see VendoredLibraries.
   */
  private static injectVendoredLibraries(html: string, libs: string[]): string {
    const { scriptTags, importmapEntries, remappedKeys } = libraryIncludes(libs);
    let out = html;
    const entryIds = Object.keys(importmapEntries);
    if (entryIds.length > 0) {
      const importmapRe = /<script type="importmap">\s*([\s\S]*?)\s*<\/script>/;
      const m = importmapRe.exec(out);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { imports: Record<string, string> };
          // Collision policy: a piece-supplied importmap may never shadow a
          // vendored specifier — that would silently redirect library code.
          const collisions = entryIds.filter((id) => id in parsed.imports && !remappedKeys.includes(id));
          if (collisions.length > 0) {
            throw new Error(`injectVendoredLibraries: importmap collision on ${collisions.join(', ')} — vendored specifiers cannot be overridden`);
          }
          // system remaps (e.g. three-webgpu re-pointing `three` for THIS piece)
          // legitimately replace the wrapper default; everything else appends.
          parsed.imports = { ...parsed.imports, ...importmapEntries };
          out = out.replace(m[0], `<script type="importmap">\n${JSON.stringify(parsed, null, 2)}\n  </script>`);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('injectVendoredLibraries:')) throw e;
          // malformed existing importmap: fail loud rather than render dead imports
          throw new Error(`injectVendoredLibraries: existing importmap is not valid JSON (near ${entryIds.join(', ')})`);
        }
      } else {
        const block = `<script type="importmap">${JSON.stringify({ imports: importmapEntries })}</script>\n  `;
        out = out.replace(/<head([^>]*)>/i, (h) => `${h}\n    ${block}`);
      }
    }
    if (scriptTags) {
      out = out.replace(/<\/head>/i, (h) => `    ${scriptTags}\n  ${h}`);
    }
    return out;
  }

  private static wrapSVG(code: string, title: string): string {
    const svg = code.trim();
    // Adaptive framing: a full-bleed SVG that paints its own background looks best
    // edge-to-edge on the dark page; a transparent/line-art SVG needs a light mat
    // to stay visible (this is the hug-content card that fixed SVG washout — keep
    // it only for the case it was designed for).
    const selfFramed = this.svgDeclaresOpaqueBackground(svg);
    const mainStyle = selfFramed
      ? 'background: transparent; box-shadow: none; padding: 0; border: 1px solid rgba(148, 163, 184, 0.18);'
      : 'background: #ffffff; box-shadow: 0 28px 90px rgba(0, 0, 0, 0.42); padding: clamp(14px, 2.5vw, 32px);';
    const tokenStyle = this.svgPreviewTokens(svg);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHTML(title)}</title>
    <style>
        body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(circle at 20% 16%, rgba(125, 211, 252, 0.22), transparent 30%), #0b1020;
        }
        main {
            display: inline-grid;
            place-items: center;
            max-width: 92vw;
            max-height: 92vh;
            border-radius: 28px;
            overflow: hidden;
            ${mainStyle}
        }${tokenStyle}
        svg {
            width: min(72vmin, 760px);
            max-width: 82vw;
            max-height: 82vh;
            height: auto;
            display: block;
        }
    </style>
</head>
<body>
    <main aria-label="Generated SVG">
        ${svg}
    </main>
</body>
</html>`;
  }

  /**
   * Embed fragments (#1162) colour themselves with host CSS tokens such as
   * var(--art-red). Standalone, those resolve to nothing and the evaluator
   * judges a black frame. Define preview stand-ins for tokens the SVG neither
   * defines nor gives a fallback; the fragment itself is left unchanged.
   */
  private static svgPreviewTokens(svg: string): string {
    const names = new Set([...svg.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(m => m[1]));
    const missing = [...names].filter(n => !new RegExp(`${n}\\s*:`).test(svg));
    if (missing.length === 0) return '';
    const decls = missing.map(n => `${n}: ${this.previewTokenColor(n)};`).join(' ');
    return `\n        /* host-token preview stand-ins (#1162) */\n        main { ${decls} }`;
  }

  private static previewTokenColor(name: string): string {
    const hints: Array<[RegExp, string]> = [
      [/red|crimson|rose/, '#d94a3d'], [/orange|amber/, '#e8833a'], [/yellow|gold/, '#e6b422'],
      [/green|lime|moss/, '#3fa86b'], [/teal|cyan|aqua/, '#2bb3b1'], [/blue|navy|sky/, '#3b82f6'],
      [/purple|violet|indigo/, '#8b5cf6'], [/pink|magenta/, '#e0559b'],
      [/ink|black|dark|text|fg|fore/, '#1c1f26'], [/paper|bg|back|white|light|surface/, '#f5f1e8'],
      [/gr[ae]y|muted|mid/, '#8a8f98'],
    ];
    const hit = hints.find(([re]) => re.test(name));
    if (hit) return hit[1];
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 60% 50%)`;
  }

  /**
   * True when the SVG paints its own opaque background — a near-canvas-sized
   * <rect> with a real fill, an opaque fill on the <svg> root, or a CSS
   * background on the root. Such art is full-bleed and should be framed
   * edge-to-edge rather than sat on a white mat.
   */
  private static svgDeclaresOpaqueBackground(svg: string): boolean {
    const viewBox = svg.match(/viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
    const rootWidth = svg.match(/<svg[^>]*\bwidth\s*=\s*["']?([\d.]+)/i);
    const rootHeight = svg.match(/<svg[^>]*\bheight\s*=\s*["']?([\d.]+)/i);
    const canvasW = viewBox ? parseFloat(viewBox[1]) : rootWidth ? parseFloat(rootWidth[1]) : 0;
    const canvasH = viewBox ? parseFloat(viewBox[2]) : rootHeight ? parseFloat(rootHeight[1]) : 0;

    for (const match of svg.matchAll(/<rect\b[^>]*>/gi)) {
      const tag = match[0];
      const fill = tag.match(/\bfill\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().toLowerCase();
      if (!fill || fill === 'none' || fill === 'transparent') continue;
      const widthValue = tag.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
      const heightValue = tag.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
      if (!widthValue || !heightValue) continue;
      const coversW = widthValue === '100%' || (canvasW > 0 && parseFloat(widthValue) >= canvasW * 0.9);
      const coversH = heightValue === '100%' || (canvasH > 0 && parseFloat(heightValue) >= canvasH * 0.9);
      const x = parseFloat(tag.match(/\bx\s*=\s*["']([^"']+)["']/i)?.[1] ?? '0');
      const y = parseFloat(tag.match(/\by\s*=\s*["']([^"']+)["']/i)?.[1] ?? '0');
      if (coversW && coversH && Math.abs(x) <= canvasW * 0.05 + 1 && Math.abs(y) <= canvasH * 0.05 + 1) {
        return true;
      }
    }

    if (/<svg[^>]*\bfill\s*=\s*["'](?!none|transparent)[^"']+["']/i.test(svg)) return true;
    if (/<svg[^>]*\bstyle\s*=\s*["'][^"']*background[^"']*["']/i.test(svg)) return true;
    return false;
  }

  /**
   * Inject the PostHog snippet into HTML and open the CSP for its origin only.
   * No-op when LIMINAL_POSTHOG_KEY is unset or LIMINAL_POSTHOG_HOST is not an
   * https URL. Values are JSON-encoded so a crafted key or host cannot break
   * out of the script. Persistence is in memory: no cookie, no localStorage.
   */
  private static injectPostHog(html: string): string {
    const apiKey = process.env.LIMINAL_POSTHOG_KEY;
    if (!apiKey) return html;

    let origin: string;
    let host: string;
    try {
      const url = new URL(process.env.LIMINAL_POSTHOG_HOST || 'https://puenteworks.com/ph');
      if (url.protocol !== 'https:') return html;
      origin = url.origin;
      host = url.href.replace(/\/$/, '');
    } catch {
      return html;
    }
    const js = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
    const snippet = `<script>
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},o="capture identify page people.set people.set_once set_config register register_once alias unregister get_distinct_id get_property clear_charges has_charged set_super_properties set_super_properties_once set_once register_for_session unregister_for_session reset get_session_id get_distinct_id_for_session debug evaluate isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags updateEarlyAccessFeatureEnrollment onFeatureFlags onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${js(apiKey)},{api_host:${js(host)},persistence:'memory',capture_pageview:true,capture_pageleave:false});
</script>`;

    const withCsp = html.replace(
      /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/,
      (_m, open: string, csp: string, close: string) => {
        const opened = csp
          .replace(/script-src ([^;]*);/, `script-src $1 ${origin};`)
          .replace(/connect-src 'none';/, `connect-src ${origin};`)
          .replace(/connect-src ((?!'none')[^;]*);/, `connect-src $1 ${origin};`);
        return `${open}${opened}${close}`;
      },
    );
    return withCsp.replace('</head>', `${snippet}
</head>`);
  }

  /**
   * Get all supported domains
   */
  static getSupportedDomains(): Domain[] {
    return ['p5', 'shader', 'three', 'strudel', 'hydra', 'tone', 'revideo', 'hyperframes', 'svg', 'html', 'dataviz', 'meta', 'ascii', 'blender'];
  }

  /**
   * Validate if a domain is supported
   */
  static isValidDomain(domain: string): domain is Domain {
    return this.getSupportedDomains().includes(domain as Domain);
  }
}

export default HTMLWrapper;
