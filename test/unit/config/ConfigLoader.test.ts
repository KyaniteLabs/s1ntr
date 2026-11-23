import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig, updateConfig, getEffectiveConfig, loadProjectConfig } from '../../../src/config/ConfigLoader.js';
import { Logger } from '../../../src/utils/Logger.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — required for vi.mock() factory references
// ---------------------------------------------------------------------------

const { mockReadFile, mockWriteFile, mockMkdir, mockStat, mockAccess, mockCopyFile, mockWriteFileAtomic, mockMigrateConfigHome } = vi.hoisted(() => ({
  mockMigrateConfigHome: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockStat: vi.fn(),
  mockAccess: vi.fn(),
  mockCopyFile: vi.fn(),
  mockWriteFileAtomic: vi.fn(),
}));

vi.mock('../../../src/utils/fileLock.js', () => ({ withFileLock: async (_p: string, fn: () => unknown) => fn() }));
vi.mock('fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    stat: mockStat,
    access: mockAccess,
    copyFile: mockCopyFile,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  stat: mockStat,
  access: mockAccess,
  copyFile: mockCopyFile,
}));

// Keeps these tests away from the real home folder; the move itself is covered
// with real files in migrateConfigHome.test.ts.
vi.mock('../../../src/config/migrateConfigHome.js', () => ({
  migrateConfigHome: mockMigrateConfigHome,
}));

vi.mock('../../../src/utils/atomicWrite.js', () => ({
  writeFileAtomic: mockWriteFileAtomic,
  writeFileAtomicSync: vi.fn(),
}));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/config/RoleConfig.js', () => ({
  loadRoleConfig: vi.fn().mockResolvedValue({}),
}));

// ===========================================================================
// loadConfig
// ===========================================================================

describe('loadConfig', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAccess.mockImplementation(async () => {});
  });

  it('returns parsed config from JSON file', async () => {
    const configJson = JSON.stringify({
      defaultProvider: 'openai',
      providers: { openai: { apiKey: 'sk-test-openai-key' } },
    });
    mockReadFile.mockResolvedValue(configJson);

    const result = await loadConfig('/test/config.json');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test-openai-key' } },
      });
    }
  });

  it('returns Err when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadConfig('/nonexistent/config.json');
    expect(result.isErr()).toBe(true);
  });

  it('returns Err for invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not valid json {{{');
    const result = await loadConfig('/bad/config.json');
    expect(result.isErr()).toBe(true);
  });

  it('returns Err for empty file content', async () => {
    mockReadFile.mockResolvedValue('');
    const result = await loadConfig('/empty/config.json');
    expect(result.isErr()).toBe(true);
  });
});

// ===========================================================================
// saveConfig
// ===========================================================================

describe('saveConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockReset();
    mockReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mockAccess.mockImplementation(async () => {});
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFileAtomic.mockResolvedValue(undefined);
  });

  it('writes config as JSON creating directory', async () => {
    const config = { defaultProvider: 'test', providers: {} };
    await saveConfig(config, '/tmp/test-config.json');

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
    expect(mockWriteFileAtomic).toHaveBeenCalledWith(
      '/tmp/test-config.json',
      JSON.stringify(config, null, 2),
      { mode: 0o600 },
    );
  });

  it('writes atomically with private (0600) permissions', async () => {
    const config = { defaultProvider: 'ollama', providers: { ollama: {} } };
    await saveConfig(config, '/tmp/nested/path/config.json');

    const [writtenPath, writtenContent, opts] = mockWriteFileAtomic.mock.calls.at(-1) ?? [];
    expect(writtenPath).toBe('/tmp/nested/path/config.json');
    expect(opts).toEqual({ mode: 0o600 });
    expect(writtenContent).toContain('  "defaultProvider"');
    expect(writtenContent).toContain('  "providers"');
  });

  it('serializes role-specific evaluator config', async () => {
    const config = {
      defaultProvider: 'glm',
      providers: {
        glm: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.1' },
      },
      roles: {
        evaluator: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'google/gemini-2.5-flash',
          apiKey: 'vision-key',
        },
      },
    };
    await saveConfig(config, '/tmp/role-config.json');

    const writtenContent = mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string;
    expect(writtenContent).toContain('"evaluator"');
    expect(writtenContent).toContain('"google/gemini-2.5-flash"');
  });

  it('deep-merges instead of clobbering role, fallback, and capability sections', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      defaultProvider: 'glm',
      providers: { glm: { model: 'glm-5.2', apiKey: 'glm-key' } },
      roles: { evaluator: { provider: 'glm', model: 'glm-5.2' } },
      fallbacks: { evaluator: ['minimax'] },
      capabilities: { 'glm-5.2': { vision: true } },
    }));

    await saveConfig({
      defaultProvider: 'openai',
      providers: { openai: { model: 'gpt-5.4' } },
    }, '/tmp/merge-config.json');

    const written = JSON.parse(mockWriteFileAtomic.mock.calls.at(-1)?.[1] as string);
    expect(written).toEqual({
      defaultProvider: 'openai',
      providers: {
        glm: { model: 'glm-5.2', apiKey: 'glm-key' },
        openai: { model: 'gpt-5.4' },
      },
      roles: { evaluator: { provider: 'glm', model: 'glm-5.2' } },
      fallbacks: { evaluator: ['minimax'] },
      capabilities: { 'glm-5.2': { vision: true } },
    });
  });
});

