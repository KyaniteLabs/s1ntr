import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve =>
    server.close(() => resolve()))));
});

describe('compiled campaign continuation CLI transport', () => {
  it('sends the owner-bound request to the local bridge and returns its exact projection', async () => {
    const projection = { transferOutcome: 'inconclusive', campaignOriginDigest: 'f'.repeat(64) };
    const request = new Promise<{ method?: string; url?: string; authorization?: string }>(resolve => {
      const server = createServer((incoming, response) => {
        resolve({ method: incoming.method, url: incoming.url,
          authorization: incoming.headers.authorization });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(projection));
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
    });
    await new Promise<void>(resolve => servers[0]!.once('listening', () => resolve()));
    const address = servers[0]!.address();
    if (!address || typeof address === 'string') throw new Error('local bridge did not bind');
    const result = await execFileAsync(process.execPath, ['bin/sinter', 'campaign-continue',
      '--bridge-url', `http://127.0.0.1:${address.port}`, '--session', 'session-a',
      '--campaign-run-id', 'campaign-a'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, SINTER_OWNER_AUTHORIZATION: 'owner-proof' },
    });
    expect(await request).toEqual({ method: 'POST',
      url: '/api/tui/session/session-a/governed-campaign/campaign-a/continuation',
      authorization: 'Bearer owner-proof' });
    expect(JSON.parse(result.stdout)).toEqual(projection);
  });
});
