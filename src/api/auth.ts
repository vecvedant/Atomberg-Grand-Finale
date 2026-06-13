/** Authentication routes: agent/admin login. */
import { Router } from 'express';
import { z } from 'zod';
import { agentRepo } from '../db/repos.ts';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import { signAccountToken, verifyAccountToken } from '../auth/tokens.ts';
import { requireAccount } from '../auth/middleware.ts';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  const { username, password } = parsed.data;
  const agent = agentRepo.findByUsername(username);
  // Verify even when the user is missing-ish to avoid leaking which usernames exist.
  if (!agent || !verifyPassword(password, agent.password_hash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  const token = signAccountToken(agent);
  res.json({
    token,
    user: { id: agent.id, username: agent.username, displayName: agent.display_name, role: agent.role },
  });
});

// Lightweight endpoint for the SPA to validate a stored token on page load.
authRouter.get('/me', (req, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyAccountToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  res.json({ user: { id: payload.sub, username: payload.username, role: payload.role } });
});

// Change your own password (must supply the current one).
const changeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(6).max(256),
});
authRouter.post('/change-password', requireAccount, (req, res) => {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  const agent = agentRepo.findById(req.account!.sub);
  if (!agent || !verifyPassword(parsed.data.currentPassword, agent.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  agentRepo.updatePassword(agent.id, hashPassword(parsed.data.newPassword));
  res.json({ ok: true });
});