// ===========================================================================
// updateConfig
// ===========================================================================

describe('updateConfig', () => {
  const configPath = '/tmp/update-config.json';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockImplementation(async () => {});
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFileAtomic.mockResolvedValue(undefined);
  });

  function writtenConfig(): Record<string, unknown> {
    expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    return JSON.parse(mockWriteFileAtomic.mock.calls[0][1] as string);
  }

  it('merges a partial provider update preserving roles, other providers, and unknown keys', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      defaultProvider: 'glm',
      providers: {
        glm: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.1', apiKey: 'glm-key' },
      },
      roles: {
        generator: { provider: 'glm', model: 'glm-5.1' },
        evaluator: { provider: 'openrouter', model: 'google/gemini-2.5-flash', apiKey: 'vision-key' },
      },
      fallbacks: { evaluator: ['glm', 'minimax'] },
      capabilities: { vision: true },
    }));

    const result = await updateConfig({
      providers: { anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' } },
    }, configPath);

    expect(result.isOk()).toBe(true);
    const written = writtenConfig() as {
      providers: Record<string, { model?: string; apiKey?: string }>;
      roles: Record<string, { model?: string }>;
      fallbacks: unknown;
      capabilities: unknown;
    };
    // New provider merged in
    expect(written.providers.anthropic.model).toBe('claude-sonnet-4-6');
    // Existing provider, roles, fallbacks, and capability keys preserved
    expect(written.providers.glm.apiKey).toBe('glm-key');
    expect(written.roles.evaluator.model).toBe('google/gemini-2.5-flash');
    expect(written.fallbacks).toEqual({ evaluator: ['glm', 'minimax'] });
    expect(written.capabilities).toEqual({ vision: true });
  });

  it('recursively merges nested plain-object sections and replaces scalar leaves', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      defaultProvider: 'lmstudio',
      loop: { maxIterations: 10, timeoutMinutes: 30 },
    }));

    const result = await updateConfig({ loop: { maxIterations: 20 } }, configPath);

    expect(result.isOk()).toBe(true);
    const written = writtenConfig() as { loop: { maxIterations: number; timeoutMinutes: number } };
    expect(written.loop).toEqual({ maxIterations: 20, timeoutMinutes: 30 });
  });

  it('replaces array leaves wholesale instead of concatenating', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      fallbacks: { evaluator: ['glm', 'minimax'] },
    }));

    const result = await updateConfig({ fallbacks: { evaluator: ['anthropic'] } } as never, configPath);

    expect(result.isOk()).toBe(true);
    const written = writtenConfig() as { fallbacks: { evaluator: string[] } };
    expect(written.fallbacks.evaluator).toEqual(['anthropic']);
  });

  it('writes the merged config atomically with mode 0600', async () => {
    mockReadFile.mockResolvedValue('{}');

    await updateConfig({ defaultProvider: 'anthropic' }, configPath);

    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(mockWriteFileAtomic).toHaveBeenCalledWith(
      configPath,
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it('starts from an empty config when the file does not exist', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    const result = await updateConfig({ defaultProvider: 'anthropic' }, configPath);

    expect(result.isOk()).toBe(true);
    expect(writtenConfig()).toEqual({ defaultProvider: 'anthropic' });
  });

  it.each([null, [1, 2], 'not-an-object', 42] as const)(
    'rejects unsafe/non-object update root %j without writing',
    async (root) => {
      const result = await updateConfig(root as never, configPath);

      expect(result.isErr()).toBe(true);
      expect(mockWriteFileAtomic).not.toHaveBeenCalled();
    },
  );

  it('rejects an update whose merged result fails validation without touching the file', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      defaultProvider: 'glm',
      roles: { generator: { provider: 'glm', model: 'glm-5.1' } },
    }));

    const result = await updateConfig({ providers: 'not-an-object' } as never, configPath);

    expect(result.isErr()).toBe(true);
    expect(mockWriteFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses to clobber a corrupt existing config file', async () => {
    mockReadFile.mockResolvedValue('not valid json {{{');

    const result = await updateConfig({ defaultProvider: 'anthropic' }, configPath);

    expect(result.isErr()).toBe(true);
    expect(mockWriteFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses to clobber an existing file whose root is not a plain object', async () => {
    mockReadFile.mockResolvedValue('[1, 2, 3]');

    const result = await updateConfig({ defaultProvider: 'anthropic' }, configPath);

    expect(result.isErr()).toBe(true);
    expect(mockWriteFileAtomic).not.toHaveBeenCalled();
  });

  it('ignores prototype-pollution keys in the update', async () => {
    mockReadFile.mockResolvedValue('{}');
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "defaultProvider": "glm"}');

    const result = await updateConfig(malicious, configPath);

    expect(result.isOk()).toBe(true);
    const written = writtenConfig();
    expect(written).toEqual({ defaultProvider: 'glm' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ===========================================================================
// loadProjectConfig
// ===========================================================================

describe('loadProjectConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockReset();
    mockStat.mockReset();
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  it('loads project config from directory', async () => {
    const configJson = JSON.stringify({
      name: 'test-project',
      llm: { provider: 'ollama', model: 'qwen:7b' },
    });
    mockReadFile.mockResolvedValue(configJson);

    const result = await loadProjectConfig('/project/dir');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        name: 'test-project',
        llm: { provider: 'ollama', model: 'qwen:7b' },
      });
    }
  });

  it('loads project config from file path directly', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    const configJson = JSON.stringify({ name: 'direct-path-test' });
    mockReadFile.mockResolvedValue(configJson);
    const result = await loadProjectConfig('/path/to/liminal.json');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ name: 'direct-path-test' });
    }
  });

  it('returns Err when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadProjectConfig('/nonexistent/dir');
    expect(result.isErr()).toBe(true);
  });

  it('falls back to legacy atelier.json filename', async () => {
    const legacyJson = JSON.stringify({ name: 'legacy-project' });
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(legacyJson);
    const result = await loadProjectConfig('/project/dir');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ name: 'legacy-project' });
    }
  });

  it('returns Err when both config files fail', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadProjectConfig('/project/dir');
    expect(result.isErr()).toBe(true);
  });

  it('logs missing project config files at debug level without raw stack warnings', async () => {
    const enoent = Object.assign(new Error('missing file'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);

    const result = await loadProjectConfig('/fresh/dir');

    expect(result.isErr()).toBe(true);
    expect(Logger.warn).not.toHaveBeenCalled();
    expect(Logger.debug).toHaveBeenCalledWith(
      'ConfigLoader',
      expect.stringContaining('No project config found'),
    );
  });
});

