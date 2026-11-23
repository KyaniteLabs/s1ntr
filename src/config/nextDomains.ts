/**
 * Next-release art domains, behind a flag that is OFF by default.
 *
 * Merging a next domain changes nothing in the current release: it is not routed, not offered by
 * the registry, not rendered and not counted until SINTER_NEXT_DOMAINS enables it.
 *   SINTER_NEXT_DOMAINS=1                -> every next domain
 *   SINTER_NEXT_DOMAINS=datamosh,ambient -> only the named ones
 * Each domain PR appends its id here; the ids are NOT members of the `Domain` enum on purpose, so
 * the release domain count and every `Object.values(Domain)` consumer stay untouched.
 */
export const NEXT_DOMAINS_ENV = 'SINTER_NEXT_DOMAINS';
export const NEXT_DOMAIN_IDS = ['datamosh'] as const;
export type NextDomainId = typeof NEXT_DOMAIN_IDS[number];

type Env = Readonly<Record<string, string | undefined>>;

export function isNextDomainId(value: string): value is NextDomainId {
  return (NEXT_DOMAIN_IDS as readonly string[]).includes(value);
}

export function nextDomainActive(id: string, env: Env = process.env): boolean {
  if (!isNextDomainId(id)) return false;
  const raw = (env[NEXT_DOMAINS_ENV] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'all') return true;
  return raw.split(',').map((part) => part.trim()).includes(id);
}

export function activeNextDomains(env: Env = process.env): NextDomainId[] {
  return NEXT_DOMAIN_IDS.filter((id) => nextDomainActive(id, env));
}

export function assertNextDomainEnabled(id: string, env: Env = process.env): void {
  if (!nextDomainActive(id, env)) {
    throw new Error(`NEXT_DOMAIN_DISABLED:${id}: the "${id}" domain ships in the next release; set ${NEXT_DOMAINS_ENV}=1 (or ${NEXT_DOMAINS_ENV}=${id}) to use it`);
  }
}
