/**
 * Studio bearer-token plumbing.
 *
 * When LIMINAL_GUI_TOKEN is set, every state-changing /api call must carry it.
 * The operator opens Studio once with ?token=<token>; it is moved out of the
 * URL into sessionStorage and attached to same-origin /api requests.
 */

const STORAGE_KEY = 'liminalGuiToken';

export interface GuiAuthEnvironment {
  href: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  replaceUrl: (next: string) => void;
  fetch: typeof fetch;
}

export interface GuiAuthResult {
  token: string | null;
  /** href with the token query parameter removed. */
  href: string;
}

/** Read a token from ?token= (preferred) or sessionStorage, stripping it from the URL. */
export function readGuiToken(environment: Pick<GuiAuthEnvironment, 'href' | 'storage' | 'replaceUrl'>): GuiAuthResult {
  const url = new URL(environment.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) {
    environment.storage.setItem(STORAGE_KEY, fromQuery);
    url.searchParams.delete('token');
    environment.replaceUrl(url.toString());
    return { token: fromQuery, href: url.toString() };
  }
  return { token: environment.storage.getItem(STORAGE_KEY), href: environment.href };
}

function isSameOriginApi(input: RequestInfo | URL, origin: string): boolean {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  if (raw.startsWith('/')) return raw.startsWith('/api/');
  try {
    const url = new URL(raw, origin);
    return url.origin === origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function withToken(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** Wrap fetch so same-origin /api requests carry the bearer token, after a session cookie is issued. */
export function installGuiAuth(environment: GuiAuthEnvironment = {
  href: window.location.href,
  storage: window.sessionStorage,
  replaceUrl: (next) => window.history.replaceState({}, '', next),
  fetch: window.fetch.bind(window),
}): () => void {
  const { token } = readGuiToken(environment);
  if (!token) return () => undefined;

  const origin = new URL(environment.href).origin;
  const original = environment.fetch;
  // Trade the token for a session cookie first. Live streams (EventSource) and
  // render iframes cannot carry a header, so they read with the cookie. API
  // calls wait for it, so nothing that opens a stream runs before it is set.
  const session = original(`${origin}/api/auth/session`, withToken({ method: 'POST' }, token))
    .catch(() => undefined);
  const wrapped = ((input: RequestInfo | URL, init: RequestInit = {}) =>
    isSameOriginApi(input, origin)
      ? session.then(() => original(input, withToken(init, token)))
      : original(input, init)) as typeof fetch;
  window.fetch = wrapped;

  return () => { window.fetch = original; };
}
