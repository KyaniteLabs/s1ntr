import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { env } from '../utils/env.js';
import { Logger } from '../utils/Logger.js';
import { SERVICE_DEFAULTS } from '../constants/index.js';
import {
  PROVIDER_DEFAULTS,
  firstUsableApiKey,
  isPlaceholderApiKey,
  isRuntimeProviderKey,
  resolveProviderAlias,
  sameProviderEndpoint,
  selectRuntimeApiKey,
  type RuntimeProviderKey,
} from './ProviderRuntime.js';
import { loadRoleConfig } from './RoleConfig.js';
import type { ModelRole, ResolvedRoleConfig, RoleProviderConfig } from './RoleConfig.js';
import { Result, ok, err as reject } from 'neverthrow';
import { PersistenceError } from '../errors/PersistenceError.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { withFileLock } from '../utils/fileLock.js';
import { migrateConfigHome } from './migrateConfigHome.js';

/** Routing mode for multi-model generation */
export type RoutingMode = 'cascade' | 'speculative' | 'ensemble' | 'specialized' | 'thompson';

export interface UserConfig {
  defaultProvider: string;
  providers: {
    [key: string]: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };
  };
  /** Optional role-specific model configuration for generator/evaluator/harness. */
  roles?: Partial<Record<ModelRole, RoleProviderConfig>>;
  /** Optional loop options (GUI / user prefs) */
  loop?: {
    maxIterations?: number;
    timeoutMinutes?: number;
  };
  /** Optional creative options */
  creative?: {
    minQualityScore?: number;
  };
  /** Optional gallery directory name (e.g. "gallery") */
  galleryPath?: string;
}

/** Project config shape (config/sinter.json) */
export interface ProjectConfig {
  name?: string;
  version?: string;
  loop?: {
    maxIterations?: number;
    timeoutMinutes?: number;
    completionPromise?: string;
  };
  llm?: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    localFallback?: boolean;
  };
  /** Dual-model configuration for cascade/specialized routing */
  multiModel?: {
    /** Primary/fast model configuration */
    primary?: {
      provider?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      timeout?: number;
    };
    /** Secondary/powerful model configuration */
    secondary?: {
      provider?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    };
    /** Routing configuration */
    routing?: {
      mode?: RoutingMode;
      confidenceThreshold?: number;
      primaryConcurrency?: number;
      secondaryConcurrency?: number;
    };
  };
  creative?: {
    defaultFramework?: string;
    evaluationCriteria?: string[];
    minQualityScore?: number;
  };
  gallery?: {
    autoSave?: boolean;
    maxHistoryPerProject?: number;
  };
  renderer?: {
    port?: number;
    screenshotOnIteration?: boolean;
  };
  swarm?: {
    ollamaHost?: string;
    maxRounds?: number;
    mode?: 'competitive' | 'hybrid' | 'ring' | 'mesh';
    streamDir?: string;
    /** Durable gold-label ledger shared by library swarm runs. */
    calibrationLedgerPath?: string;
  };
  scavenger?: {
    scanPaths?: string[];
    outputDir?: string;
    autoRegister?: boolean;
  };
  compost?: {
    heapDir?: string;
    maxHeapSizeBytes?: number;
    digestDir?: string;
    seedDir?: string;
    digestSchedule?: 'manual' | 'daily' | 'weekly';
    soupEnabled?: boolean;
    soupPopulationSize?: number;
    soupMaxStepsPerCycle?: number;
    seedPromotionThreshold?: number;
    nuggetRetentionDays?: number;
  };
  collab?: {
    mode?: 'swarm' | 'phases' | 'simple';
    maxRounds?: number;
    convergenceThreshold?: number;
    domain?: string;
  };
  evolution?: {
    useMapElites?: boolean;
    mapElitesDims?: [number, number];
    useAestheticModel?: boolean;
    stagnationThreshold?: number;
    useArchiveLearning?: boolean;
  };
  /** Intuition system — compressed-experience-based quality signals. */
  intuition?: {
    /** Enable intuition scoring dimension (additive, not replacing). */
    enabled?: boolean;
    /** Minimum prototype examples before intuition activates per domain. Default: 3. */
    minPrototypeExamples?: number;
    /** Weight for prototype distance signal. Default: 0.4. */
    prototypeWeight?: number;
    /** Weight for novelty signal. Default: 0.3. */
    noveltyWeight?: number;
    /** Weight for Thompson confidence signal. Default: 0.3. */
    thompsonWeight?: number;
    /** Score threshold for Thompson success updates. Default: 0.7. */
    successThreshold?: number;
  };
  /** Product mode configuration for Studio sessions. */
  mode?: {
    /** Default mode for new sessions. Default: 'ask' */
    defaultMode?: 'ask' | 'make' | 'remix' | 'improve';
    /** Default autonomy level. Default: 'assist' */
    defaultAutonomy?: 'assist' | 'co-create' | 'autopilot';
    /** Default workspace profile. Default: 'creative' */
    defaultProfile?: 'creative' | 'engineering' | 'hybrid';
  };
}

