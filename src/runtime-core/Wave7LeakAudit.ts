import fs from 'node:fs';
import path from 'node:path';

export interface Wave7LeakFinding {
  file: string;
  rule: 'credential' | 'authorization' | 'private-path' | 'email';
}

const RULES: Array<{ rule: Wave7LeakFinding['rule']; pattern: RegExp }> = [
  { rule: 'credential', pattern: /(?:^|[\s"'=:])(?:sk|key|token)-(?!effectiveness\b|id-untrusted\b)[a-z0-9_-]{12,}\b/i },
  { rule: 'authorization', pattern: /(?:\bauthorization\s*:\s*bearer(?:\s+|-)[a-z0-9._~+/-]{8,}\b|\b(?:api[-_]?key|password|secret)\s*[=:]\s*["'](?!\[REDACTED\]|\$\{)[^"']{8,}["'])/i },
  { rule: 'authorization', pattern: /\b(?:api[-_]?key|password|secret)\s*=\s*(?!\[REDACTED\]|\$\{|undefined\b|null\b)(?![a-z_$][a-z0-9_$]*\s*\()[a-z0-9_~+/-]{8,}\b/i },
  { rule: 'authorization', pattern: /\b(?:api[-_]?key|password|secret)\s*:\s*(?!\[REDACTED\]|\$\{|Uint8Array\b)(?![a-z_$][a-z0-9_$]*(?:\?\.|\.))(?=[a-z0-9_~+/-]{8,}\b)(?=[a-z0-9_~+/-]*[-0-9])[a-z0-9_~+/-]{8,}\b/i },
  { rule: 'private-path', pattern: /\/(?:Users|home)\/(?!<user>)[^/$\s"']+\// },
  { rule: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
];

function filesUnder(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? filesUnder(child) : entry.isFile() ? [child] : [];
  });
}

export function auditWave7Artifacts(targets: string[]): { passed: boolean; filesScanned: number; findings: Wave7LeakFinding[] } {
  const files = targets.flatMap(filesUnder).sort();
  const findings: Wave7LeakFinding[] = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const { rule, pattern } of RULES) if (pattern.test(text)) findings.push({ file, rule });
  }
  return { passed: findings.length === 0, filesScanned: files.length, findings };
}
