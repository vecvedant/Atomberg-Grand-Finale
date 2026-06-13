/**
 * Session record API: history, chat, ending, resolution, invite validation, and
 * customer feedback. Task creation/acceptance lives in api/tasks.ts.
 *
 * Access control by tier: admin sees all; a manager sees sessions in their pool;
 * an agent sees the sessions assigned to them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAccount } from '../auth/middleware.ts';
import { sessionRepo, eventRepo } from '../db/repos.ts';
import { verifyInviteToken } from '../auth/tokens.ts';
import { endSession, buildSessionRecord, listSessionMessages } from '../services/sessions.ts';
import type { AccountTokenPayload, Session } from '../types.ts';

export const sessionsRouter = Router();

function canAccess(account: AccountTokenPayload, session: Session): boolean {
  if (account.role === 'admin') return true;
  if (account.role === 'manager') return session.manager_id === account.sub;
  return session.agent_id === account.sub;
}

// Full session record (history + chat + events).
sessionsRouter.get('/:id', requireAccount, (req, res) => {
  const session = sessionRepo.findById(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!canAccess(req.account!, session)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json(buildSessionRecord(session.id));
});

// Chat history for a session (retrievable after the call ends).
sessionsRouter.get('/:id/messages', requireAccount, (req, res) => {
  const session = sessionRepo.findById(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!canAccess(req.account!, session)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json(listSessionMessages(session.id));
});

// End a session (assigned agent, owning manager, or admin).
sessionsRouter.post('/:id/end', requireAccount, (req, res) => {
  const session = sessionRepo.findById(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!canAccess(req.account!, session)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const ended = endSession(session.id, req.account!.username);
  res.json({ ok: true, alreadyEnded: !ended });
});

// Agent records whether the problem was resolved + notes.
const resolutionSchema = z.object({ resolved: z.boolean(), notes: z.string().max(2000).optional() });
sessionsRouter.post('/:id/resolution', requireAccount, (req, res) => {
  const session = sessionRepo.findById(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!canAccess(req.account!, session)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const parsed = resolutionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  sessionRepo.setResolution(session.id, parsed.data.resolved ? 1 : 0, parsed.data.notes?.trim() || '');
  eventRepo.log({ sessionId: session.id, type: 'agent_resolution', metadata: { resolved: parsed.data.resolved } });
  res.json({ ok: true });
});

// Customer feedback (rating + whether solved + comment). Auth = the invite token.
const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  resolved: z.boolean().optional(),
  comment: z.string().max(2000).optional(),
  token: z.string().optional(),
});
sessionsRouter.post('/:id/feedback', (req, res) => {
  const parsed = feedbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const sessionId = req.params.id as string;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = parsed.data.token || bearer;
  const invite = token ? verifyInviteToken(token) : null;
  if (!invite || invite.sessionId !== sessionId) {
    res.status(401).json({ error: 'Not authorized for this session' });
    return;
  }
  if (!sessionRepo.findById(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  sessionRepo.setCustomerFeedback(
    sessionId,
    parsed.data.rating ?? null,
    parsed.data.resolved === undefined ? null : parsed.data.resolved ? 1 : 0,
    parsed.data.comment?.trim() || '',
  );
  eventRepo.log({ sessionId, type: 'customer_feedback', metadata: { rating: parsed.data.rating, resolved: parsed.data.resolved } });
  res.json({ ok: true });
});

/**
 * Public invite validation — lets the customer landing page show the problem and
 * confirm the link is valid before asking for camera/mic access.
 */
sessionsRouter.get('/invite/:token', (req, res) => {
  const payload = verifyInviteToken(req.params.token as string);
  if (!payload) {
    res.status(401).json({ valid: false, error: 'Invalid or expired invite' });
    return;
  }
  const session = sessionRepo.findById(payload.sessionId);
  if (!session) {
    res.status(404).json({ valid: false, error: 'Session not found' });
    return;
  }
  res.json({
    valid: true,
    sessionId: session.id,
    title: session.title,
    description: session.description,
    status: session.status,
    scheduledAt: session.scheduled_at,
    ended: session.status === 'ended',
    // True once an agent has claimed the task — only then can the customer join.
    accepted: !!session.agent_id,
    // Live-queue position for a "get on the line" caller (null if scheduled/accepted/ended).
    queuePosition: sessionRepo.liveQueuePosition(session),
    // True while the customer can still convert this into a scheduled-for-later request.
    canSchedule: session.status === 'open',
    // Prefill the join form when the request came from the public intake.
    requesterName: session.requester_name,
    requesterPhone: session.requester_phone,
    requesterEmail: session.requester_email,
  });
});

/**
 * Lets a customer still waiting in the live queue convert their request into a
 * scheduled-for-later one (e.g. no agent has picked up yet). Authorized by the
 * invite token (scoped to this session); only allowed while still 'open'.
 */
const rescheduleSchema = z.object({ scheduledAt: z.string().max(40) });
sessionsRouter.post('/invite/:token/schedule', (req, res) => {
  const payload = verifyInviteToken(req.params.token as string);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired invite' });
    return;
  }
  const session = sessionRepo.findById(payload.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.status !== 'open') {
    res.status(409).json({
      error: session.agent_id ? 'An agent has already picked up your request.' : 'This request can no longer be scheduled.',
    });
    return;
  }
  const parsed = rescheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  const when = new Date(parsed.data.scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    res.status(400).json({ error: 'Pick a date and time in the future.' });
    return;
  }
  sessionRepo.setScheduledAt(session.id, when.toISOString());
  eventRepo.log({ sessionId: session.id, type: 'customer_scheduled', metadata: { scheduledAt: when.toISOString() } });
  res.json({ ok: true, scheduledAt: when.toISOString() });
});
