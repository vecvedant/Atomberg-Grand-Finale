/**
 * JWT issuance/verification for the two token kinds in the system:
 *   - account tokens: agent/admin login sessions (full credentials)
 *   - invite tokens:  customer access scoped to a single session id
 * Both are signed with the same server secret. `kind` discriminates them so an
 * invite token can never be replayed as an account token.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import type { Agent, AccountTokenPayload, InviteTokenPayload } from '../types.ts';

export function signAccountToken(agent: Agent): string {
  const payload: AccountTokenPayload = {
    sub: agent.id,
    username: agent.username,
    role: agent.role,
    kind: 'account',
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.sessionTokenTtl as jwt.SignOptions['expiresIn'] });
}

export function signInviteToken(sessionId: string): string {
  const payload: InviteTokenPayload = { sessionId, role: 'customer', kind: 'invite' };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.inviteTokenTtl as jwt.SignOptions['expiresIn'] });
}

export function verifyAccountToken(token: string): AccountTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AccountTokenPayload;
    return decoded.kind === 'account' ? decoded : null;
  } catch {
    return null;
  }
}

export function verifyInviteToken(token: string): InviteTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as InviteTokenPayload;
    return decoded.kind === 'invite' && decoded.role === 'customer' ? decoded : null;
  } catch {
    return null;
  }
}
