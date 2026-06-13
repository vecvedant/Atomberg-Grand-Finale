/**
 * File sharing in chat (bonus 3.2). Uploads are validated (size cap + MIME
 * allowlist), stored under uploads/<sessionId>/ with a RANDOM filename (the
 * original name never touches the filesystem → no path traversal), and served
 * back only to authorized callers (a participant of the session, or agent/admin).
 *
 * Auth model: uploads require a valid socket-issued participant identity passed
 * as a header; downloads accept either an account token (agent/admin) or the
 * session's invite token (customer) so in-call links work for both roles.
 */
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, createReadStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { fileRepo, sessionRepo, participantRepo } from '../db/repos.ts';
import { verifyAccountToken, verifyInviteToken } from '../auth/tokens.ts';

export const filesRouter = Router();

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

/** Resolve who is calling and which session they may act on, from a token. */
function authorizeSession(token: string | undefined, sessionId: string) {
  if (!token) return null;
  const account = verifyAccountToken(token);
  if (account) {
    const session = sessionRepo.findById(sessionId);
    if (!session) return null;
    if (account.role === 'admin' || session.agent_id === account.sub || session.manager_id === account.sub) {
      return { kind: 'account' as const };
    }
    return null;
  }
  const invite = verifyInviteToken(token);
  if (invite && invite.sessionId === sessionId) return { kind: 'invite' as const };
  return null;
}

function bearer(req: { headers: Record<string, unknown>; query: Record<string, unknown> }): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  if (typeof req.query.token === 'string') return req.query.token;
  return undefined;
}

// Upload a file into a session. Returns a file id the client references in chat.
filesRouter.post('/:sessionId/upload', upload.single('file'), (req, res) => {
  const sessionId = req.params.sessionId as string;
  const auth = authorizeSession(bearer(req as any), sessionId);
  if (!auth) {
    res.status(401).json({ error: 'Not authorized for this session' });
    return;
  }
  const session = sessionRepo.findById(sessionId);
  if (!session || session.status !== 'active') {
    res.status(409).json({ error: 'Session is not active' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'No file (or type not allowed)' });
    return;
  }

  const participantId = typeof req.body?.participantId === 'string' ? req.body.participantId : null;
  // If a participant id is supplied it must belong to this session.
  if (participantId) {
    const p = participantRepo.findById(participantId);
    if (!p || p.session_id !== sessionId) {
      res.status(400).json({ error: 'Invalid participant' });
      return;
    }
  }

  const dir = path.join(config.paths.uploads, sessionId);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(req.file.originalname).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
  const storedName = `${randomUUID()}${ext}`;
  const storedPath = path.join(dir, storedName);
  // Persist the in-memory buffer to the randomized path.
  writeFileSync(storedPath, req.file.buffer);

  const record = fileRepo.create({
    sessionId,
    uploaderParticipantId: participantId,
    originalName: req.file.originalname.slice(0, 200),
    storedName,
    mime: req.file.mimetype,
    size: req.file.size,
  });

  res.status(201).json({ id: record.id, name: record.original_name, mime: record.mime, size: record.size });
});

// Download / view a shared file (authorized session participants only).
filesRouter.get('/:id', (req, res) => {
  const file = fileRepo.findById(req.params.id as string);
  if (!file) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const auth = authorizeSession(bearer(req as any), file.session_id);
  if (!auth) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }
  const filePath = path.join(config.paths.uploads, file.session_id, file.stored_name);
  if (!existsSync(filePath)) {
    res.status(410).json({ error: 'File no longer available' });
    return;
  }
  res.setHeader('Content-Type', file.mime);
  // inline for images/pdf so they preview; attachment otherwise.
  const disposition = file.mime.startsWith('image/') || file.mime === 'application/pdf' ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.original_name)}"`);
  createReadStream(filePath).pipe(res);
});