export interface EffectiveConfig {
  /** @deprecated Provider is no longer used - baseUrl determines the endpoint */
  provider?: 'ollama' | 'openai' | 'anthropic' | 'minimax' | 'lmstudio' | 'hybrid' | 'glm' | 'openrouter' | 'moonshot' | 'kimi' | 'kilo' | 'custom';
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

/** Individual model configuration */
export interface ModelConfig {
  /** @deprecated Provider is no longer used - baseUrl determines the endpoint */
  provider?: 'ollama' | 'openai' | 'minimax' | 'lmstudio';
  baseUrl?: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Type guard for ProjectConfig */
function isValidProjectConfig(value: unknown): value is ProjectConfig {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;

  // Basic structure validation - allow empty object as valid minimal config
  return true;
}

/** Type guard for UserConfig */
function isValidUserConfig(value: unknown): value is UserConfig {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  
  // Must have providers object if present
  if (obj.providers !== undefined) {
    if (typeof obj.providers !== 'object' || obj.providers === null || Array.isArray(obj.providers)) return false;
  }
  
  // defaultProvider must be string if present
  if (obj.defaultProvider !== undefined && typeof obj.defaultProvider !== 'string') {
    return false;
  }
  
  return true;
}

/** Multi-model router configuration */
export interface MultiModelConfig {
  /** Primary/fast model (e.g., Qwen3.5-9B for speed) */
  primary: ModelConfig;
  /** Secondary/powerful model (e.g., Qwen3-30B-A3B for reasoning) */
  secondary?: ModelConfig;
  /** How to route requests between models */
  routing: {
    mode: RoutingMode;
    /** Confidence threshold for cascade escalation (0-1) */
    confidenceThreshold?: number;
    /** Maximum concurrent requests for primary model */
    primaryConcurrency?: number;
    /** Maximum concurrent requests for secondary model */
    secondaryConcurrency?: number;
  };
}

const LIMINAL_CONFIG_DIR = '.sinter';
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), LIMINAL_CONFIG_DIR, 'config.json');

const PROJECT_CONFIG_FILENAME = 'sinter.json';
/** Legacy project-config filenames tried in order when sinter.json is absent. */
const LEGACY_PROJECT_CONFIG_FILENAMES = ['liminal.json', 'atelier.json'] as const;

/**
 * Migrate a legacy config home (~/.liminal, then ~/.atelier) to ~/.sinter once.
 * Shares migrateConfigHome with the CLI, so Studio and library callers also carry
 * the WHOLE directory (config, keys, memory, gallery, …) when the move has to
 * fall back to a copy. Never deletes data on failure.
 */
function migrateLegacyConfig(): void {
  const outcome = migrateConfigHome(os.homedir(), []);
  if (outcome === 'moved' || outcome === 'copied') {
    Logger.info('ConfigLoader', `Migrated the old config home to ~/${LIMINAL_CONFIG_DIR} (${outcome})`);
  } else if (outcome === 'failed') {
    Logger.warn('ConfigLoader', `Could not move the old config home to ~/${LIMINAL_CONFIG_DIR}; it was left in place`);
  }
}

/**
 * Load project config from config/sinter.json in the given directory (or path to file).
 * Falls back to config/atelier.json for backward compatibility.
 * @param configDirOrPath - Directory containing config/sinter.json (e.g. cwd), or path to file
 * @returns Result with Project config or PersistenceError
 */
