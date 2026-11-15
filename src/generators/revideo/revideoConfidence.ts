export function revideoConfidence(prompt: string): number {
  const lower = prompt.toLowerCase();
  if (/\b(?:do not|don't|dont|never|avoid)\s+(?:use\s+)?(?:remotion|revideo)\b/.test(lower)) return 0;
  if (/\b(revideo)\b/.test(lower)) return 0.95;
  if (/\b(remotion)\b/.test(lower)) return 0.55;
  if (/\b(video|animation|motion\s*graphics|title\s*sequence|intro\s*video)\b/.test(lower)) return 0.8;
  return 0;
}
