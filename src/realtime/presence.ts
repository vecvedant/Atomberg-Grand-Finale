/**
 * Presence + reconnect-grace tracking.
 *
 * Participant identity lives in SQLite (status/socket_id). This manager holds the
 * volatile bits that don't belong in the DB:
 *   - per-participant grace timers (the reconnect window)
 *   - live media state (audio/video on/off) for the roster UI
 *
 * Reconnect handling (bonus 3.3): when a socket drops we mark the participant
 * "disconnected" and start a grace timer instead of immediately removing them.
 * If they reconnect within the window we cancel the timer and no "left" event is
 * ever emitted to the other party. If the window expires they are treated as
 * having left.
 */
import { config } from '../config.ts';
import { participantRepo, eventRepo } from '../db/repos.ts';
import { logger } from '../util/logger.ts';

const log = logger('presence');

export interface MediaState {
  audio: boolean;
  video: boolean;
}

export interface RosterEntry {
  participantId: string;
  role: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  status: string;
  media: MediaState;
}

const graceTimers = new Map<string, NodeJS.Timeout>();
const mediaStates = new Map<string, MediaState>();

export const presence = {
  initMedia(participantId: string): MediaState {
    const state: MediaState = { audio: true, video: true };
    mediaStates.set(participantId, state);
    return state;
  },

  setMedia(participantId: string, patch: Partial<MediaState>): MediaState {
    const current = mediaStates.get(participantId) ?? { audio: true, video: true };
    const next = { ...current, ...patch };
    mediaStates.set(participantId, next);
    return next;
  },

  getMedia(participantId: string): MediaState {
    return mediaStates.get(participantId) ?? { audio: true, video: true };
  },

  /** Current connected roster for a session, with live media state. */
  roster(sessionId: string): RosterEntry[] {
    return participantRepo.listConnected(sessionId).map((p) => ({
      participantId: p.id,
      role: p.role,
      displayName: p.display_name,
      phone: p.phone,
      email: p.email,
      status: p.status,
      media: presence.getMedia(p.id),
    }));
  },

  /** Cancel a pending grace timer (called when a participant reconnects in time). */
  cancelGrace(participantId: string): boolean {
    const timer = graceTimers.get(participantId);
    if (!timer) return false;
    clearTimeout(timer);
    graceTimers.delete(participantId);
    log.info('reconnected within grace window', { participantId });
    return true;
  },

  /**
   * Start the grace window on disconnect. `onExpire` runs only if the participant
   * does NOT reconnect in time, and is where the "participant left" broadcast +
   * SFU teardown happen.
   */
  startGrace(sessionId: string, participantId: string, onExpire: () => void): void {
    // Replace any existing timer for safety.
    presence.cancelGrace(participantId);
    participantRepo.setStatus(participantId, 'disconnected');
    eventRepo.log({ sessionId, type: 'disconnect', participantId, metadata: { graceMs: config.reconnectGraceMs } });

    const timer = setTimeout(() => {
      graceTimers.delete(participantId);
      const p = participantRepo.findById(participantId);
      // Only finalize if they're still disconnected (i.e. never came back).
      if (p && p.status === 'disconnected') {
        participantRepo.setStatus(participantId, 'left');
        eventRepo.log({ sessionId, type: 'leave', participantId, metadata: { reason: 'grace_expired' } });
        mediaStates.delete(participantId);
        onExpire();
      }
    }, config.reconnectGraceMs);

    graceTimers.set(participantId, timer);
    log.info('started reconnect grace window', { participantId, graceMs: config.reconnectGraceMs });
  },

  /** Clear all timers/state for a session (used when a session ends). */
  clearSession(sessionId: string): void {
    for (const p of participantRepo.listBySession(sessionId)) {
      presence.cancelGrace(p.id);
      mediaStates.delete(p.id);
    }
  },
};