// ===========================================================================
// getEffectiveConfig
// ===========================================================================

describe('getEffectiveConfig', () => {
  const envVarsToClean = [
    'LIMINAL_LLM_PROVIDER',
    'LIMINAL_LLM_BASE_URL',
    'LIMINAL_LLM_MODEL',
    'LIMINAL_LLM_API_KEY',
    'OPENAI_API_KEY',
    'MINIMAX_API_KEY',
    'GLM_API_KEY',
    'OPENROUTER_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ];

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of envVarsToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockReadFile.mockResolvedValue('{}');
    mockAccess.mockImplementation(async () => {});
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  afterEach(() => {
    for (const key of envVarsToClean) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    // Clean up API key env vars that tests may set
    delete process.env.GLM_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns defaults when no env vars and no file config', async () => {
    const config = await getEffectiveConfig();
    expect(config.model).toBe('auto');
    expect(config.provider).toBe('lmstudio');
  });

  it('uses file config for model and base URL', async () => {
    const fileConfig = JSON.stringify({
      defaultProvider: 'custom',
      providers: {
        custom: {
          baseUrl: 'http://file-url',
          model: 'file-model',
          apiKey: 'file-key',
        },
      },
    });
    mockReadFile.mockResolvedValue(fileConfig);

    const config = await getEffectiveConfig();
    expect(config.model).toBe('file-model');
    expect(config.baseUrl).toBe('http://file-url');
    expect(config.apiKey).toBe('file-key');
  });

  it('ignores placeholder test-provider config leaked into user config', async () => {
    const fileConfig = JSON.stringify({
      defaultProvider: 'test-provider',
      providers: {
        'test-provider': {
          baseUrl: 'https://api.test.com/v1',
          model: 'test-model',
          apiKey: 'test-key-12345',
        },
      },
    });
    mockReadFile.mockResolvedValue(fileConfig);

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('lmstudio');
    expect(config.model).toBe('auto');
    expect(config.baseUrl).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
  });

  it('uses MiniMax cloud defaults when only MINIMAX_API_KEY is available', async () => {
    process.env.MINIMAX_API_KEY = 'real-minimax-key';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('minimax');
    expect(config.model).toBe('MiniMax-M3'); // owner rule: MiniMax-M3 is the only allowed MiniMax
    expect(config.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(config.apiKey).toBe('real-minimax-key');
  });

  it('uses project config when no file config overrides', async () => {
    const projectJson = JSON.stringify({
      llm: { baseUrl: 'http://project-url', model: 'project-model', apiKey: 'project-key' },
    });
    mockReadFile
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(projectJson);

    const config = await getEffectiveConfig(undefined, '/project/dir');
    expect(config.model).toBe('project-model');
    expect(config.baseUrl).toBe('http://project-url');
    expect(config.apiKey).toBe('project-key');
  });

  it('env vars take precedence over file config', async () => {
    process.env.LIMINAL_LLM_MODEL = 'env-model';
    process.env.LIMINAL_LLM_API_KEY = 'env-key';
    process.env.LIMINAL_LLM_BASE_URL = 'http://explicit-env-route/v1';

    const fileConfig = JSON.stringify({
      defaultProvider: 'file-provider',
      providers: { 'file-provider': { model: 'file-model' } },
    });
    const projectJson = JSON.stringify({
      llm: { model: 'project-model', baseUrl: 'http://project-url' },
    });
    mockReadFile
      .mockResolvedValueOnce(fileConfig)
      .mockResolvedValueOnce(projectJson);

    const config = await getEffectiveConfig(undefined, '/project/dir');
    expect(config.model).toBe('env-model');
    expect(config.apiKey).toBe('env-key');
    expect(config.baseUrl).toBe('http://explicit-env-route/v1');
  });

  it('does not send a saved or shell bearer to a path chosen by the project', async () => {
    process.env.LIMINAL_LLM_API_KEY = 'ambient-test-marker';
    process.env.OPENAI_API_KEY = 'vendor-test-marker';
    const baseUrl = 'https://project-route.invalid/v1';
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ defaultProvider: 'openai',
      providers: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'saved-test-marker' } },
    })).mockResolvedValueOnce(JSON.stringify({ llm: { baseUrl, model: 'gpt-5.4' } }));

    const config = await getEffectiveConfig(undefined, '/project/dir');
    expect(config.baseUrl).toBe(baseUrl);
    expect(config.apiKey).toBeUndefined();
  });

  it('maps legacy provider name inception to lmstudio', async () => {
    process.env.LIMINAL_LLM_PROVIDER = 'inception';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('lmstudio');
  });

  it('resolves anthropic as a first-class provider (the product default)', async () => {
    process.env.LIMINAL_LLM_PROVIDER = 'anthropic';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('anthropic');
  });

  it('detects ANTHROPIC_API_KEY alone and routes every role to the Claude API', async () => {
    // The product on-ramp: a fresh user sets only ANTHROPIC_API_KEY (no config,
    // no provider env) and generation targets the Anthropic Messages API.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-detect';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.apiKey).toBe('sk-ant-detect');
  });

  it('uses OPENAI_API_KEY as fallback when no LLM_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-fallback';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('sk-openai-fallback');
  });

  it('uses MINIMAX_API_KEY as fallback', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax-fallback';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('sk-minimax-fallback');
  });

  it('prefers LLM_API_KEY over OPENAI_API_KEY', async () => {
    process.env.LIMINAL_LLM_API_KEY = 'llm-key';
    process.env.OPENAI_API_KEY = 'openai-key';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('llm-key');
  });

  it('uses env base URL when set', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://env-url:8080';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.baseUrl).toBe('http://env-url:8080');
  });

  it('uses ollama provider when configured via env', async () => {
    process.env.LIMINAL_LLM_PROVIDER = 'ollama';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('ollama');
  });

  it('uses minimax provider when configured via env', async () => {
    process.env.LIMINAL_LLM_PROVIDER = 'minimax';
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.provider).toBe('minimax');
  });

  it('uses GLM_API_KEY as fallback when no LLM_API_KEY', async () => {
    process.env.GLM_API_KEY = 'sk-glm-fallback';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('sk-glm-fallback');
  });

  it('uses MOONSHOT_API_KEY as fallback', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-fallback';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('sk-moonshot-fallback');
  });

  it('prefers env vars in correct priority order for api keys', async () => {
    process.env.LIMINAL_LLM_API_KEY = 'llm-primary';
    process.env.OPENAI_API_KEY = 'openai-secondary';
    process.env.GLM_API_KEY = 'glm-tertiary';

    const config = await getEffectiveConfig();
    expect(config.apiKey).toBe('llm-primary');
  });

  it('returns undefined baseUrl when no config source provides one', async () => {
    mockReadFile.mockResolvedValue('{}');

    const config = await getEffectiveConfig();
    expect(config.baseUrl).toBeUndefined();
  });
});

