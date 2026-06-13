/**
 * Session-level operations shared by the REST API and the realtime layer, so
 * "end a session" behaves identically whether triggered by an HTTP call (agent
 * console / admin dashboard) or a socket event.
 */
import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { agentRepo, sessionRepo, participantRepo, messageRepo, eventRepo, recordingRepo, fileRepo } from '../db/repos.ts';
import { signInviteToken } from '../auth/tokens.ts';
import { bus } from '../bus.ts';
import type { Session } from '../types.ts';

/** Pick the manager with the lightest current load (fewest unfinished tasks). */
export function pickLeastLoadedManager(): string | null {
  const managers = agentRepo.listByRole('manager'); // ordered by created_at (stable tie-break)
  if (managers.length === 0) return null;
  let best = managers[0]!;
  let bestLoad = sessionRepo.activeLoad(best.id);
  for (const m of managers.slice(1)) {
    const load = sessionRepo.activeLoad(m.id);
    if (load < bestLoad) {
      best = m;
      bestLoad = load;
    }
  }
  return best.id;
}

/** Auto-suggest whether a product is still in warranty from its purchase date. */
export function computeWarrantyAuto(purchaseDate: string | null): number | null {
  if (!purchaseDate) return null;
  const bought = new Date(purchaseDate);
  if (Number.isNaN(bought.getTime())) return null;
  const expiry = new Date(bought);
  expiry.setMonth(expiry.getMonth() + config.warrantyMonths);
  return Date.now() <= expiry.getTime() ? 1 : 0;
}

/**
 * Create a task from a public customer intake submission. Auto-routes to the
 * least-loaded manager's pool and records the request details + warranty flag.
 */
export function createIntakeTask(input: {
  title: string;
  description: string;
  requesterName: string;
  requesterPhone: string;
  requesterEmail: string;
  purchaseDate: string | null;
  warrantyStatus: string | null;
  scheduledAt?: string | null;
}): (Session & { inviteToken: string; inviteUrl: string; managerId: string | null; warrantyAuto: number | null }) {
  const managerId = pickLeastLoadedManager();
  const session = sessionRepo.create({
    title: input.title,
    description: input.description,
    managerId,
    createdBy: 'intake',
    inviteToken: 'pending',
    status: 'open',
    source: 'intake',
    scheduledAt: input.scheduledAt ?? null,
  });
  const inviteToken = signInviteToken(session.id);
  db.prepare(`UPDATE sessions SET invite_token = ? WHERE id = ?`).run(inviteToken, session.id);
  const warrantyAuto = computeWarrantyAuto(input.purchaseDate);
  sessionRepo.setIntake(session.id, {
    requesterName: input.requesterName,
    requesterPhone: input.requesterPhone,
    requesterEmail: input.requesterEmail,
    purchaseDate: input.purchaseDate,
    warrantyStatus: input.warrantyStatus,
    warrantyAuto,
  });
  eventRepo.log({ sessionId: session.id, type: 'intake_submitted', metadata: { managerId, warrantyAuto } });
  return {
    ...session,
    invite_token: inviteToken,
    inviteToken,
    inviteUrl: `${config.publicBaseUrl}/customer.html?token=${encodeURIComponent(inviteToken)}`,
    managerId,
    warrantyAuto,
  };
}

/**
 * Create a support task in a manager's pool. It starts 'open' (unassigned); an
 * agent under that manager accepts it to become the assigned agent.
 */
export function createTask(input: {
  title: string;
  description?: string;
  managerId: string | null;
  createdBy: string;
  scheduledAt?: string | null;
}): Session & { inviteToken: string; inviteUrl: string } {
  // The invite token must encode the session id, which only exists after insert,
  // so we create the row first then persist the signed token onto it.
  const session = sessionRepo.create({
    title: input.title,
    description: input.description ?? '',
    managerId: input.managerId,
    createdBy: input.createdBy,
    inviteToken: 'pending',
    status: 'open',
    scheduledAt: input.scheduledAt ?? null,
  });
  const inviteToken = signInviteToken(session.id);
  db.prepare(`UPDATE sessions SET invite_token = ? WHERE id = ?`).run(inviteToken, session.id);
  eventRepo.log({
    sessionId: session.id,
    type: 'task_created',
    metadata: { title: session.title, managerId: input.managerId, scheduledAt: input.scheduledAt ?? undefined },
  });
  return {
    ...session,
    invite_token: inviteToken,
    inviteToken,
    inviteUrl: `${config.publicBaseUrl}/customer.html?token=${encodeURIComponent(inviteToken)}`,
  };
}

/** Marks a session ended (idempotent) and notifies the realtime layer to tear down. */
export function endSession(sessionId: string, endedBy: string): boolean {
  const session = sessionRepo.findById(sessionId);
  if (!session || session.status === 'ended') return false;
  sessionRepo.end(sessionId, endedBy);
  eventRepo.log({ sessionId, type: 'session_ended', metadata: { endedBy } });
  bus.emitEvent('session:ended', { sessionId, endedBy });
  return true;
}

/** Chat history enriched with file metadata, in a clean client-friendly shape. */
export function listSessionMessages(sessionId: string) {
  return messageRepo.listBySession(sessionId).map((m) => {
    const file = m.file_id ? fileRepo.findById(m.file_id) : undefined;
    return {
      id: m.id,
      senderParticipantId: m.sender_participant_id,
      senderRole: m.sender_role,
      senderName: m.sender_name,
      body: m.body,
      file: file ? { id: file.id, name: file.original_name, mime: file.mime, size: file.size } : null,
      createdAt: m.created_at,
    };
  });
}

/** Builds the full, persisted record for a session (history + chat + events). */
export function buildSessionRecord(sessionId: string) {
  const session = sessionRepo.findById(sessionId);
  if (!session) return null;
  const participants = participantRepo.listBySession(sessionId);
  const messages = listSessionMessages(sessionId);
  const events = eventRepo.listBySession(sessionId);
  const recordings = recordingRepo.listBySession(sessionId);

  const durationsMs = participants
    .filter((p) => p.left_at)
    .map((p) => new Date(p.left_at!).getTime() - new Date(p.joined_at).getTime());

  return {
    // Don't leak the invite token in the record payload.
    session: { ...session, invite_token: undefined },
    participants,
    messages,
    events,
    recordings,
    summary: {
      participantCount: participants.length,
      messageCount: messages.length,
      totalParticipantSeconds: Math.round(durationsMs.reduce((a, b) => a + b, 0) / 1000),
    },
  };
}
