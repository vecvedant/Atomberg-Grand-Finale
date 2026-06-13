/** Shared domain types mirroring the SQLite schema rows. */

export type Role = 'agent' | 'customer';
export type AccountRole = 'agent' | 'manager' | 'admin';
export type SessionStatus = 'open' | 'active' | 'ended' | 'scheduled';
export type ParticipantStatus = 'connected' | 'disconnected' | 'left';
export type RecordingStatus = 'recording' | 'processing' | 'ready' | 'failed';

export interface Agent {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: AccountRole;
  manager_id: string | null;
  employee_id: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  title: string;
  description: string;
  manager_id: string | null;
  agent_id: string | null;
  created_by: string | null;
  status: SessionStatus;
  invite_token: string;
  scheduled_at: string | null;
  accepted_at: string | null;
  created_at: string;
  ended_at: string | null;
  ended_by: string | null;
  resolved: number | null;
  agent_notes: string | null;
  customer_rating: number | null;
  customer_resolved: number | null;
  customer_comment: string | null;
  source: string;
  requester_name: string | null;
  requester_phone: string | null;
  requester_email: string | null;
  purchase_date: string | null;
  warranty_status: string | null;
  warranty_auto: number | null;
  bill_file_id: string | null;
  ref: string | null;
}

export interface Participant {
  id: string;
  session_id: string;
  role: Role;
  display_name: string;
  phone: string | null;
  email: string | null;
  socket_id: string | null;
  status: ParticipantStatus;
  joined_at: string;
  left_at: string | null;
}

export interface Message {
  id: string;
  session_id: string;
  sender_participant_id: string | null;
  sender_role: string;
  sender_name: string;
  body: string;
  file_id: string | null;
  created_at: string;
}

export interface FileRecord {
  id: string;
  session_id: string;
  uploader_participant_id: string | null;
  original_name: string;
  stored_name: string;
  mime: string;
  size: number;
  created_at: string;
}

export interface SessionEvent {
  id: string;
  session_id: string;
  type: string;
  participant_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface Recording {
  id: string;
  session_id: string;
  status: RecordingStatus;
  file_path: string | null;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
}

/** JWT payload shapes. */
export interface AccountTokenPayload {
  sub: string; // agent id
  username: string;
  role: AccountRole;
  kind: 'account';
}

export interface InviteTokenPayload {
  sessionId: string;
  role: 'customer';
  kind: 'invite';
}
