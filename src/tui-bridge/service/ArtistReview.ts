/**
 * Extracted from TuiBridgeService.ts: artist review sessions, bootstrap grants and host authority.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { ArtistReviewSurface } from '../../cli/ArtistReviewCli.js';
import { type ArtistReviewAction, type ArtistReviewActionResult, type ArtistReviewSession, type ArtistReviewState, createArtistReviewSession } from '../../creative-run/ArtistReviewExperience.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { ArtistReviewBootstrapOptions, AuthenticatedBridgeActor, IssuedBridgeActionCheckpoint } from './bridgeTypes.js';
import { ACTION_CHECKPOINT_TTL_MS, ARTIST_REVIEW_BOOTSTRAP_TTL_MS } from './constants.js';
import { randomBytes } from 'node:crypto';

export function registerArtistReview(host: TuiBridgeService, sessionId: string, surface: ArtistReviewSurface): ArtistReviewState {
    host.getStatus(sessionId);
    host.artistReviews.set(sessionId, surface);
    const state = surface.state();
    host.emit(sessionId, {
      type: 'artist.review_state', sessionId,
      stateDigest: state.stateDigest, decisionVersion: state.decisionVersion,
    });
    return state;
  }

/**
 * Host-only handoff for a coordinator-created revision-comparison session.
 * The bridge retains the exact authenticated object; a caller cannot replace
 * it with a serialized surface or caller-authored review evidence.
 */
export function registerAuthenticArtistReview(host: TuiBridgeService, sessionId: string, review: ArtistReviewSession): ArtistReviewState {
    host.getStatus(sessionId);
    const existing = host.authenticArtistReviews.get(sessionId);
    if (existing && existing !== review) throw new Error('ARTIST_REVIEW_SESSION_IMMUTABLE');
    host.authenticArtistReviews.set(sessionId, review);
    return host.registerArtistReview(sessionId, review);
  }

/** In-process W8 pipeline handoff. HTTP clients receive only the opaque bearer grant. */
export function issueArtistReviewBootstrap(host: TuiBridgeService, options: ArtistReviewBootstrapOptions): string {
    const { promotionReviewerCapability, promotionRenderGate, ...sessionOptions } = options;
    createArtistReviewSession({ ...sessionOptions, sessionId: 'bootstrap-validation' });
    const grant = randomBytes(32).toString('base64url');
    host.artistReviewBootstrapGrants.set(grant, {
      options: sessionOptions,
      ...(promotionReviewerCapability ? { promotionReviewerCapability } : {}),
      ...(promotionRenderGate !== undefined ? { promotionRenderGate } : {}),
      expiresAt: Date.now() + ARTIST_REVIEW_BOOTSTRAP_TTL_MS,
    });
    return grant;
  }

export function claimArtistReviewBootstrap(host: TuiBridgeService, grant: string, sessionId: string): ArtistReviewSession {
    const staged = host.artistReviewBootstrapGrants.get(grant);
    host.artistReviewBootstrapGrants.delete(grant);
    if (!staged || staged.expiresAt <= Date.now()) {
      throw new Error('ARTIST_REVIEW_BOOTSTRAP_GRANT_INVALID');
    }
    const session = createArtistReviewSession({ ...staged.options, sessionId });
    host.authenticArtistReviews.set(sessionId, session);
    if (staged.promotionReviewerCapability) {
      host.promotionReviewers.set(sessionId, staged.promotionReviewerCapability);
    }
    if (staged.promotionRenderGate !== undefined) {
      host.promotionRenderGates.set(sessionId, staged.promotionRenderGate);
    }
    return session;
  }

export function resolveHostActor(host: TuiBridgeService, sessionId: string, credential: string, role: AuthenticatedBridgeActor['role']): AuthenticatedBridgeActor {
    if (!host.hostAuthorityRegistry || !credential.trim()) {
      throw new Error('BRIDGE_HOST_AUTHENTICATION_REQUIRED');
    }
    const actor = host.hostAuthorityRegistry.resolveActor({ sessionId, credential });
    if (!actor || actor.role !== role || !actor.principalId.trim()) {
      throw new Error('BRIDGE_HOST_ACTOR_ROLE_INVALID');
    }
    const verified = host.creativeRunCoordinator.verifyOwnerAuthorityCapability(
      actor.capability, role,
    );
    if (verified.id !== actor.principalId || verified.role !== actor.role) {
      throw new Error('BRIDGE_HOST_ACTOR_IDENTITY_INVALID');
    }
    return actor;
  }

