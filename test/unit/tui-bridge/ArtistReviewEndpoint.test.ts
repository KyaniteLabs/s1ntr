import { afterEach, describe, expect, it } from 'vitest';
import type { ArtistReviewState } from '../../../src/creative-run/ArtistReviewExperience.js';
import { TuiBridgeServer } from '../../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../../src/tui-bridge/TuiBridgeService.js';

function state(version: number): ArtistReviewState {
  return {
    schema: 'sinter.artist-review-state', schemaVersion: 1, decisionVersion: version,
    stateDigest: `digest-${version}`,
    thesis: { thesisId: 'thesis', intendedExperienceMeaning: 'Calm blue motion',
      perceptualEmotionalArc: [], tensions: [], uncertaintiesAssumptions: [], principles: [] },
    candidates: [], contactSheetHtml: '<html>canonical</html>', playableMedia: [], critics: [],
    intervention: 'contrast: 2 → 8',
    decisions: { preference: 'not-decided', release: 'not-decided', learning: {
      ruleId: 'contrast', scope: 'principle:contrast', value: 8, status: 'not-requested',
      revocable: false, persistenceBoundary: 'in-memory-transaction-only',
      contextVersion: 'context', laterEffect: 'Later effect is unknown.',
    } },
    blockers: [], readiness: { reviewComplete: true, releaseReady: false, learningReady: false },
    details: { packet: 'packet', review: 'review' },
  };
}

describe('artist-review Studio endpoint', () => {
  let server: TuiBridgeServer | undefined;
  afterEach(async () => { if (server) await server.stop(); server = undefined; });

  it('serves and mutates the same canonical state without launching a browser', async () => {
    const service = new TuiBridgeService();
    const session = service.createSession();
    let current = state(0);
    service.registerArtistReview(session.sessionId, {
      state: () => current,
      executeAction: (token) => {
        current = state(1);
        return { accepted: token === 'owner-token', feedback: 'Preference recorded.', state: current };
      },
    });
    server = new TuiBridgeServer(service, { host: '127.0.0.1', port: 0 });
    await server.start();
    const url = `${server.address}/api/tui/session/${session.sessionId}/artist-review`;

    const shown = await fetch(url);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ stateDigest: 'digest-0', decisionVersion: 0 });

    const decided = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'owner-token' }),
    });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({
      accepted: true, feedback: 'Preference recorded.',
      state: { stateDigest: 'digest-1', decisionVersion: 1 },
    });
  });
});