export async function loadProjectConfig(configDirOrPath?: string): Promise<Result<ProjectConfig, PersistenceError>> {
  let projectConfigPath: string;
  if (!configDirOrPath) {
    projectConfigPath = path.join(process.cwd(), 'config', PROJECT_CONFIG_FILENAME);
  } else {
    const stat = await fs.stat(configDirOrPath).catch(() => null);
    if (stat?.isDirectory()) {
      projectConfigPath = path.join(configDirOrPath, 'config', PROJECT_CONFIG_FILENAME);
    } else {
      projectConfigPath = configDirOrPath;
    }
  }
  try {
    const content = await fs.readFile(projectConfigPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidProjectConfig(parsed)) {
      Logger.warn('ConfigLoader', `Invalid project config structure at ${projectConfigPath}`);
      return reject(new PersistenceError('Invalid project config structure', { retryable: false }));
    }
    return ok(parsed);
  } catch (readError) {
    if (!isEnoent(readError)) {
      Logger.warn('ConfigLoader', `Failed to load project config ${projectConfigPath}:`, readError);
      return reject(new PersistenceError('Failed to load project config', {
        cause: readError instanceof Error ? readError : new Error(String(readError)),
        retryable: false,
      }));
    }
    // Fallback: try legacy project-config filenames (liminal.json, atelier.json) in order.
    let lastError: unknown = readError;
    for (const legacyName of LEGACY_PROJECT_CONFIG_FILENAMES) {
      const legacyPath = projectConfigPath.replace(/[^/\\]+$/, legacyName);
      if (legacyPath === projectConfigPath) continue;
      try {
        const content = await fs.readFile(legacyPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        if (!isValidProjectConfig(parsed)) {
          Logger.warn('ConfigLoader', `Invalid legacy project config structure at ${legacyPath}`);
          return reject(new PersistenceError('Invalid legacy project config structure', { retryable: false }));
        }
        return ok(parsed);
      } catch (error) {
        if (!isEnoent(error)) {
          Logger.warn('ConfigLoader', `Failed to load legacy config ${legacyPath}:`, error);
          return reject(new PersistenceError('Failed to load project config', {
            cause: error instanceof Error ? error : new Error(String(error)),
            retryable: false,
          }));
        }
        lastError = error;
      }
    }
    Logger.debug('ConfigLoader', `No project config found at ${projectConfigPath} or legacy names — using defaults`);
    return reject(new PersistenceError('Failed to load project config', {
      cause: lastError instanceof Error ? lastError : new Error(String(lastError)),
      retryable: false,
      context: { reason: 'missing-project-config' },
    }));
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    || (error instanceof Error && error.message.includes('ENOENT'));
}

/**
 * Load config from JSON file
 * @param configPath Path to config file (defaults to ~/.sinter/config.json)
 * @returns Result with UserConfig or PersistenceError
 */
export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<Result<UserConfig, PersistenceError>> {
  // Run migration on first load
  migrateLegacyConfig();

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (!isValidUserConfig(parsed)) {
      return reject(new PersistenceError('Invalid user config structure', { retryable: false }));
    }
    return ok(parsed);
  } catch (error) {
    // A missing config file is the normal first-run state (the CLI falls back to
    // env vars / defaults), not an error — log it quietly so a fresh user's very
    // first command doesn't dump a Node stack trace. Anything else (malformed
    // JSON, permissions) is a real problem worth a warning.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      Logger.debug('ConfigLoader', `No config file at ${configPath} — using env vars / defaults`);
    } else {
      Logger.warn('ConfigLoader', `Failed to load config ${configPath}:`, error);
    }
    return reject(new PersistenceError('Failed to load config', {
      cause: error instanceof Error ? error : new Error(String(error)),
      retryable: false,
    }));
  }
}

/**
 * Compatibility entry point for callers that provide a full UserConfig.
 * Delegates to the canonical deep-merging writer so older callers cannot
 * clobber role, fallback, capability, or forward-compatible sections.
 * @param config Config object to save
 * @param configPath Path to config file (defaults to ~/.sinter/config.json)
 */
export async function saveConfig(config: UserConfig, configPath: string = DEFAULT_CONFIG_PATH): Promise<void> {
  const result = await updateConfig(config as unknown as Partial<UserConfig> & Record<string, unknown>, configPath);
  if (result.isErr()) throw result.error;
}

/** Keys that must never be merged — prototype-pollution vectors. */
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively merge `update` into `base`: plain-object sections merge key by key,
 * scalar/array leaves are replaced wholesale. Keys only present in `base`
 * (including unknown forward-compatible ones) are preserved.
 */
function deepMergeConfig(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(update)) {
    if (UNSAFE_CONFIG_KEYS.has(key)) continue;
    const incoming = update[key];
    const existing = merged[key];
    if (isPlainObject(incoming)) {
      merged[key] = deepMergeConfig(isPlainObject(existing) ? existing : {}, incoming);
    } else {
      merged[key] = incoming;
    }
  }
  return merged;
}

