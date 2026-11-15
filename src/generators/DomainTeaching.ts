import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeneratorHarnessTools } from './GeneratorHarnessTools.js';

/**
 * Shared domain teaching block: active system lessons (`.omx/atelier/lessons/
 * hints.json` — the bandit's A/B arm surface) plus the best-per-domain exemplar
 * anchor. BOTH generation paths must call this: the spine
 * (LiminalProductionEffects) and GenerationOrchestrator. Teaching wired into
 * only one path silently disconnects the whole learning loop — the bandit
 * ablates lessons the generator never sees.
 */
export function buildDomainTeaching(domain: string): string {
  try {
    const parts: string[] = [];
    const tools = new GeneratorHarnessTools({ seededRandom: () => 0.42 });
    const ctx = tools.prepare(domain.toLowerCase());
    if (ctx.hardeningHints.length > 0) {
      parts.push(`Rules you MUST follow:\n${ctx.hardeningHints.map(h => `- ${h}`).join('\n')}`);
    }
    const trackerPath = join(process.cwd(), '.omx', 'atelier', 'best-per-domain.json');
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, 'utf8')) as Record<string,
        { dir?: string; mean?: number; scoreScale?: number }>;
      const best = tracker[domain.toLowerCase()];
      if (best?.dir && best.mean && best.mean >= 2.5) {
        const srcPath = join(best.dir, 'source.txt');
        if (existsSync(srcPath)) {
          const anchor = readFileSync(srcPath, 'utf8').slice(0, 3500);
          const scale = best.scoreScale === 5 || best.scoreScale === 10
            ? `/${best.scoreScale}` : ' (scale unrecorded)';
          parts.push(`EXEMPLAR (our best ${domain} work, recorded mean quality ${best.mean.toFixed(2)}${scale} — match or exceed its craft, do not copy it):\n${anchor}`);
        }
      }
    }
    return parts.join('\n\n');
  } catch { return ''; }
}
