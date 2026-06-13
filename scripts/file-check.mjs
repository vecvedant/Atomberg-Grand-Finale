// Isolates file-sharing server behavior (no browser): upload via HTTP, reference
// in a chat message, assert the peer receives the message with file metadata.
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
const once = (s, ev, t = 5000) =>
  new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout ' + ev)), t);
    s.once(ev, (d) => {
      clearTimeout(to);
      res(d);
    });
  });
const http = async (p, o = {}) => {
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return r.json().catch(() => null);
};

const { token } = await http('/api/auth/login', { method: 'POST', body: { username: 'agent', password: 'agent123' } });
const mgr = await http('/api/auth/login', { method: 'POST', body: { username: 'manager', password: 'manager123' } });
const task = await http('/api/tasks', { method: 'POST', token: mgr.token, body: { title: 'File check' } });
const accepted = await http(`/api/tasks/${task.id}/accept`, { method: 'POST', token });
const sessionId = task.id;
const invite = new URL(accepted.inviteUrl).searchParams.get('token');

const agent = io(BASE, { auth: { token, sessionId, displayName: 'Agent' }, transports: ['websocket'] });
await once(agent, 'joined');
const customer = io(BASE, { auth: { token: invite, displayName: 'Customer' }, transports: ['websocket'] });
const cj = await once(customer, 'joined');

// Upload as the customer via multipart.
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'photo.png');
fd.append('participantId', cj.participantId);
const up = await fetch(`${BASE}/api/files/${sessionId}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${invite}` }, body: fd });
const upData = await up.json();
ok(up.status === 201 && upData.id, `file uploaded (${up.status})`);

// Reject a disallowed type.
const fd2 = new FormData();
fd2.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-msdownload' }), 'evil.exe');
const up2 = await fetch(`${BASE}/api/files/${sessionId}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${invite}` }, body: fd2 });
ok(up2.status === 400, `disallowed MIME rejected (${up2.status})`);

// Customer shares it in chat; agent must receive it with file metadata.
const agentGets = once(agent, 'chat-message');
customer.emit('chat-message', { fileId: upData.id, body: '' });
const msg = await agentGets;
ok(msg.file && msg.file.name === 'photo.png', `agent received chat message with file (${msg.file?.name})`);

// Download must work for the agent, and require auth.
const dl = await fetch(`${BASE}/api/files/${upData.id}?token=${encodeURIComponent(token)}`);
ok(dl.status === 200, `agent can download shared file (${dl.status})`);
const noAuth = await fetch(`${BASE}/api/files/${upData.id}`);
ok(noAuth.status === 401, `download without token blocked (${noAuth.status})`);

agent.close();
customer.close();
setTimeout(() => {
  console.log(failures === 0 ? '\nPASS: FILE SHARING PASS' : `\nFAIL: FILE SHARING FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}, 300);
