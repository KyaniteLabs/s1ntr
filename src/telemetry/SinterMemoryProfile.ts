let stage = 'startup';

if (process.env.SINTER_PROFILE_MEMORY === '1') {
  const startedAt = Date.now();
  const mib = (bytes: number): number => Math.round(bytes / 1048576);
  setInterval(() => {
    const memory = process.memoryUsage();
    process.stderr.write(`[sinter-memory] elapsedMs=${Date.now() - startedAt} stage=${stage} rssMiB=${mib(memory.rss)} heapUsedMiB=${mib(memory.heapUsed)} externalMiB=${mib(memory.external)} arrayBuffersMiB=${mib(memory.arrayBuffers)}\n`);
  }, 1000).unref();
}

export function setSinterMemoryStage(next: string): void {
  if (process.env.SINTER_PROFILE_MEMORY === '1') stage = next;
}
