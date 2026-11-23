/**
 * `sinter provider status` must name the route Generate will really use (Sol F07): the resolved generator seat,
 * not the static catalog URL of whatever `defaultProvider` says.
 */
export interface SeatLike { readonly baseUrl?: string; readonly model?: string }
export interface CatalogEntry { readonly name: string; readonly baseUrl?: string }

export interface StatusRoute {
  /** Catalog provider the seat's endpoint belongs to; undefined for a custom endpoint (no catalog row is marked active). */
  readonly activeName: string | undefined;
  /** Endpoint to probe for the active provider: the seat's own URL when it has one. */
  readonly probeUrl: string | undefined;
  readonly seatLine: string | null;
  /** Set when the saved default provider does not match the seat Generate will actually use. */
  readonly mismatchNote: string | null;
}

const norm = (u: string) => u.toLowerCase().replace(/\/+$/, '');

export function resolveStatusRoute(seat: SeatLike | null | undefined, defaultProvider: string | undefined, catalog: readonly CatalogEntry[]): StatusRoute {
  const seatUrl = seat?.baseUrl?.trim();
  if (!seatUrl) return { activeName: defaultProvider, probeUrl: undefined, seatLine: null, mismatchNote: null };
  const match = catalog.find((c) => c.baseUrl && norm(seatUrl).startsWith(norm(c.baseUrl)));
  const exact = catalog.find((c) => c.baseUrl && norm(c.baseUrl) === norm(seatUrl));
  const seatName = (exact ?? match)?.name;
  const seatLine = `Generator seat: ${seat?.model ?? 'unknown model'} at ${seatUrl}`;
  const mismatchNote = defaultProvider && seatName !== defaultProvider
    ? `Note: the saved default provider is ${defaultProvider}, but Generate uses the pinned generator seat above${seatName ? ` (${seatName})` : ''}. Changing the default does not move a pinned seat.`
    : null;
  return { activeName: seatName, probeUrl: seatUrl, seatLine, mismatchNote };
}
