// Verifies the "no agent yet? schedule for later" path: a customer waiting in the
// live queue can convert their own open request into a scheduled one via their
// invite token. It then leaves the live queue and becomes a scheduled request.
// Once an agent has picked up (or the session is gone), scheduling is refused.
const B = 'http://localhost:3000';
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
const j = (p, o = {}) =>
  fetch(B + p, {
    method: o.m || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.t ? { Authorization: `Bearer ${o.t}` } : {}) },
    body: o.b ? JSON.stringify(o.b) : undefined,
  }).then((r) => r.json());
const raw = (p, o = {}) =>
  fetch(B + p, { method: o.m || 'GET', headers: { 'Content-Type': 'application/json', ...(o.t ? { Authorization: `Bearer ${o.t}` } : {}) }, body: o.b ? JSON.stringify(o.b) : undefined });

const agentTok = (await j('/api/auth/login', { m: 'POST', b: { username: 'agent', password: 'agent123' } })).token;
const tok = (joinUrl) => new URL(joinUrl, B).searchParams.get('token');
const when = new Date(Date.now() + 2 * 86400000).toISOString();

// 1) A live "get on the line" caller — in the queue, can schedule.
const c = await j('/api/intake', { m: 'POST', b: { name: 'Wait', phone: '+91 90000 55501', email: 'w@e.com', problem: 'On the line' } });
const t = tok(c.joinUrl);
let inv = await j(`/api/sessions/invite/${encodeURIComponent(t)}`);
ok(inv.queuePosition >= 1 && inv.canSchedule === true && !inv.scheduledAt, 'waiting caller is in the queue and can schedule');

// 2) Customer schedules it for later from the waiting room.
const r = await j(`/api/sessions/invite/${encodeURIComponent(t)}/schedule`, { m: 'POST', b: { scheduledAt: when } });
ok(r.ok && new Date(r.scheduledAt).getTime() === new Date(when).getTime(), 'scheduling from the waiting room succeeds');

// 3) It has now left the live queue and carries the scheduled time.
inv = await j(`/api/sessions/invite/${encodeURIComponent(t)}`);
ok(inv.scheduledAt && inv.queuePosition == null, 'after scheduling it leaves the live queue (no position)');

// 4) In the agent pool it is now a scheduled request, not a live one.
const avail = await j('/api/tasks/available', { t: agentTok });
const asScheduled = avail.find((x) => x.scheduledAt && x.id === inv.sessionId);
const asLive = avail.find((x) => !x.scheduledAt && x.id === inv.sessionId);
ok(!!asScheduled && !asLive, 'request appears as a scheduled task (not a live one) in the agent pool');

// 5) A past time is rejected.
const past = await raw(`/api/sessions/invite/${encodeURIComponent(t)}/schedule`, { m: 'POST', b: { scheduledAt: '2000-01-01T00:00:00.000Z' } });
ok(past.status === 400, `a past time is rejected (${past.status})`);

// 6) Once an agent picks it up, scheduling is refused.
await j(`/api/tasks/${inv.sessionId}/accept`, { m: 'POST', t: agentTok });
const afterAccept = await raw(`/api/sessions/invite/${encodeURIComponent(t)}/schedule`, { m: 'POST', b: { scheduledAt: when } });
ok(afterAccept.status === 409, `scheduling is refused after an agent accepts (${afterAccept.status})`);

console.log(failures === 0 ? '\nPASS: RESCHEDULE FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
