/**
 * Central configuration, loaded from environment with safe local-dev defaults.
 * Everything here is intentionally runnable out-of-the-box with zero setup.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// A random secret is generated if none is provided so the app still runs, but
// tokens won't survive a restart in that case — fine for a demo, flagged in README.
const jwtSecret = process.env.JWT_SECRET || randomBytes(32).toString('hex');

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',

  jwtSecret,
  sessionTokenTtl: process.env.SESSION_TOKEN_TTL || '12h',
  inviteTokenTtl: process.env.INVITE_TOKEN_TTL || '24h',

  reconnectGraceMs: int('RECONNECT_GRACE_MS', 15_000),
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
  // Default product warranty length, used to auto-suggest in-warranty status.
  warrantyMonths: int('WARRANTY_MONTHS', 12),

  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${int('PORT', 3000)}`,

  paths: {
    data: path.join(ROOT_DIR, 'data'),
    db: path.join(ROOT_DIR, 'data', 'app.db'),
    recordings: path.join(ROOT_DIR, 'recordings'),
    uploads: path.join(ROOT_DIR, 'uploads'),
    public: path.join(ROOT_DIR, 'public'),
  },

  usingGeneratedSecret: !process.env.JWT_SECRET,
} as const;

export type Config = typeof config;
