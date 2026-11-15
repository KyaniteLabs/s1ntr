/* eslint-disable no-console -- CLI command output: console output is intentional */
import { PromptOrgan } from '../atelier/PromptOrgan.js';

export function runPromptNextCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  const organ = new PromptOrgan(cwd);

  if (cmdArgs[0] === 'stats') {
    const stats = organ.stats();
    console.log(`[prompt-organ] ${stats.totalPrompts} prompts generated`);
    console.log(`[prompt-organ] by source:`, JSON.stringify(stats.bySource));
    if (stats.topFeatures.length > 0) {
      console.log(`[prompt-organ] top features by avg score:`);
      for (const f of stats.topFeatures.slice(0, 5)) {
        console.log(`  ${f.avgScore.toFixed(2)}  ${f.feature}`);
      }
    }
    return;
  }

  const prompt = organ.next();
  console.log(JSON.stringify({ text: prompt.text, domain: prompt.domain, source: prompt.source }));
  organ.save();
}
