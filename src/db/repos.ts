/**
 * Data-access layer. One typed repository per entity, all backed by node:sqlite
 * prepared statements with positional parameters (no string interpolation → no
 * SQL injection). Kept in a single module for cohesion at this project size.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from './index.ts';
import type {
  Agent,
  AccountRole,
  Session,
  SessionStatus,
  Participant,
  ParticipantStatus,
  Message,
  FileRecord,
  SessionEvent,
  Recording,
  RecordingStatus,
  Role,
} from '../types.ts';

const nowIso = () => new Date().toISOString();
const newId = () => randomUUID();

// Short, human-friendly tracking reference (no ambiguous chars like I/O/0/1).
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  return out;
}

/* ------------------------------ agents ------------------------------ */
export const agentRepo = {
  create(input: {
    username: string;
    passwordHash: string;
    displayName: string;
    role: AccountRole;
    managerId?: string | null;
    employeeId?: string | null;
    phone?: string | null;
    email?: string | null;
  }): Agent {
    const agent: Agent = {
      id: newId(),
      username: input.username,
      password_hash: input.passwordHash,
      display_name: input.displayName,
      role: input.role,
      manager_id: input.managerId ?? null,
      employee_id: input.employeeId ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO agents (id, username, password_hash, display_name, role, manager_id, employee_id, phone, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      agent.username,
      agent.password_hash,
      agent.display_name,
      agent.role,
      agent.manager_id,
      agent.employee_id,
      agent.phone,
      agent.email,
      agent.created_at,
    );
    return agent;
  },
  findByUsername(username: string): Agent | undefined {
    return db.prepare(`SELECT * FROM agents WHERE username = ?`).get(username) as unknown as Agent | undefined;
  },
  findById(id: string): Agent | undefined {
    return db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as Agent | undefined;
  },
  list(): Agent[] {
    return db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`).all() as unknown as Agent[];
  },
  listByRole(role: AccountRole): Agent[] {
    return db.prepare(`SELECT * FROM agents WHERE role = ? ORDER BY created_at ASC`).all(role) as unknown as Agent[];
  },
  listByManager(managerId: string): Agent[] {
    return db.prepare(`SELECT * FROM agents WHERE manager_id = ? ORDER BY created_at ASC`).all(managerId) as unknown as Agent[];
  },
  updatePassword(id: string, passwordHash: string): void {
    db.prepare(`UPDATE agents SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
  },
  remove(id: string): void {
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  },
};

/* ------------------------------ sessions ------------------------------ */
export const sessionRepo = {
  create(input: {
    title: string;
    description?: string;
    managerId: string | null;
    agentId?: string | null;
    createdBy: string;
    inviteToken: string;
    status?: SessionStatus;
    scheduledAt?: string | null;
    source?: string;
  }): Session {
    const session: Session = {
      id: newId(),
      title: input.title,
      description: input.description ?? '',
      manager_id: input.managerId ?? null,
      agent_id: input.agentId ?? null,
      created_by: input.createdBy,
      status: input.status ?? 'open',
      invite_token: input.inviteToken,
      scheduled_at: input.scheduledAt ?? null,
      accepted_at: null,
      created_at: nowIso(),
      ended_at: null,
      ended_by: null,
      resolved: null,
      agent_notes: null,
      customer_rating: null,
      customer_resolved: null,
      customer_comment: null,
      source: input.source ?? 'manager',
      requester_name: null,
      requester_phone: null,
      requester_email: null,
      purchase_date: null,
      warranty_status: null,
      warranty_auto: null,
      bill_file_id: null,
      ref: newRef(),
    };
    db.prepare(
      `INSERT INTO sessions (id, title, description, manager_id, agent_id, created_by, status, invite_token, scheduled_at, source, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.title,
      session.description,
      session.manager_id,
      session.agent_id,
      session.created_by,
      session.status,
      session.invite_token,
      session.scheduled_at,
      session.source,
      session.ref,
      session.created_at,
    );
    return session;
  },

  findByRef(ref: string): Session | undefined {
    return db.prepare(`SELECT * FROM sessions WHERE ref = ?`).get(ref) as unknown as Session | undefined;
  },

  /** Customer requests matching a mobile number (normalized; matches last 10 digits). */
  listByPhone(phone: string): Session[] {
    const digits = (s: string | null) => (s || '').replace(/\D/g, '');
    const q = digits(phone);
    if (q.length < 7) return [];
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE requester_phone IS NOT NULL ORDER BY created_at DESC`)
      .all() as unknown as Session[];
    return rows.filter((r) => {
      const d = digits(r.requester_phone);
      return d === q || (d.length >= 10 && q.length >= 10 && d.slice(-10) === q.slice(-10));
    });
  },

  /** Populate the customer-intake fields after a task row exists. */
  setIntake(
    id: string,
    fields: {
      requesterName?: string | null;
      requesterPhone?: string | null;
      requesterEmail?: string | null;
      purchaseDate?: string | null;
      warrantyStatus?: string | null;
      warrantyAuto?: number | null;
      billFileId?: string | null;
    },
  ): void {
    db.prepare(
      `UPDATE sessions SET requester_name = ?, requester_phone = ?, requester_email = ?,
        purchase_date = ?, warranty_status = ?, warranty_auto = ?, bill_file_id = ? WHERE id = ?`,
    ).run(
      fields.requesterName ?? null,
      fields.requesterPhone ?? null,
      fields.requesterEmail ?? null,
      fields.purchaseDate ?? null,
      fields.warrantyStatus ?? null,
      fields.warrantyAuto ?? null,
      fields.billFileId ?? null,
      id,
    );
  },

  setBill(id: string, fileId: string): void {
    db.prepare(`UPDATE sessions SET bill_file_id = ? WHERE id = ?`).run(fileId, id);
  },
  /** Set/clear a request's scheduled time (e.g. a waiting customer books a later slot). */
  setScheduledAt(id: string, iso: string | null): void {
    db.prepare(`UPDATE sessions SET scheduled_at = ? WHERE id = ?`).run(iso, id);
  },
  /** Count of unfinished tasks in a manager's pool (for load-balancing intake). */
  activeLoad(managerId: string): number {
    return (
      db
        .prepare(`SELECT COUNT(*) n FROM sessions WHERE manager_id = ? AND status IN ('open','scheduled','active')`)
        .get(managerId) as { n: number }
    ).n;
  },
  findById(id: string): Session | undefined {
    return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as unknown as Session | undefined;
  },
  activate(id: string): void {
    db.prepare(`UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'scheduled'`).run(id);
  },
  /** An agent claims an open task. Returns true if the claim succeeded. */
  accept(id: string, agentId: string): boolean {
    const res = db
      .prepare(`UPDATE sessions SET agent_id = ?, status = 'scheduled', accepted_at = ? WHERE id = ? AND status = 'open' AND agent_id IS NULL`)
      .run(agentId, nowIso(), id);
    return res.changes > 0;
  },
  listByManager(managerId: string): Session[] {
    return db.prepare(`SELECT * FROM sessions WHERE manager_id = ? ORDER BY created_at DESC`).all(managerId) as unknown as Session[];
  },
  listOpenByManager(managerId: string): Session[] {
    return db
      .prepare(`SELECT * FROM sessions WHERE manager_id = ? AND status = 'open' ORDER BY created_at DESC`)
      .all(managerId) as unknown as Session[];
  },
  /**
   * 1-based position of an open "get on the line" request within its manager's
   * live queue (FIFO by created_at). Returns null if the session isn't a waiting
   * live caller (already accepted, scheduled for later, or ended).
   */
  liveQueuePosition(session: Session): number | null {
    if (session.status !== 'open' || session.scheduled_at) return null;
    const row = db
      .prepare(
        `SELECT COUNT(*) n FROM sessions
         WHERE manager_id IS ? AND status = 'open' AND scheduled_at IS NULL AND created_at <= ?`,
      )
      .get(session.manager_id, session.created_at) as { n: number };
    return row.n > 0 ? row.n : 1;
  },
  setResolution(id: string, resolved: number, notes: string): void {
    db.prepare(`UPDATE sessions SET resolved = ?, agent_notes = ? WHERE id = ?`).run(resolved, notes, id);
  },
  setCustomerFeedback(id: string, rating: number | null, resolved: number | null, comment: string): void {
    db.prepare(`UPDATE sessions SET customer_rating = ?, customer_resolved = ?, customer_comment = ? WHERE id = ?`).run(
      rating,
      resolved,
      comment,
      id,
    );
  },
  listByAgent(agentId: string): Session[] {
    return db.prepare(`SELECT * FROM sessions WHERE agent_id = ? ORDER BY created_at DESC`).all(agentId) as unknown as Session[];
  },
  listAll(status?: SessionStatus): Session[] {
    if (status) {
      return db.prepare(`SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC`).all(status) as unknown as Session[];
    }
    return db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all() as unknown as Session[];
  },
  end(id: string, endedBy: string): void {
    db.prepare(`UPDATE sessions SET status = 'ended', ended_at = ?, ended_by = ? WHERE id = ? AND status != 'ended'`).run(
      nowIso(),
      endedBy,
      id,
    );
  },
};

/* ------------------------------ participants ------------------------------ */
export const participantRepo = {
  create(input: {
    sessionId: string;
    role: Role;
    displayName: string;
    phone?: string | null;
    email?: string | null;
    socketId?: string | null;
  }): Participant {
    const p: Participant = {
      id: newId(),
      session_id: input.sessionId,
      role: input.role,
      display_name: input.displayName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      socket_id: input.socketId ?? null,
      status: 'connected',
      joined_at: nowIso(),
      left_at: null,
    };
    db.prepare(
      `INSERT INTO participants (id, session_id, role, display_name, phone, email, socket_id, status, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.session_id, p.role, p.display_name, p.phone, p.email, p.socket_id, p.status, p.joined_at);
    return p;
  },
  findById(id: string): Participant | undefined {
    return db.prepare(`SELECT * FROM participants WHERE id = ?`).get(id) as unknown as Participant | undefined;
  },
  listBySession(sessionId: string): Participant[] {
    return db.prepare(`SELECT * FROM participants WHERE session_id = ? ORDER BY joined_at ASC`).all(sessionId) as unknown as Participant[];
  },
  listConnected(sessionId: string): Participant[] {
    return db
      .prepare(`SELECT * FROM participants WHERE session_id = ? AND status = 'connected' ORDER BY joined_at ASC`)
      .all(sessionId) as unknown as Participant[];
  },
  setStatus(id: string, status: ParticipantStatus): void {
    const leftAt = status === 'left' ? nowIso() : null;
    db.prepare(`UPDATE participants SET status = ?, left_at = COALESCE(?, left_at) WHERE id = ?`).run(status, leftAt, id);
  },
  setSocket(id: string, socketId: string | null): void {
    db.prepare(`UPDATE participants SET socket_id = ? WHERE id = ?`).run(socketId, id);
  },
};

/* ------------------------------ messages ------------------------------ */
export const messageRepo = {
  create(input: {
    sessionId: string;
    senderParticipantId: string | null;
    senderRole: string;
    senderName: string;
    body: string;
    fileId?: string | null;
  }): Message {
    const m: Message = {
      id: newId(),
      session_id: input.sessionId,
      sender_participant_id: input.senderParticipantId,
      sender_role: input.senderRole,
      sender_name: input.senderName,
      body: input.body,
      file_id: input.fileId ?? null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO messages (id, session_id, sender_participant_id, sender_role, sender_name, body, file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.session_id, m.sender_participant_id, m.sender_role, m.sender_name, m.body, m.file_id, m.created_at);
    return m;
  },
  listBySession(sessionId: string): Message[] {
    return db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as unknown as Message[];
  },
};

/* ------------------------------ files ------------------------------ */
export const fileRepo = {
  create(input: {
    sessionId: string;
    uploaderParticipantId: string | null;
    originalName: string;
    storedName: string;
    mime: string;
    size: number;
  }): FileRecord {
    const f: FileRecord = {
      id: newId(),
      session_id: input.sessionId,
      uploader_participant_id: input.uploaderParticipantId,
      original_name: input.originalName,
      stored_name: input.storedName,
      mime: input.mime,
      size: input.size,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO files (id, session_id, uploader_participant_id, original_name, stored_name, mime, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(f.id, f.session_id, f.uploader_participant_id, f.original_name, f.stored_name, f.mime, f.size, f.created_at);
    return f;
  },
  findById(id: string): FileRecord | undefined {
    return db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as unknown as FileRecord | undefined;
  },
};

/* ------------------------------ events ------------------------------ */
export const eventRepo = {
  log(input: { sessionId: string; type: string; participantId?: string | null; metadata?: unknown }): SessionEvent {
    const e: SessionEvent = {
      id: newId(),
      session_id: input.sessionId,
      type: input.type,
      participant_id: input.participantId ?? null,
      metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO events (id, session_id, type, participant_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.session_id, e.type, e.participant_id, e.metadata_json, e.created_at);
    return e;
  },
  listBySession(sessionId: string): SessionEvent[] {
    return db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as unknown as SessionEvent[];
  },
};

/* ------------------------------ recordings ------------------------------ */
export const recordingRepo = {
  create(sessionId: string): Recording {
    const r: Recording = {
      id: newId(),
      session_id: sessionId,
      status: 'recording',
      file_path: null,
      started_at: nowIso(),
      ended_at: null,
      duration_sec: null,
    };
    db.prepare(
      `INSERT INTO recordings (id, session_id, status, started_at) VALUES (?, ?, ?, ?)`,
    ).run(r.id, r.session_id, r.status, r.started_at);
    return r;
  },
  findById(id: string): Recording | undefined {
    return db.prepare(`SELECT * FROM recordings WHERE id = ?`).get(id) as unknown as Recording | undefined;
  },
  listBySession(sessionId: string): Recording[] {
    return db.prepare(`SELECT * FROM recordings WHERE session_id = ? ORDER BY started_at ASC`).all(sessionId) as unknown as Recording[];
  },
  findActive(sessionId: string): Recording | undefined {
    return db
      .prepare(`SELECT * FROM recordings WHERE session_id = ? AND status = 'recording' ORDER BY started_at DESC LIMIT 1`)
      .get(sessionId) as unknown as Recording | undefined;
  },
  setStatus(id: string, status: RecordingStatus): void {
    db.prepare(`UPDATE recordings SET status = ? WHERE id = ?`).run(status, id);
  },
  finalize(id: string, filePath: string, durationSec: number): void {
    db.prepare(`UPDATE recordings SET status = 'ready', file_path = ?, ended_at = ?, duration_sec = ? WHERE id = ?`).run(
      filePath,
      nowIso(),
      durationSec,
      id,
    );
  },
};
