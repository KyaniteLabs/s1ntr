import { execFileSync } from 'node:child_process';
import { canonicalCliSeatUrl } from '../identity/cliSeatUrl.js';

export interface RotationLane {
  modelId: string;
  provider: string;
  baseUrl?: string;
  note?: string;
  dispatchExecutor?: string;
}

export interface LaneHealth extends RotationLane {
  executor: string | null;
  status: 'available' | 'unavailable' | 'unmapped' | 'doctor-unavailable';
}

interface DoctorRow {
  executor: string;
  available: boolean;
  cooldown?: boolean;
  needs_relogin?: boolean;
}

/** Only exact Sinter model/adapter pairs may inherit a Dispatch health signal. */
/** Models a matrix-named HTTP Dispatch executor may serve (exact ids). */
const HTTP_DISPATCH_MODELS: ReadonlySet<string> = new Set(['Qwen3.8-27B', 'Ornith-1.5-35B']);

export function executorForLane(lane: RotationLane): string | null {
  const base = canonicalCliSeatUrl(lane.baseUrl ?? '');
  const id = lane.modelId.toLowerCase();
  // LAN HTTP art calls need an explicit Dispatch executor (named by the
  // rotation matrix) serving one of the known models exactly. Doctor enforces
  // the CS reservation before selection.
  if (lane.dispatchExecutor) {
    if (!HTTP_DISPATCH_MODELS.has(lane.modelId) || lane.provider !== 'openai') return null;
    try {
      const url = new URL(base);
      return url.protocol === 'http:' && url.pathname === '/v1' ? lane.dispatchExecutor : null;
    } catch { return null; }
  }
  if (base === 'cli://codex') {
    const codex: Record<string, string> = {
      'gpt-6-luna': 'codex-luna',
      'gpt-5.6-luna': 'codex-luna',
      'gpt-5.6-terra': 'codex-terra',
      'gpt-5.6-sol': 'codex-sol',
    };
    return codex[id] ?? null;
  }
  if (base === 'cli://agy' && id === 'gemini-3.7-flash-medium') return 'agy-gemini-flash';
  if (base === 'cli://command-code' && id === 'deepseek/deepseek-v4-pro' && lane.provider === 'cli') return 'command-code';
  let host = '';
  try { host = new URL(base).hostname; } catch { return null; }
  if (host === 'api.z.ai' && id === 'glm-5.3') return 'zai-glm';
  if (host === 'api.z.ai' && id === 'glm-5.3-flash') return 'zai-glm-flash';
  if (host === 'api.minimax.io' && id === 'minimax-m3') return 'minimax-m3';
  if (host === 'token-plan-sgp.xiaomimimo.com' && id === 'mimo-v2.5-pro') return 'xiaomi-mimo';
  if (host === 'api.deepinfra.com' && id === 'deepseek-ai/deepseek-v4-flash-0731') return 'deepinfra-dsv4flash';
  if (host === 'api.kilo.ai' && new URL(base).pathname === '/api/gateway'
      && id === 'qwen/qwen3.8-27b:free' && lane.provider === 'openai') return 'kilo-free-auto';
  return null;
}

export function readDispatchDoctor(): DoctorRow[] | null {
  try {
    const rows: unknown = JSON.parse(execFileSync('pushing-dispatch', ['doctor', '--json'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    }));
    if (!Array.isArray(rows) || !rows.every(row =>
      row && typeof row.executor === 'string' && typeof row.available === 'boolean')) return null;
    return rows as DoctorRow[];
  } catch {
    return null;
  }
}

export function auditRotation(lanes: readonly RotationLane[], doctor: readonly DoctorRow[] | null): LaneHealth[] {
  const health = new Map(doctor?.map(row => [row.executor, row]));
  return lanes.map(lane => {
    const executor = executorForLane(lane);
    const row = executor ? health.get(executor) : undefined;
    const status = !executor ? 'unmapped'
      : !doctor ? 'doctor-unavailable'
      : row?.available && !row.cooldown && !row.needs_relogin ? 'available' : 'unavailable';
    return { ...lane, executor, status };
  });
}
