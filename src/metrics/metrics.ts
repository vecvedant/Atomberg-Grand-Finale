/**
 * Operational metrics in Prometheus format (bonus 3.5). Exposed at /metrics so
 * standard monitoring tools (Prometheus, Grafana agent, etc.) can scrape it.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  activeSessions: new Gauge({
    name: 'support_active_sessions',
    help: 'Number of currently active support sessions',
    registers: [registry],
  }),
  connectedParticipants: new Gauge({
    name: 'support_connected_participants',
    help: 'Number of currently connected participants across all sessions',
    registers: [registry],
  }),
  sessionsCreatedTotal: new Counter({
    name: 'support_sessions_created_total',
    help: 'Total sessions created since start',
    registers: [registry],
  }),
  messagesTotal: new Counter({
    name: 'support_chat_messages_total',
    help: 'Total chat messages sent',
    registers: [registry],
  }),
  errorsTotal: new Counter({
    name: 'support_errors_total',
    help: 'Total handled errors',
    labelNames: ['kind'] as const,
    registers: [registry],
  }),
  callDurationSeconds: new Histogram({
    name: 'support_call_duration_seconds',
    help: 'Distribution of session durations in seconds',
    buckets: [10, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  }),
};