/**
 * Deep-merge a partial update into the user config and persist it atomically.
 *
 * This is the single write contract for configuration updates (CLI --configure,
 * GUI /api/config): load the current object, merge plain-object sections
 * recursively, replace scalar/array leaves, preserve unknown forward-compatible
 * keys, validate the result, then write atomically with mode 0600. A missing
 * file starts from an empty config; a corrupt existing file or an update that
 * fails validation returns an error WITHOUT touching the previous file.
 *
 * @param update Partial config to merge in (must be a plain object)
 * @param configPath Path to config file (defaults to ~/.sinter/config.json)
 * @returns Result with the merged UserConfig or PersistenceError
 */
export async function updateConfig(
  update: Partial<UserConfig> & Record<string, unknown>,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<Result<UserConfig, PersistenceError>> {
  if (!isPlainObject(update)) {
    return reject(new PersistenceError('Invalid config update: expected a plain object', { retryable: false }));
  }

  migrateLegacyConfig();

  // F20: serialize the read-merge-write across callers and processes (CLI --configure, GUI /api/config).
  // Atomic rename prevents torn JSON but not last-writer loss; the lock spans the whole transaction.
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  return withFileLock(`${configPath}.lock`, async (): Promise<Result<UserConfig, PersistenceError>> => {
    let current: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!isPlainObject(parsed)) {
        return reject(new PersistenceError('Invalid user config structure', { retryable: false }));
      }
      current = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Corrupt JSON or unreadable file: refuse to overwrite — the previous
        // (possibly recoverable) file must not be clobbered by a partial update.
        Logger.warn('ConfigLoader', `Refusing to update config ${configPath}: existing file could not be read`);
        return reject(new PersistenceError('Failed to load config for update', {
          cause: error instanceof Error ? error : new Error(String(error)),
          retryable: false,
        }));
      }
      // ENOENT: first run — merge onto an empty config.
    }

    const merged = deepMergeConfig(current, update);
    if (!isValidUserConfig(merged)) {
      return reject(new PersistenceError('Invalid config update: merged config fails validation', { retryable: false }));
    }

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return ok(merged as UserConfig);
  });
}

/**
 * Get effective configuration by merging project config (optional), file config, and env vars.
 * Env vars take precedence over file config; project config overrides user file for overlapping keys.
 * @param projectConfigPath - Optional directory or path to load config/sinter.json from
 */