/** Real host-authenticated issuance route; capabilities never leave this process. */
export function issueArtistReviewActionCheckpoint(host: TuiBridgeService, sessionId: string, ownerCredential: string, action: ArtistReviewAction, issuerCredential?: string): IssuedBridgeActionCheckpoint {
    host.getStatus(sessionId);
    const session = host.authenticArtistReviews.get(sessionId);
    if (!session) throw new Error(`Authentic artist review not found for session: ${sessionId}`);
    const owner = host.resolveHostActor(sessionId, ownerCredential, 'owner');
    const issuer = action.kind === 'learning'
      ? host.resolveHostActor(sessionId, issuerCredential ?? '', 'issuer') : undefined;
    if (issuer && issuer.principalId === owner.principalId) {
      throw new Error('BRIDGE_HOST_ACTOR_SEPARATION_REQUIRED');
    }
    const expiresAt = new Date(
      Date.parse(host.now()) + ACTION_CHECKPOINT_TTL_MS,
    ).toISOString();
    const token = session.issueActionToken(action, {
      ownerCapability: owner.capability,
      ...(issuer ? { issuerCapability: issuer.capability } : {}),
    }, expiresAt);
    host.artistActionCheckpoints.set(token, Object.freeze({
      sessionId, principalId: owner.principalId, ownerCapability: owner.capability,
      stateDigest: session.state().stateDigest,
      scopeDigest: session.actionCheckpointScope(token),
      expiresAt: Date.parse(expiresAt),
    }));
    host.hostIssuedArtistActions.add(token);
    return Object.freeze({ token, expiresAt });
  }

/** Host-derived revision release target; unavailable until blind preference succeeds. */
export function issueArtistReviewReleaseCheckpoint(host: TuiBridgeService, sessionId: string, ownerCredential: string, decision: 'release-worthy' | 'not-release-worthy'): IssuedBridgeActionCheckpoint {
    const artist = host.authenticArtistReviews.get(sessionId);
    if (!artist) throw new Error('ARTIST_REVIEW_RELEASE_TARGET_NOT_READY');
    return host.issueArtistReviewActionCheckpoint(
      sessionId, ownerCredential, artist.hostDerivedReleaseAction(decision),
    );
  }

export function getArtistReviewState(host: TuiBridgeService, sessionId: string): ArtistReviewState {
    host.getStatus(sessionId);
    const surface = host.artistReviews.get(sessionId);
    if (!surface) throw new Error(`Artist review not found for session: ${sessionId}`);
    return surface.state();
  }

export function executeArtistReviewAction(host: TuiBridgeService, sessionId: string, token: string, ownerCredential?: string): ArtistReviewActionResult {
    host.getStatus(sessionId);
    const surface = host.artistReviews.get(sessionId);
    if (!surface) throw new Error(`Artist review not found for session: ${sessionId}`);
    if (host.hostIssuedArtistActions.has(token)) {
      const checkpoint = host.artistActionCheckpoints.get(token);
      host.artistActionCheckpoints.delete(token);
      if (!checkpoint || checkpoint.sessionId !== sessionId
        || Date.parse(host.now()) >= checkpoint.expiresAt
        || surface.state().stateDigest !== checkpoint.stateDigest) {
        throw new Error('ARTIST_REVIEW_ACTION_CHECKPOINT_INVALID');
      }
      const owner = host.resolveHostActor(sessionId, ownerCredential ?? '', 'owner');
      const authentic = host.authenticArtistReviews.get(sessionId);
      if (!authentic || owner.principalId !== checkpoint.principalId
        || owner.capability !== checkpoint.ownerCapability
        || authentic.actionCheckpointScope(token) !== checkpoint.scopeDigest) {
        throw new Error('ARTIST_REVIEW_ACTION_CHECKPOINT_INVALID');
      }
    }
    const result = surface.executeAction(token);
    host.emit(sessionId, {
      type: 'artist.review_state', sessionId,
      stateDigest: result.state.stateDigest,
      decisionVersion: result.state.decisionVersion,
      feedback: result.feedback,
    });
    return result;
  }
