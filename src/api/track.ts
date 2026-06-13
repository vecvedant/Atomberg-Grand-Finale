/**
 * Public request tracking. A customer who submitted a request gets a short
 * reference code; they can look up its live status here (no login). Only the
 * status timeline + a join link are exposed — never contact details.
 */
import { Router } from 'express';
import { config } from '../config.ts';
import { sessionRepo } from '../db/repos.ts';

export const trackRouter = Router();

// Look up a customer's requests by mobile number.
// NOTE: intentionally unverified for now (hackathon scope). In production this
// must be gated behind an OTP sent to the number — a phone number is not a secret.
trackRouter.get('/by-phone', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  if (phone.replace(/\D/g, '').length < 7) {
    res.status(400).json({ error: 'Enter a valid mobile number.' });
    return;
  }
  const requests = sessionRepo.listByPhone(phone).map((s) => ({
    reference: s.ref,
    title: s.title,
    status: s.status,
    accepted: !!s.agent_id,
    ended: s.status === 'ended',
    resolved: s.resolved,
    scheduledAt: s.scheduled_at ?? null,
    createdAt: s.created_at,
  }));
  res.json({ found: requests.length > 0, requests });
});

trackRouter.get('/:ref', (req, res) => {
  const ref = String(req.params.ref || '').trim().toUpperCase();
  const session = ref ? sessionRepo.findByRef(ref) : undefined;
  if (!session) {
    res.status(404).json({ found: false, error: 'No request found for that reference.' });
    return;
  }
  res.json({
    found: true,
    reference: session.ref,
    title: session.title,
    status: session.status, // open | scheduled | active | ended
    accepted: !!session.agent_id,
    ended: session.status === 'ended',
    resolved: session.resolved, // 1 / 0 / null
    scheduledAt: session.scheduled_at ?? null,
    createdAt: session.created_at,
    // Only offer a join link while the session is still live.
    joinUrl:
      session.status === 'ended'
        ? null
        : `${config.publicBaseUrl}/customer.html?token=${encodeURIComponent(session.invite_token)}`,
  });
});
