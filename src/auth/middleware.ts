/**
 * Express auth guards. Access control is enforced server-side here — the client
 * is never trusted to assert its own role.
 *
 *   requireAccount()      -> any logged-in agent or admin
 *   requireRole('admin')  -> admin only
 *   requireRole('agent')  -> agent only
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyAccountToken } from './tokens.ts';
import type { AccountRole, AccountTokenPayload } from '../types.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: AccountTokenPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  // Allow token via query for convenience on download links (still verified below).
  if (typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function requireAccount(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const payload = token ? verifyAccountToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.account = payload;
  next();
}

export function requireRole(role: AccountRole) {
  return requireRoles(role);
}

/** Allow access if the caller holds any of the given roles. */
export function requireRoles(...roles: AccountRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractToken(req);
    const payload = token ? verifyAccountToken(token) : null;
    if (!payload) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(payload.role)) {
      res.status(403).json({ error: `Forbidden: requires ${roles.join(' or ')}` });
      return;
    }
    req.account = payload;
    next();
  };
}
