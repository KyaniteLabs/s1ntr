import type { EntropyHarvesterDeps, EntropySourceCounts } from './types.js';

export class EntropyHarvester {
  constructor(private deps: EntropyHarvesterDeps) {}

  async gather(): Promise<string> {
    return (await this.gatherWithSources()).input;
  }

  /** Gather input and report how many items each source actually contributed. */
  async gatherWithSources(): Promise<{ input: string; sources: EntropySourceCounts }> {
    const sources: EntropySourceCounts = { events: 0, heapFiles: 0, seeds: 0, telemetry: 0 };
    const events = this.deps.eventStore.getRecent(20);
    sources.events = events.length;
    const eventsJson = JSON.stringify(events);

    let fragmentsText = '';
    try {
      const heapFiles = await this.deps.heap.listFiles();
      const listed = heapFiles.slice(0, 10);
      sources.heapFiles = listed.length;
      fragmentsText += listed.join('\n');
    } catch {
      // heap may not be available
    }

    try {
      const seeds = await this.deps.getTopSeeds?.(3);
      if (seeds && seeds.length > 0) {
        sources.seeds = seeds.length;
        fragmentsText += '\n' + seeds.map(s => `[${s.id}:${s.score.toFixed(2)}] ${s.content.slice(0, 200)}`).join('\n');
      }
    } catch {
      // seeds may not be available
    }

    const summary = this.deps.telemetry.getSummary();
    sources.telemetry = summary.totalTasks > 0 ? 1 : 0;
    const telemetryJson = JSON.stringify({
      successRate: summary.successRate,
      avgDurationMs: summary.avgDurationMs,
      totalTasks: summary.totalTasks,
      totalViolations: summary.totalViolations,
    });

    const input = `[EVENTS]${eventsJson}[/EVENTS][FRAGMENTS]${fragmentsText}[/FRAGMENTS][TELEMETRY]${telemetryJson}[/TELEMETRY]`;
    return { input, sources };
  }

  setGetTopSeeds(fn: (n: number) => Promise<{ id: string; content: string; score: number }[]>): void {
    this.deps.getTopSeeds = fn;
  }
}
