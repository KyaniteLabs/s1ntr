/**
 * A local stand-in for the Anthropic Message Batches API (loopback only; no key, no network, no money).
 * It validates what the real API would reject (custom_id shape, forbidden params, max_tokens >= 1) and records every call so a test
 * can prove what the lane sent: how many batches, which custom_ids, which headers, and that nothing but generation requests arrived.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeBatchOutcome =
  | { type: 'succeeded'; text: string; stopReason?: string; usage?: Record<string, number> }
  | { type: 'errored'; errorType?: string; message?: string }
  | { type: 'expired' };

export interface FakeBatchRequest { custom_id: string; params: Record<string, any> }
export interface FakeBatch { id: string; requests: FakeBatchRequest[]; polls: number; canceled: boolean; submittedAt: number }
export interface FakeAnthropicOptions {
  /** Outcome for a request. `attempt` counts how many times this custom_id has been submitted (1-based). */
  readonly reply: (req: FakeBatchRequest, ctx: { batchIndex: number; attempt: number }) => FakeBatchOutcome;
  /** Polls that answer in_progress before the batch ends. Default 1. */
  readonly pollsBeforeEnd?: number;
  /** The first N submits answer 429. */
  readonly rateLimitSubmits?: number;
  /** Close the connection with 500 on the first submit AFTER the batch was recorded (crash-window probe). */
  readonly failFirstSubmitResponse?: boolean;
}
export interface FakeAnthropic {
  readonly baseUrl: string;
  readonly batches: FakeBatch[];
  readonly submitHeaders: Array<Record<string, string | string[] | undefined>>;
  readonly violations: string[];
  readonly otherCalls: string[];
  /** Hits to the live /v1/messages endpoint (a batch lane never makes any). */
  readonly liveMessages: number;
  submitAttempts(): number;
  close(): Promise<void>;
}

const FORBIDDEN = ['temperature', 'top_p', 'top_k', 'stream', 'speed', 'fallbacks', 'thinking', 'tool_choice'];

export async function startFakeAnthropic(options: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const batches: FakeBatch[] = []; const violations: string[] = []; const submitHeaders: FakeAnthropic['submitHeaders'] = []; const otherCalls: string[] = [];
  const attempts = new Map<string, number>(); let submits = 0; let live = 0; let failedOnce = false;
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'application/x-jsonl' : 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const counts = (b: FakeBatch, ended: boolean) => {
    const c = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    b.requests.forEach((r) => {
      if (!ended) { c.processing++; return; }
      const o = outcomeOf(b, r);
      if (o.type === 'succeeded') c.succeeded++; else if (o.type === 'errored') c.errored++; else c.expired++;
    });
    return c;
  };
  const outcomes = new Map<string, FakeBatchOutcome>();
  const outcomeOf = (b: FakeBatch, r: FakeBatchRequest): FakeBatchOutcome => {
    const k = `${b.id}/${r.custom_id}`;
    let o = outcomes.get(k);
    if (!o) {
      const attempt = attempts.get(r.custom_id) ?? 1;
      o = options.reply(r, { batchIndex: batches.indexOf(b), attempt }); outcomes.set(k, o);
    }
    return o;
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? ''; const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && url === '/v1/messages/batches') {
        submits++;
        submitHeaders.push({ ...req.headers });
        if (submits <= (options.rateLimitSubmits ?? 0)) { send(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0' }); return; }
        const parsed = JSON.parse(body) as { requests: FakeBatchRequest[] };
        const seen = new Set<string>();
        for (const r of parsed.requests) {
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(r.custom_id)) violations.push(`bad custom_id ${r.custom_id}`);
          if (seen.has(r.custom_id)) violations.push(`duplicate custom_id ${r.custom_id}`); seen.add(r.custom_id);
          for (const k of FORBIDDEN) if (k in r.params) violations.push(`${r.custom_id} sent ${k}`);
          if (JSON.stringify(r.params).includes('budget_tokens')) violations.push(`${r.custom_id} sent budget_tokens`);
          if (!(Number.isInteger(r.params.max_tokens) && r.params.max_tokens >= 1)) violations.push(`${r.custom_id} max_tokens < 1`);
          const last = r.params.messages?.at(-1);
          if (last?.role === 'assistant') violations.push(`${r.custom_id} ends with an assistant prefill`);
          attempts.set(r.custom_id, (attempts.get(r.custom_id) ?? 0) + 1);
        }
        const b: FakeBatch = { id: `msgbatch_fake${batches.length + 1}`, requests: parsed.requests, polls: 0, canceled: false, submittedAt: Date.now() };
        batches.push(b);
        if (options.failFirstSubmitResponse && !failedOnce) { failedOnce = true; res.destroy(); return; }
        send(res, 200, { id: b.id, type: 'message_batch', processing_status: 'in_progress', request_counts: counts(b, false) });
        return;
      }
      const m = /^\/v1\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(url);
      if (m) {
        const b = batches.find((x) => x.id === m[1]);
        if (!b) { send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'no such batch' } }); return; }
        if (req.method === 'POST' && m[2] === '/cancel') { b.canceled = true; send(res, 200, { id: b.id, processing_status: 'canceling', request_counts: counts(b, false) }); return; }
        if (req.method === 'GET' && m[2] === '/results') {
          const lines = [...b.requests].reverse().map((r) => { // any order: the lane must key by custom_id
            const o = outcomeOf(b, r);
            if (o.type === 'succeeded') return JSON.stringify({ custom_id: r.custom_id, result: { type: 'succeeded', message: { id: `msg_${r.custom_id}`, type: 'message', role: 'assistant', model: r.params.model,
              content: [{ type: 'text', text: o.text }], stop_reason: o.stopReason ?? 'end_turn', usage: o.usage ?? { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } });
            if (o.type === 'errored') return JSON.stringify({ custom_id: r.custom_id, result: { type: 'errored', error: { type: 'error', error: { type: o.errorType ?? 'api_error', message: o.message ?? 'boom' } } } });
            return JSON.stringify({ custom_id: r.custom_id, result: { type: 'expired' } });
          });
          send(res, 200, lines.join('\n') + '\n'); return;
        }
        if (req.method === 'GET' && !m[2]) {
          b.polls++;
          const ended = b.polls > (options.pollsBeforeEnd ?? 1);
          send(res, 200, { id: b.id, type: 'message_batch', processing_status: ended ? 'ended' : 'in_progress', request_counts: counts(b, ended) }); return;
        }
      }
      if (url.startsWith('/v1/messages')) { live++; send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'the batch lane must not call live messages' } }); return; }
      otherCalls.push(`${req.method} ${url}`); send(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, batches, submitHeaders, violations, otherCalls, get liveMessages() { return live; }, submitAttempts: () => submits,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
}