// ===========================================================================
// Migration tests
// ===========================================================================

describe('migrateLegacyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still loads the config when the old folder could not be moved', async () => {
    mockMigrateConfigHome.mockReturnValue('failed');
    mockReadFile.mockResolvedValue(JSON.stringify({ defaultProvider: 'lmstudio', providers: {} }));

    const result = await loadConfig('/test/config.json');

    expect(result.isOk() && result.value).toEqual({ defaultProvider: 'lmstudio', providers: {} });
    expect(Logger.warn).toHaveBeenCalledWith(
      'ConfigLoader',
      'Could not move the old config home to ~/.sinter; it was left in place',
    );
  });
});

// ===========================================================================
// Error handling edge cases
// ===========================================================================

describe('loadProjectConfig edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockReset();
    mockStat.mockReset();
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  it('returns Err for invalid JSON structure in liminal.json', async () => {
    mockReadFile.mockResolvedValue('{"invalid json');
    const result = await loadProjectConfig('/project/dir');
    expect(result.isErr()).toBe(true);
  });

  it('returns Err when liminal.json exists but has parse error', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('SyntaxError'));
    const result = await loadProjectConfig('/project/dir');
    expect(result.isErr()).toBe(true);
  });

  it('falls back to atelier.json when liminal.json does not exist', async () => {
    const legacyConfig = JSON.stringify({ name: 'legacy-project' });
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))  // liminal.json not found
      .mockResolvedValueOnce(legacyConfig);        // atelier.json found

    const result = await loadProjectConfig('/project/dir');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.name).toBe('legacy-project');
    }
  });

  it('handles direct file path (non-directory)', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false });
    const configJson = JSON.stringify({ name: 'direct-file' });
    mockReadFile.mockResolvedValue(configJson);

    const result = await loadProjectConfig('/path/to/custom-config.json');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.name).toBe('direct-file');
    }
  });
});

