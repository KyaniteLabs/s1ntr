/**
 * Generation key preflight (#1592): decide from the resolved generator role
 * whether `sinter generate` can start without an env/saved provider key.
 *
 * The CLI's fallback sniff only sees env keys and defaults to Anthropic, so a
 * keyless local config (every role on Ollama) was refused for a missing
 * Anthropic key. The role the run will actually use is the better witness.
 */

export interface GeneratorRoleView {
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

const LOCAL_SERVER_PROVIDERS = new Set(['ollama', 'lmstudio']);

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** True when the generator role carries its own auth or runs on a keyless local server. */
export function generatorRoleNeedsNoKey(role: GeneratorRoleView | null | undefined): boolean {
  if (!role) return false;
  if (role.apiKey) return true;
  const baseUrl = role.baseUrl ?? '';
  // Subscription CLI seats (cli://command) authenticate through their CLI.
  if (baseUrl.startsWith('cli://')) return true;
  const host = hostOf(baseUrl);
  if (!host) return false;
  if (isLoopback(host)) return true;
  // Ollama Cloud (ollama.com) is a hosted, keyed endpoint even when typed 'ollama'.
  if (host === 'ollama.com' || host.endsWith('.ollama.com')) return false;
  return role.provider !== undefined && LOCAL_SERVER_PROVIDERS.has(role.provider);
}
