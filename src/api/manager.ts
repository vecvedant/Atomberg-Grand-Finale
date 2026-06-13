/**
 * Manager API. A manager runs their own agent pool: create/remove agents, reset
 * their passwords, view per-agent performance, and oversee their tasks. Managers
 * cannot create managers or admins.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.ts';
import { agentRepo, sessionRepo } from '../db/repos.ts';
import { hashPassword } from '../auth/passwords.ts';
import { managerStats, agentReport } from '../services/stats.ts';

export const managerRouter = Router();
managerRouter.use(requireRole('manager'));

function ownsAgent(managerId: string, agentId: string): boolean {
  const a = agentRepo.findById(agentId);
  return !!a && a.role === 'agent' && a.manager_id === managerId;
}

// Manager dashboard: own performance + per-agent stats.
managerRouter.get('/me', (req, res) => {
  res.json(managerStats(req.account!.sub));
});

// Tasks in this manager's pool (open + accepted + finished).
managerRouter.get('/tasks', (req, res) => {
  const managerId = req.account!.sub;
  res.json(
    sessionRepo.listByManager(managerId).map((s) => {
      const agent = s.agent_id ? agentRepo.findById(s.agent_id) : undefined;
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        status: s.status,
        agent: agent?.display_name ?? null,
        scheduledAt: s.scheduled_at,
        createdAt: s.created_at,
        resolved: s.resolved,
        source: s.source,
        requesterName: s.requester_name,
        requesterPhone: s.requester_phone,
        purchaseDate: s.purchase_date,
        warrantyStatus: s.warranty_status,
        warrantyAuto: s.warranty_auto,
        billFileId: s.bill_file_id,
      };
    }),
  );
});

// Create an AGENT in this manager's pool.
const createAgentSchema = z.object({
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
managerRouter.post('/agents', (req, res) => {
  const parsed = createAgentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  if (agentRepo.findByUsername(parsed.data.username)) {
    res.status(409).json({ error: 'That username is already taken' });
    return;
  }
  const a = agentRepo.create({
    username: parsed.data.username,
    passwordHash: hashPassword(parsed.data.password),
    displayName: parsed.data.displayName,
    role: 'agent',
    managerId: req.account!.sub,
    employeeId: parsed.data.employeeId.trim(),
    phone: parsed.data.phone.trim(),
    email: parsed.data.email.trim(),
  });
  res.status(201).json({ id: a.id, username: a.username, displayName: a.display_name, role: a.role });
});

// Reset one of your agents' passwords.
const resetSchema = z.object({ newPassword: z.string().min(6).max(256) });
managerRouter.post('/agents/:id/reset-password', (req, res) => {
  if (!ownsAgent(req.account!.sub, req.params.id as string)) {
    res.status(404).json({ error: 'Agent not found in your pool' });
    return;
  }
  const parsed = resetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  agentRepo.updatePassword(req.params.id as string, hashPassword(parsed.data.newPassword));
  res.json({ ok: true });
});

// Remove one of your agents.
managerRouter.delete('/agents/:id', (req, res) => {
  if (!ownsAgent(req.account!.sub, req.params.id as string)) {
    res.status(404).json({ error: 'Agent not found in your pool' });
    return;
  }
  agentRepo.remove(req.params.id as string);
  res.json({ ok: true });
});

// Detailed task report for one of your agents.
managerRouter.get('/agents/:id/report', (req, res) => {
  if (!ownsAgent(req.account!.sub, req.params.id as string)) {
    res.status(404).json({ error: 'Agent not found in your pool' });
    return;
  }
  res.json(agentReport(req.params.id as string));
});
