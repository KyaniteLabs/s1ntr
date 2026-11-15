import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { MetaHarnessIntegration } from '../../../src/harness/MetaHarnessIntegration.js';
import { LLMClient, withHarnessTransportAuthority } from '../../../src/llm/LLMClient.js';
import { TuiBridgeServer } from '../../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../../src/tui-bridge/TuiBridgeService.js';
import { bootstrapExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';

const authorityRoot = mkdtempSync(join(tmpdir(), 'entrypoint-authority-'));
const originalNodeEnv = process.env.NODE_ENV;
const originalRoot = process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
const originalCsrf = process.env.CSRF_SECRET;

afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalRoot === undefined) delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
  else process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = originalRoot;
  if (originalCsrf === undefined) delete process.env.CSRF_SECRET;
  else process.env.CSRF_SECRET = originalCsrf;
  rmSync(authorityRoot, { recursive: true, force: true });
});

describe('entrypoint authority wiring', () => {
  it('injects one explicit test authority through harness, coordinator, Studio, and bridge', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    process.env.CSRF_SECRET = 'executor-authority-entrypoint-test-secret';
    const authority = bootstrapExecutorAuthority({ rootDir: authorityRoot });
    const llm = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:8317/v1',
      model: 'claude-opus-4-1', apiKey: 'seat-test', harnessTransportAuthority: authority });
    expect(Reflect.get(llm, 'harnessTransportAuthority')).toBe(authority);

    const coordinator = new CreativeRunCoordinator({ executorAuthority: authority });
    expect(Reflect.get(coordinator, 'executorAuthority')).toBe(authority);

    const service = new TuiBridgeService({ executorAuthority: authority });
    const serviceCoordinator = Reflect.get(service, 'creativeRunCoordinator');
    expect(Reflect.get(serviceCoordinator, 'executorAuthority')).toBe(authority);

    const server = new TuiBridgeServer(service);
    expect(server).toBeInstanceOf(TuiBridgeServer);

    const harness = new MetaHarnessIntegration(authority);
    expect(Reflect.get(harness, 'harnessTransportAuthority')).toBe(authority);
    service.destroy();
  });

  it('lets a scoped campaign authority override only auto-injected runtime authority', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    const runtimeAuthority = bootstrapExecutorAuthority({ rootDir: authorityRoot });
    const automatic = new LLMClient({ role: 'generator', baseUrl: 'http://localhost:8317/v1',
      model: 'gemini-3.6-flash-high', apiKey: 'seat-test', harnessTransportAuthority: runtimeAuthority });
    const scopedAuthority = { ...runtimeAuthority };
    const currentAuthority = (client: LLMClient) => Reflect.get(client, 'currentHarnessAuthority').call(client);

    await withHarnessTransportAuthority(scopedAuthority, async () => {
      expect(currentAuthority(automatic)).toStrictEqual(scopedAuthority);
      const pinned = new LLMClient({ role: 'generator', baseUrl: 'http://localhost:8317/v1',
        model: 'gemini-3.6-flash-high', apiKey: 'seat-test', harnessTransportAuthority: runtimeAuthority });
      expect(currentAuthority(pinned)).toBe(runtimeAuthority);
    });
  });
});
