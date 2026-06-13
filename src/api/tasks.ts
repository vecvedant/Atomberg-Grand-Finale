/**
 * Task pool (Rapido-style). A manager (or admin) creates a task into a manager's
 * pool; it is 'open' until an agent under that manager ACCEPTS it. The accepting
 * agent becomes the assigned agent and runs the call.
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { requireRole, requireRoles } from '../auth/middleware.ts';
import { agentRepo, sessionRepo, eventRepo } from '../db/repos.ts';
import { createTask } from '../services/sessions.ts';
import { agentStats } from '../services/stats.ts';

export const tasksRouter = Router();

const inviteUrl = (token: string) => `${config.publicBaseUrl}/customer.html?token=${encodeURIComponent(token)}`;

/** Customer-intake fields exposed to the handling agent. */
function intakeFields(s: { source: string; requester_name: string | null; requester_phone: string | null; requester_email: string | null; purchase_date: string | null; warranty_status: string | null; warranty_auto: number | null; bill_file_id: string | null }) {
  return {
    source: s.source,
    requesterName: s.requester_name,
    requesterPhone: s.requester_phone,
    requesterEmail: s.requester_email,
    purchaseDate: s.purchase_date,
    warrantyStatus: s.warranty_status,
    warrantyAuto: s.warranty_auto,
    billFileId: s.bill_file_id,
  };
}

/* ------------------------------- create (manager/admin) ------------------------------- */
const createSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  scheduledAt: z.string().max(40).optional(),
  managerId: z.string().optional(), // required when an admin creates a task
});
tasksRouter.post('/', requireRoles('manager', 'admin'), (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  const account = req.account!;
  // Managers create into their own pool; admins must name a manager.
  let managerId: string;
  if (account.role === 'manager') {
    managerId = account.sub;
  } else {
    const target = parsed.data.managerId ? agentRepo.findById(parsed.data.managerId) : undefined;
    if (!target || target.role !== 'manager') {
      res.status(400).json({ error: 'Select a manager for this task' });
      return;
    }
    managerId = target.id;
  }

  let scheduledAt: string | null = null;
  if (parsed.data.scheduledAt) {
    const d = new Date(parsed.data.scheduledAt);
    if (!Number.isNaN(d.getTime())) scheduledAt = d.toISOString();
  }

  const task = createTask({
    title: parsed.data.title?.trim() || 'Support task',
    description: parsed.data.description?.trim() || '',
    managerId,
    createdBy: account.username,
    scheduledAt,
  });
  res.status(201).json({
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    scheduledAt: task.scheduled_at,
    inviteUrl: task.inviteUrl,
  });
});

/* ------------------------------- agent: available pool ------------------------------- */
tasksRouter.get('/available', requireRole('agent'), (req, res) => {
  const agent = agentRepo.findById(req.account!.sub);
  if (!agent?.manager_id) {
    res.json([]);
    return;
  }
  res.json(
    sessionRepo.listOpenByManager(agent.manager_id).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      scheduledAt: s.scheduled_at,
      createdAt: s.created_at,
      ...intakeFields(s),
    })),
  );
});

/* ------------------------------- agent: accept a task ------------------------------- */
tasksRouter.post('/:id/accept', requireRole('agent'), (req, res) => {
  const agent = agentRepo.findById(req.account!.sub);
  const task = sessionRepo.findById(req.params.id as string);
  if (!task || task.status !== 'open') {
    res.status(409).json({ error: 'This task is no longer available' });
    return;
  }
  if (!agent?.manager_id || task.manager_id !== agent.manager_id) {
    res.status(403).json({ error: 'This task is not in your pool' });
    return;
  }
  const claimed = sessionRepo.accept(task.id, agent.id);
  if (!claimed) {
    res.status(409).json({ error: 'Another agent just accepted this task' });
    return;
  }
  eventRepo.log({ sessionId: task.id, type: 'task_accepted', metadata: { agent: agent.display_name } });
  res.json({
    id: task.id,
    title: task.title,
    description: task.description,
    status: 'scheduled',
    inviteUrl: inviteUrl(task.invite_token),
    ...intakeFields(task),
  });
});

/* ------------------------------- agent: own stats ------------------------------- */
tasksRouter.get('/stats', requireRole('agent'), (req, res) => {
  res.json(agentStats(req.account!.sub));
});

/* ------------------------------- agent: my tasks ------------------------------- */
tasksRouter.get('/mine', requireRole('agent'), (req, res) => {
  res.json(
    sessionRepo.listByAgent(req.account!.sub).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      status: s.status,
      scheduledAt: s.scheduled_at,
      createdAt: s.created_at,
      endedAt: s.ended_at,
      resolved: s.resolved,
      inviteUrl: inviteUrl(s.invite_token),
      ...intakeFields(s),
    })),
  );
});
