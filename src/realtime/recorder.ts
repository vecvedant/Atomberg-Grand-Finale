/**
 * Server-side call recording (bonus 3.1). Because the server is the SFU, it
 * already receives every participant's media — so recording needs no extra
 * client work and no ffmpeg. We mux the live incoming tracks into a single WebM
 * file using werift's built-in MediaRecorder.
 *
 * Status lifecycle (persisted in the `recordings` table + broadcast to the UI):
 *   recording → processing → ready   (or → failed)
 */
import path from 'node:path';
import { MediaRecorder } from 'werift/nonstandard';
import { config } from '../config.ts';
import { recordingRepo, eventRepo, participantRepo } from '../db/repos.ts';
import { getSessionIncomingTracks } from './sfu.ts';
import { logger } from '../util/logger.ts';

const log = logger('recorder');

interface ActiveRecording {
  recorder: MediaRecorder;
  recordingId: string;
  startedAt: number;
  filePath: string;
}

const active = new Map<string, ActiveRecording>();

export function isRecording(sessionId: string): boolean {
  return active.has(sessionId);
}

export function activeRecordingId(sessionId: string): string | null {
  return active.get(sessionId)?.recordingId ?? null;
}

/** Begin recording every track currently flowing through the session's SFU room. */
export async function startRecording(sessionId: string): Promise<{ recordingId: string; status: 'recording' }> {
  const existing = active.get(sessionId);
  if (existing) return { recordingId: existing.recordingId, status: 'recording' };

  const tracks = getSessionIncomingTracks(sessionId);
  if (tracks.length === 0) throw new Error('No media is flowing yet — wait for the customer to join.');

  // Order tracks so the customer is the primary (first) video in single-stream players.
  const role = (pid: string) => participantRepo.findById(pid)?.role ?? 'customer';
  const ordered = [...tracks].sort((a, b) => {
    const ra = role(a.participantId) === 'customer' ? 0 : 1;
    const rb = role(b.participantId) === 'customer' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.kind === 'video' ? -1 : 1;
  });

  const recording = recordingRepo.create(sessionId);
  const filePath = path.join(config.paths.recordings, `${recording.id}.webm`);

  const recorder = new MediaRecorder({ path: filePath, numOfTracks: ordered.length, disableLipSync: true });
  recorder.onError.subscribe((err) => log.error('recorder error', { sessionId, err: err.message }));
  for (const { track } of ordered) await recorder.addTrack(track);

  active.set(sessionId, { recorder, recordingId: recording.id, startedAt: Date.now(), filePath });
  eventRepo.log({ sessionId, type: 'recording_start', metadata: { recordingId: recording.id, tracks: ordered.length } });
  log.info('recording started', { sessionId, recordingId: recording.id, tracks: ordered.length });
  return { recordingId: recording.id, status: 'recording' };
}

/** Stop recording, finalize the file, and mark it ready (or failed). */
export async function stopRecording(
  sessionId: string,
): Promise<{ recordingId: string; status: 'ready' | 'failed'; durationSec: number } | null> {
  const rec = active.get(sessionId);
  if (!rec) return null;
  active.delete(sessionId);
  recordingRepo.setStatus(rec.recordingId, 'processing');

  const durationSec = Math.round((Date.now() - rec.startedAt) / 1000);
  try {
    await rec.recorder.stop();
    recordingRepo.finalize(rec.recordingId, rec.filePath, durationSec);
    eventRepo.log({ sessionId, type: 'recording_stop', metadata: { recordingId: rec.recordingId, durationSec } });
    log.info('recording ready', { sessionId, recordingId: rec.recordingId, durationSec });
    return { recordingId: rec.recordingId, status: 'ready', durationSec };
  } catch (err) {
    recordingRepo.setStatus(rec.recordingId, 'failed');
    log.error('recording failed to finalize', { sessionId, err: (err as Error).message });
    return { recordingId: rec.recordingId, status: 'failed', durationSec };
  }
}
