// Verifies customer-chosen scheduling: an intake can carry a preferred call time,
// which is stored and surfaced on the track endpoint, the agent's available pool,
// and the public phone lookup. An ASAP request stays unscheduled (null).
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

const agentTok = (await j('/api/auth/login', { m: 'POST', b: { username: 'agent', password: 'agent123' } })).token;

// 1) Scheduled intake (tomorrow) is accepted and echoes the scheduled time.
const when = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const sched = await j('/api/intake', {
  m: 'POST',
  b: { name: 'Meera', phone: '+91 90000 11111', email: 'meera@example.com', problem: 'Schedule please', scheduledAt: when },
});
ok(!!sched.reference, `scheduled intake returns a reference (${sched.reference})`);
ok(sched.scheduledAt && Math.abs(new Date(sched.scheduledAt) - new Date(when)) < 1000, 'intake echoes the scheduled time');

// 2) Track endpoint exposes the scheduled time.
const t = await j(`/api/track/${sched.reference}`);
ok(t.found && t.scheduledAt && new Date(t.scheduledAt).getTime() === new Date(sched.scheduledAt).getTime(), 'track shows the scheduled time');

// 3) Agent's available pool carries the scheduled time.
const avail = await j('/api/tasks/available', { t: agentTok });
const mine = avail.find((x) => x.title === 'Schedule please' || (x.description || '').includes('Schedule'));
ok(mine && mine.scheduledAt, 'available task carries scheduledAt for the agent');

// 4) Phone lookup carries the scheduled time too.
const byPhone = await j('/api/track/by-phone?phone=9000011111');
ok(byPhone.found && byPhone.requests[0]?.scheduledAt, 'phone lookup carries scheduledAt');

// 5) An ASAP request (no time) stays unscheduled.
const asap = await j('/api/intake', { m: 'POST', b: { name: 'Raj', phone: '+91 90000 22222', email: 'raj@example.com', problem: 'Now please' } });
const t2 = await j(`/api/track/${asap.reference}`);
ok(asap.scheduledAt == null && t2.scheduledAt == null, 'ASAP request has no scheduled time (null)');

// 6) A past time is rejected (treated as ASAP, not stored).
const past = await j('/api/intake', {
  m: 'POST',
  b: { name: 'Old', phone: '+91 90000 33333', email: 'old@example.com', problem: 'Past time', scheduledAt: '2000-01-01T10:00:00.000Z' },
});
ok(past.scheduledAt == null, 'a past scheduled time is ignored (null)');

console.log(failures === 0 ? '\nPASS: SCHEDULING FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
