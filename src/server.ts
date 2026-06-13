/**
 * Application entrypoint: wires Express (REST + static client), Socket.IO
 * (signaling/chat), the metrics endpoint, and the realtime layer together.
 */
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.ts';
import './db/index.ts'; // applies schema on import
import { logger } from './util/logger.ts';
import { registry, metrics } from './metrics/metrics.ts';
import { authRouter } from './api/auth.ts';
import { sessionsRouter } from './api/sessions.ts';
import { tasksRouter } from './api/tasks.ts';
import { intakeRouter } from './api/intake.ts';
import { trackRouter } from './api/track.ts';
import { filesRouter } from './api/files.ts';
import { recordingsRouter } from './api/recordings.ts';
import { managerRouter } from './api/manager.ts';
import { adminRouter } from './api/admin.ts';
import { setupRealtime, refreshGauges } from './realtime/index.ts';

const log = logger('server');
const app = express();

// Security headers with a CSP tight enough to be meaningful but compatible with
// the same-origin vanilla client, Socket.IO websocket, and WebRTC media blobs.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Throttle login attempts (brute-force protection).
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', loginLimiter);
// Throttle the public intake form (abuse protection — it's unauthenticated).
const intakeLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/intake', intakeLimiter);
// Throttle public reference lookups (guards against brute-forcing references).
const trackLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/track', trackLimiter);

// REST API.
app.use('/api/auth', authRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/intake', intakeRouter);
app.use('/api/track', trackRouter);
app.use('/api/files', filesRouter);
app.use('/api/recordings', recordingsRouter);
app.use('/api/manager', managerRouter);
app.use('/api/admin', adminRouter);

// Health + metrics.
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// Static client (vanilla JS, no build step).
app.use(express.static(config.paths.public));
app.get('/', (_req, res) => res.redirect('/index.html'));

const server = http.createServer(app);
const io = new SocketServer(server, { maxHttpBufferSize: 1e6 });
setupRealtime(io);
refreshGauges();

server.listen(config.port, config.host, () => {
  log.info(`listening on ${config.publicBaseUrl}`);
  if (config.usingGeneratedSecret) {
    log.warn('JWT_SECRET not set — using a random secret (tokens reset on restart). Set JWT_SECRET in .env for stability.');
  }
});

// Surface unexpected errors instead of dying silently.
process.on('unhandledRejection', (reason) => {
  metrics.errorsTotal.inc({ kind: 'unhandledRejection' });
  log.error('unhandledRejection', reason instanceof Error ? reason.message : String(reason));
});
