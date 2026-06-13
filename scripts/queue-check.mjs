// Verifies the "Get on the line" live-queue model: immediate (unscheduled) intakes
// become live-queue callers with a FIFO position exposed on the invite endpoint;
// scheduled requests are NOT in the live queue; the agent's available pool still
// carries both kinds so the console can split them.
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

// Two "get on the line" callers, in order.
const c1 = await j('/api/intake', { m: 'POST', b: { name: 'First', phone: '+91 90000 00001', email: 'a@e.com', problem: 'On the line 1' } });
const c2 = await j('/api/intake', { m: 'POST', b: { name: 'Second', phone: '+91 90000 00002', email: 'b@e.com', problem: 'On the line 2' } });
// One scheduled-for-later caller (should NOT be in the live queue).
const when = new Date(Date.now() + 86400000).toISOString();
const s1 = await j('/api/intake', { m: 'POST', b: { name: 'Later', phone: '+91 90000 00003', email: 'c@e.com', problem: 'Booked', scheduledAt: when } });

const tok = (joinUrl) => new URL(joinUrl, B).searchParams.get('token');
const inv = (joinUrl) => j(`/api/sessions/invite/${encodeURIComponent(tok(joinUrl))}`);

// 1) FIFO positions for the two live callers.
const i1 = await inv(c1.joinUrl);
const i2 = await inv(c2.joinUrl);
ok(i1.queuePosition === 1, `first live caller is position 1 (${i1.queuePosition})`);
ok(i2.queuePosition === 2, `second live caller is position 2 (${i2.queuePosition})`);

// 2) Scheduled caller has NO live-queue position.
const is = await inv(s1.joinUrl);
ok(is.queuePosition == null && is.scheduledAt, 'scheduled caller is not in the live queue (no position)');

// 3) Agent pool carries both, distinguishable by scheduledAt.
const avail = await j('/api/tasks/available', { t: agentTok });
const live = avail.filter((t) => !t.scheduledAt);
const sched = avail.filter((t) => t.scheduledAt);
ok(live.length >= 2, `live (unscheduled) tasks present for the console (${live.length})`);
ok(sched.length >= 1, `scheduled tasks present for the console (${sched.length})`);

// 4) After the front caller is picked up, the next caller moves to position 1.
const front = live.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
await j(`/api/tasks/${front.id}/accept`, { m: 'POST', t: agentTok });
const i2b = await inv(c2.joinUrl);
const i1b = await inv(c1.joinUrl);
ok(i1b.accepted === true && i1b.queuePosition == null, 'picked-up caller leaves the queue');
ok(i2b.queuePosition === 1, `next caller advances to position 1 (${i2b.queuePosition})`);

console.log(failures === 0 ? '\nPASS: LIVE QUEUE FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
