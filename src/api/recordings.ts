/**
 * Recording routes (bonus 3.1): check status and download the finished file.
 * Start/stop happen over the socket (they need the live SFU); these REST routes
 * cover retrieval. Access is restricted to the owning agent or an admin.
 */
import { Router } from 'express';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { requireAccount } from '../auth/middleware.ts';
import { recordingRepo, sessionRepo } from '../db/repos.ts';
import type { AccountTokenPayload } from '../types.ts';

export const recordingsRouter = Router();

type AuthResult =
  | { ok: false; status: 404 | 403 }
  | { ok: true; recording: NonNullable<ReturnType<typeof recordingRepo.findById>> };

function loadAuthorized(req: Parameters<typeof requireAccount>[0]): AuthResult {
  const account = req.account!;
  const recording = recordingRepo.findById(req.params.id as string);
  if (!recording) return { ok: false, status: 404 };
  const session = sessionRepo.findById(recording.session_id);
  if (!session) return { ok: false, status: 404 };
  const allowed =
    account.role === 'admin' ||
    (account.role === 'manager' && session.manager_id === account.sub) ||
    session.agent_id === account.sub;
  if (!allowed) return { ok: false, status: 403 };
  return { ok: true, recording };
}

// Recording status (recording | processing | ready | failed) + metadata.
recordingsRouter.get('/:id', requireAccount, (req, res) => {
  const result = loadAuthorized(req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.status === 404 ? 'Not found' : 'Forbidden' });
    return;
  }
  const r = result.recording;
  res.json({
    id: r.id,
    sessionId: r.session_id,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
    downloadUrl: r.status === 'ready' ? `/api/recordings/${r.id}/download` : null,
  });
});

// Download the finished WebM recording.
recordingsRouter.get('/:id/download', requireAccount, (req, res) => {
  const result = loadAuthorized(req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.status === 404 ? 'Not found' : 'Forbidden' });
    return;
  }
  const r = result.recording;
  if (r.status !== 'ready' || !r.file_path || !existsSync(r.file_path)) {
    res.status(409).json({ error: `Recording is not ready (status: ${r.status})` });
    return;
  }
  const size = statSync(r.file_path).size;
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Disposition', `attachment; filename="recording-${r.id}.webm"`);
  createReadStream(r.file_path).pipe(res);
});
