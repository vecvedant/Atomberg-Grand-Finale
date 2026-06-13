/**
 * Admin (master) API. The admin is the single top account: it manages MANAGERS
 * (create / reset / remove) and reviews their performance. It never creates
 * another admin. Admins can also do anything a manager can.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.ts';
import { db } from '../db/index.ts';
import { sessionRepo, participantRepo, eventRepo, agentRepo } from '../db/repos.ts';
import { hashPassword } from '../auth/passwords.ts';
import { endSession, buildSessionRecord } from '../services/sessions.ts';
import { allManagerStats, managerStats } from '../services/stats.ts';
import { metrics } from '../metrics/metrics.ts';

export const adminRouter = Router();
adminRouter.use(requireRole('admin'));

/* ----------------------------- manager management ----------------------------- */

// Performance of every manager (with their agent breakdown).
adminRouter.get('/managers', (_req, res) => {
  res.json(allManagerStats());
});

adminRouter.get('/managers/:id', (req, res) => {
  const m = agentRepo.findById(req.params.id as string);
  if (!m || m.role !== 'manager') {
    res.status(404).json({ error: 'Manager not found' });
    return;
  }
  res.json(managerStats(m.id));
});

// Create a MANAGER. Admins cannot create other admins, and agents are created
// by managers (so role is fixed to 'manager' here).
const createManagerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, and . _ -'),
  displayName: z.string().min(1).max(60),
  password: z.string().min(6).max(256),
  employeeId: z.string().min(1).max(40),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(120),
});
adminRouter.post('/managers', (req, res) => {
  const parsed = createManagerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  if (agentRepo.findByUsername(parsed.data.username)) {
    res.status(409).json({ error: 'That username is already taken' });
    return;
  }
  const m = agentRepo.create({
    username: parsed.data.username,
    passwordHash: hashPassword(parsed.data.password),
    displayName: parsed.data.displayName,
    role: 'manager',
    managerId: null,
    employeeId: parsed.data.employeeId.trim(),
    phone: parsed.data.phone.trim(),
    email: parsed.data.email.trim(),
  });
  res.status(201).json({ id: m.id, username: m.username, displayName: m.display_name, role: m.role });
});

// Reset any account's password (admin-initiated, no email service).
const resetSchema = z.object({ newPassword: z.string().min(6).max(256) });
adminRouter.post('/accounts/:id/reset-password', (req, res) => {
  const parsed = resetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  const account = agentRepo.findById(req.params.id as string);
  if (!account || account.role === 'admin') {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  agentRepo.updatePassword(account.id, hashPassword(parsed.data.newPassword));
  res.json({ ok: true });
});

// Remove a manager (and their agents). Cannot remove an admin.
adminRouter.delete('/managers/:id', (req, res) => {
  const m = agentRepo.findById(req.params.id as string);
  if (!m || m.role !== 'manager') {
    res.status(404).json({ error: 'Manager not found' });
    return;
  }
  for (const agent of agentRepo.listByManager(m.id)) agentRepo.remove(agent.id);
  agentRepo.remove(m.id);
  res.json({ ok: true });
});

/* ----------------------------- live operations ----------------------------- */

function summarize(sessionId: string) {
  const session = sessionRepo.findById(sessionId)!;
  const participants = participantRepo.listBySession(sessionId);
  const connected = participants.filter((p) => p.status === 'connected');
  const startMs = new Date(session.created_at).getTime();
  const endMs = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  const agent = session.agent_id ? agentRepo.findById(session.agent_id) : undefined;
  const manager = session.manager_id ? agentRepo.findById(session.manager_id) : undefined;
  return {
    id: session.id,
    title: session.title,
    description: session.description,
    status: session.status,
    scheduledAt: session.scheduled_at,
    agent: agent?.display_name ?? (session.status === 'open' ? 'Unassigned' : 'unknown'),
    manager: manager?.display_name ?? '—',
    createdAt: session.created_at,
    endedAt: session.ended_at,
    durationSec: Math.round((endMs - startMs) / 1000),
    resolved: session.resolved,
    customerRating: session.customer_rating,
    participantCount: participants.length,
    connectedCount: connected.length,
    participants: participants.map((p) => ({
      id: p.id,
      role: p.role,
      displayName: p.display_name,
      status: p.status,
      joinedAt: p.joined_at,
      leftAt: p.left_at,
    })),
  };
}

adminRouter.get('/overview', (_req, res) => {
  const active = sessionRepo.listAll('active');
  let connected = 0;
  for (const s of active) connected += participantRepo.listConnected(s.id).length;
  res.json({
    activeSessions: active.length,
    connectedParticipants: connected,
    totalSessions: sessionRepo.listAll().length,
    managers: agentRepo.listByRole('manager').length,
    agents: agentRepo.listByRole('agent').length,
  });
});

// Human-readable metrics summary (the raw Prometheus feed lives at /metrics).
adminRouter.get('/metrics', (_req, res) => {
  const count = (sql: string, ...p: unknown[]) => ((db.prepare(sql).get(...(p as never[])) as { n: number }).n);
  const active = sessionRepo.listAll('active');
  let connected = 0;
  for (const s of active) connected += participantRepo.listConnected(s.id).length;
  let errors = 0;
  try {
    const g = metrics.errorsTotal.get() as { values?: { value: number }[] };
    errors = (g.values || []).reduce((a, v) => a + (v.value || 0), 0);
  } catch {
    /* ignore */
  }
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    managers: agentRepo.listByRole('manager').length,
    agents: agentRepo.listByRole('agent').length,
    sessions: {
      total: count('SELECT COUNT(*) n FROM sessions'),
      open: count("SELECT COUNT(*) n FROM sessions WHERE status='open'"),
      scheduled: count("SELECT COUNT(*) n FROM sessions WHERE status='scheduled'"),
      active: count("SELECT COUNT(*) n FROM sessions WHERE status='active'"),
      ended: count("SELECT COUNT(*) n FROM sessions WHERE status='ended'"),
    },
    connectedParticipants: connected,
    messagesTotal: count('SELECT COUNT(*) n FROM messages'),
    recordingsTotal: count('SELECT COUNT(*) n FROM recordings'),
    filesShared: count('SELECT COUNT(*) n FROM files'),
    errorsTotal: errors,
  });
});

adminRouter.get('/sessions', (req, res) => {
  const status = ['open', 'active', 'ended', 'scheduled'].includes(String(req.query.status))
    ? (req.query.status as 'open' | 'active' | 'ended' | 'scheduled')
    : undefined;
  res.json(sessionRepo.listAll(status).map((s) => summarize(s.id)));
});

adminRouter.get('/sessions/:id', (req, res) => {
  const record = buildSessionRecord(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ...record, events: eventRepo.listBySession(req.params.id as string) });
});

adminRouter.post('/sessions/:id/end', (req, res) => {
  const account = req.account!;
  const ended = endSession(req.params.id as string, `admin:${account.username}`);
  res.json({ ok: true, alreadyEnded: !ended });
});
