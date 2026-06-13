// Verifies the public customer-intake flow: submit (with bill) auto-creates a
// task in the least-loaded manager's pool, computes warranty, the agent sees it
// in the available pool and can accept + join, and admin sees the details.
const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
async function http(p, o = {}) {
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const login = (u, p) => http('/api/auth/login', { method: 'POST', body: { username: u, password: p } }).then((r) => r.data.token);

const agentTok = await login('agent', 'agent123');
const adminTok = await login('admin', 'admin123');

// 1. Submit the public intake form (multipart, with a bill photo, in-warranty date).
const recentPurchase = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); // 30 days ago
const fd = new FormData();
fd.append('name', 'Asha Rao');
fd.append('phone', '+91 90000 11111');
fd.append('email', 'asha@example.com');
fd.append('problem', 'Ceiling fan wobbles badly after installation.');
fd.append('purchaseDate', recentPurchase);
fd.append('warranty', 'unsure');
fd.append('bill', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'bill.png');
const submit = await fetch(`${BASE}/api/intake`, { method: 'POST', body: fd });
const sub = await submit.json();
ok(submit.status === 201 && sub.joinUrl, `intake submitted, got join link (${submit.status})`);
ok(sub.routed === true, 'request auto-routed to a manager');
ok(sub.warrantyAuto === 1, `warranty auto-computed as in-warranty for a recent purchase (got ${sub.warrantyAuto})`);

// 2. The agent under that manager sees it in the available pool, with intake details.
const avail = await http('/api/tasks/available', { token: agentTok });
const task = (avail.data || [])[0];
ok(!!task && task.source === 'intake', 'agent sees the self-service task in their pool');
ok(task && task.warrantyStatus === 'unsure' && task.warrantyAuto === 1 && !!task.billFileId, 'task carries warranty + bill to the agent');

// 3. Agent accepts and the contact/bill come through.
const accept = await http(`/api/tasks/${task.id}/accept`, { method: 'POST', token: agentTok });
ok(accept.status === 200 && accept.data.requesterName === 'Asha Rao' && !!accept.data.billFileId, 'accept returns requester + bill');

// 4. The invite link prefills the customer's submitted details.
const invite = new URL(accept.data.inviteUrl).searchParams.get('token');
const inv = await http(`/api/sessions/invite/${invite}`);
ok(inv.data.requesterName === 'Asha Rao' && inv.data.requesterPhone === '+91 90000 11111', 'invite validation prefills requester details');

// 5. Bill photo is downloadable by the assigned agent.
const dl = await fetch(`${BASE}/api/files/${accept.data.billFileId}?token=${encodeURIComponent(agentTok)}`);
ok(dl.status === 200, `agent can view the uploaded bill (${dl.status})`);

// 6. Admin sees the full intake record.
const detail = await http(`/api/admin/sessions/${task.id}`, { token: adminTok });
const s = detail.data.session;
ok(s.source === 'intake' && s.requester_email === 'asha@example.com' && s.warranty_auto === 1, 'admin sees the intake record with warranty + contact');

// 7. An out-of-warranty purchase is flagged.
const oldPurchase = new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10); // ~2.2 years ago
const fd2 = new FormData();
fd2.append('name', 'Old Bill');
fd2.append('phone', '+91 90000 22222');
fd2.append('email', 'old@example.com');
fd2.append('problem', 'Remote stopped working.');
fd2.append('purchaseDate', oldPurchase);
const sub2 = await (await fetch(`${BASE}/api/intake`, { method: 'POST', body: fd2 })).json();
ok(sub2.warrantyAuto === 0, `old purchase auto-flagged out of warranty (got ${sub2.warrantyAuto})`);

console.log(failures === 0 ? '\nPASS: INTAKE PASS' : `\nFAIL: INTAKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