// ===========================================================================
// Provider mapping edge cases
// ===========================================================================

describe('getEffectiveConfig provider mappings', () => {
  let savedEnv: Record<string, string | undefined>;
  const envVarsToClean = [
    'LIMINAL_LLM_PROVIDER',
    'LIMINAL_LLM_BASE_URL',
    'LIMINAL_LLM_MODEL',
    'LIMINAL_LLM_API_KEY',
    'OPENAI_API_KEY',
    'MINIMAX_API_KEY',
    'GLM_API_KEY',
    'OPENROUTER_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ];

  beforeEach(() => {
    savedEnv = {};
    for (const key of envVarsToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockReadFile.mockResolvedValue('{}');
    mockAccess.mockImplementation(async () => {});
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  afterEach(() => {
    for (const key of envVarsToClean) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('maps unknown provider names to lmstudio default', async () => {
    process.env.LIMINAL_LLM_PROVIDER = 'unknown-provider';
    const config = await getEffectiveConfig();
    expect(config.provider).toBe('lmstudio');
  });

  it.each(['glm', 'openrouter', 'moonshot', 'kimi', 'custom'] as const)(
    'preserves named provider %s',
    async (providerName) => {
      process.env.LIMINAL_LLM_PROVIDER = providerName;
      const config = await getEffectiveConfig();
      expect(config.provider).toBe(providerName);
    },
  );

  it('uses lmstudio as default when no provider specified', async () => {
    const config = await getEffectiveConfig();
    expect(config.provider).toBe('lmstudio');
  });
});