export async function getEffectiveConfig(configPath?: string, projectConfigPath?: string): Promise<EffectiveConfig> {
  const fileConfigResult = configPath ? await loadConfig(configPath) : await loadConfig();
  const fileConfig = fileConfigResult.match(
    (config) => config,
    // loadConfig already logs the meaningful case (malformed config) at warn and
    // the expected missing-file case at debug; keep this fallback quiet to avoid
    // a duplicate first-run warning.
    (error) => {
      Logger.debug('ConfigLoader', `Config load failed, using defaults: ${error.message}`);
      return null;
    },
  );
  const projectConfigResult = projectConfigPath ? await loadProjectConfig(projectConfigPath) : null;
  const projectConfig = projectConfigResult?.match(
    (config) => config,
    (error) => {
      if (error.context?.reason === 'missing-project-config') {
        Logger.debug('ConfigLoader', `Project config load skipped: ${error.message}`);
      } else {
        Logger.warn('ConfigLoader', `Project config load failed: ${error.message}`);
      }
      return null;
    },
  ) ?? null;

  // Provider: env > project llm > user file > available cloud key > local default
  const projectProvider = projectConfig?.llm?.provider;
  const fileProviderName = fileConfig?.defaultProvider;
  const rawFileProviderConfig = fileProviderName ? fileConfig?.providers?.[fileProviderName] || {} : {};
  const usableFileProviderName = fileProviderName && !isPlaceholderProviderConfig(fileProviderName, rawFileProviderConfig)
    ? fileProviderName
    : undefined;
  const keyedProvider = providerFromAvailableApiKey();
  const rawProviderName = env('LLM_PROVIDER') || projectProvider || usableFileProviderName || keyedProvider || 'lmstudio';
  const provider = effectiveProviderName(rawProviderName);
  const runtimeProvider = runtimeProviderForEffective(provider);
  const hasProviderSignal = Boolean(env('LLM_PROVIDER') || projectProvider || usableFileProviderName || keyedProvider);

  const rawFileProviderConfigForProvider = fileConfig?.providers?.[rawProviderName] || fileConfig?.providers?.[provider] || {};
  const fileProviderConfig = isPlaceholderProviderConfig(rawProviderName, rawFileProviderConfigForProvider)
    ? {}
    : rawFileProviderConfigForProvider;
  const projectLlm = projectConfig?.llm || {};
  const runtimeDefaults = runtimeProvider && hasProviderSignal ? PROVIDER_DEFAULTS[runtimeProvider] : undefined;
  const envBaseUrl = env('LLM_BASE_URL');
  const fileBaseUrl = fileProviderConfig.baseUrl || runtimeDefaults?.baseUrl;
  const projectBaseUrl = projectLlm.baseUrl ?? fileBaseUrl;
  const baseUrl = envBaseUrl || projectBaseUrl || runtimeDefaults?.baseUrl;
  const model = env('LLM_MODEL') || projectLlm.model || fileProviderConfig.model || runtimeDefaults?.model || SERVICE_DEFAULTS.DEFAULT_MODEL;
  const matchesSavedRoute = baseUrl === fileBaseUrl || sameProviderEndpoint(baseUrl, fileBaseUrl);
  const projectChangesRoute = (projectLlm.baseUrl !== undefined && !matchesSavedRoute)
    || Boolean(projectProvider && projectProvider !== usableFileProviderName);
  const projectKey = !envBaseUrl || sameProviderEndpoint(envBaseUrl, projectLlm.baseUrl)
    ? projectLlm.apiKey : undefined;
  const configuredApiKey = firstUsableApiKey(projectKey, matchesSavedRoute ? fileProviderConfig.apiKey : undefined);
  if (projectChangesRoute && !envBaseUrl) return { provider, baseUrl, model, apiKey: configuredApiKey };

  const apiKey = selectRuntimeApiKey({
    provider: runtimeProvider, baseUrl: baseUrl ?? '', model, configuredApiKey,
    genericFallbackKeys: ['LLM_API_KEY'], genericFirst: true,
  });
  return { provider, baseUrl, model, apiKey };
}

function effectiveProviderName(providerName: string): NonNullable<EffectiveConfig['provider']> {
  if (providerName === 'hybrid') return 'hybrid';
  if (providerName === 'inception') return 'lmstudio';
  return resolveProviderAlias(providerName) ?? 'lmstudio';
}

function runtimeProviderForEffective(provider: NonNullable<EffectiveConfig['provider']>): RuntimeProviderKey | undefined {
  if (provider === 'hybrid') return undefined;
  return isRuntimeProviderKey(provider) ? provider : undefined;
}

function providerFromAvailableApiKey(): string | undefined {
  // Anthropic first: it is the product default provider, so an ANTHROPIC_API_KEY
  // alone (no config file) routes every role to the Claude Messages API.
  const keyedProviders: RuntimeProviderKey[] = ['anthropic', 'minimax', 'glm', 'moonshot', 'kimi', 'openrouter', 'openai'];
  return keyedProviders.find((provider) => selectRuntimeApiKey({
    provider,
    baseUrl: PROVIDER_DEFAULTS[provider].baseUrl,
    model: PROVIDER_DEFAULTS[provider].model,
    genericFallbackKeys: [],
  }));
}

function isPlaceholderProviderConfig(
  providerName: string,
  config: { baseUrl?: string; model?: string; apiKey?: string },
): boolean {
  const baseUrl = config.baseUrl?.toLowerCase() ?? '';
  return providerName === 'test-provider'
    || baseUrl === 'https://api.test.com/v1'
    || baseUrl.includes('api.test.com')
    || (config.apiKey !== undefined && isPlaceholderApiKey(config.apiKey));
}

/**
 * Load role-based configuration and apply capability overrides to the registry.
 *
 * This is the unified entry point for callers that want the new three-role
 * config system (generator / evaluator / harness). Internally delegates to
 * `loadRoleConfig()` from RoleConfig which handles file merging, env-var
 * fallbacks, and CapabilityRegistry.override() calls.
 *
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns Resolved config keyed by role, with capability overrides already applied
 */
export async function getEffectiveRoleConfig(
  projectDir?: string,
): Promise<Record<ModelRole, ResolvedRoleConfig>> {
  return loadRoleConfig(projectDir);
}
