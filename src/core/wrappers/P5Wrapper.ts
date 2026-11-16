/**
 * P5.js-specific HTML wrapper
 * Wraps p5.js sketch code in a complete HTML document
 */

import { P5_SENSOR_POLICY_SCRIPT, SECURITY_HEADERS } from './SecurityHeaders.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

const P5_CDN = VENDOR_ASSETS.p5;
const P5_SOUND_CDN = VENDOR_ASSETS.p5Sound;

export interface P5WrapOptions {
  title?: string;
  includeP5Sound?: boolean;
}

export class P5Wrapper {
  /**
   * Detect if code is p5.js code
   */
  static detect(code: string): boolean {
    // p5.js detection - default if no other domain matches
    // Check for p5.js patterns
    const hasSetup = /function\s+setup\s*\(/.test(code);
    const hasDraw = /function\s+draw\s*\(/.test(code);
    const hasCreateCanvas = /createCanvas\s*\(/.test(code);
    const hasP5Functions = /\b(background|fill|stroke|ellipse|rect|line|point)\s*\(/.test(code);

    return (hasSetup || hasDraw || hasCreateCanvas || hasP5Functions) &&
           !this.isOtherDomain(code);
  }

  private static isOtherDomain(code: string): boolean {
    // Check if it matches other domains
    const hasStrudel = /\bstack\s*\(|\bs\s*\(\s*["']/.test(code);
    const hasHydra = /\bosc\s*\(|\bshape\s*\(|\.kaleid\s*\(|\.out\s*\(/.test(code);
    const hasTone = /\bTone\.|\bSynth\b|\bTransport\b/.test(code);
    const hasThree = /\bTHREE\.|\bScene\s*\(|\bCamera\s*\(/.test(code);
    const hasShader = /gl_FragColor|uniform\s+vec/.test(code);
    const hasRevideoOrVideo = /@revideo\/(core|2d)|\bmakeScene\s*\(/.test(code);
    const hasASCII = /[█▓▒░@#%*+=~^_/\\|-]{8,}/.test(code) && !/\b(function|const|let|var|import|export)\b/.test(code);

    return hasStrudel || hasHydra || hasTone || hasThree || hasShader || hasRevideoOrVideo || hasASCII;
  }

  /**
   * Wrap p5.js code in HTML
   */
  static wrap(code: string, options: P5WrapOptions = {}): string {
    const { title = 'p5.js Sketch', includeP5Sound = false } = options;
    
    const safeCode = scriptSafe(code);
    const usesWebAudio = /AudioContext|createOscillator|p5\.sound/i.test(code);
    const soundComment = usesWebAudio
      ? '\n    <!-- Sound may require user click to start (browser policy). -->'
      : '';
    const p5SoundScript = includeP5Sound
      ? `\n    <script src="${P5_SOUND_CDN}"></script>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${SECURITY_HEADERS.trim()}
    <title>${title}</title>
    ${P5_SENSOR_POLICY_SCRIPT.trim()}
    <script src="${P5_CDN}"></script>${p5SoundScript}
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #0b1020; }
        body { display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
        main { width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
        /* Fill the frame edge-to-edge: a centered fixed-size canvas otherwise leaves
           letterbox margins that both look unfinished and skew the render-quality gate
           (the margin color, not the art, dominates the luminance measurement). */
        main canvas { width: 100% !important; height: 100% !important; object-fit: cover; display: block; }
    </style>
</head>
<body>${soundComment}
    <main>
        <script>
${safeCode}
        </script>
    </main>
</body>
</html>`;
  }
}

export default P5Wrapper;
