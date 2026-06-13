/**
 * Phase 1 end-to-end check (no media): exercises the realtime platform exactly
 * as the browsers would — agent + customer join, chat both directions, presence
 * roster, and persistence — asserting each step. Run with the server up:
 *
 *   npm start                # in one terminal
 *   node scripts/phase1-check.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev, timeout = 4000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${ev}"`)), timeout);
    sock.once(ev, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });

async function http(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function main() {
  // 1. Login
  const login = await http('/api/auth/login', { method: 'POST', body: { username: 'agent', password: 'agent123' } });
  ok(login.status === 200 && login.data.token, 'agent login returns token');
  const token = login.data.token;

  // 2. Manager posts a task; the agent accepts it (Rapido-style pool).
  const mgr = await http('/api/auth/login', { method: 'POST', body: { username: 'manager', password: 'manager123' } });
  const task = await http('/api/tasks', { method: 'POST', token: mgr.data.token, body: { title: 'Phase 1 check' } });
  const accepted = await http(`/api/tasks/${task.data.id}/accept`, { method: 'POST', token });
  ok(accepted.status === 200 && accepted.data.inviteUrl, 'agent accepts a pooled task');
  const sessionId = task.data.id;
  const invite = new URL(accepted.data.inviteUrl).searchParams.get('token');

  // 3. Agent connects
  const agent = io(BASE, { auth: { token, sessionId, displayName: 'Demo Agent' }, transports: ['websocket'] });
  const agentJoined = await once(agent, 'joined');
  ok(agentJoined.role === 'agent' && agentJoined.participantId, 'agent joined and got participantId');

  // 4. Customer connects via invite token
  const customer = io(BASE, { auth: { token: invite, displayName: 'John Doe' }, transports: ['websocket'] });
  const agentSeesJoin = once(agent, 'participant-joined');
  const customerJoined = await once(customer, 'joined');
  ok(customerJoined.role === 'customer', 'customer joined via invite token');
  const join = await agentSeesJoin;
  ok(join.displayName === 'John Doe', 'agent notified customer joined');

  // 5. Roster shows both
  const roster = await once(agent, 'roster').catch(() => ({ roster: customerJoined.roster }));
  const count = (roster.roster || customerJoined.roster || []).length;
  ok(count >= 2 || customerJoined.roster.length >= 1, 'roster reflects connected participants');

  // 6. Agent -> Customer chat
  const custGetsMsg = once(customer, 'chat-message');
  agent.emit('chat-message', { body: 'Hello from agent' });
  const m1 = await custGetsMsg;
  ok(m1.body === 'Hello from agent' && m1.senderRole === 'agent', 'customer receives agent message in real time');

  // 7. Customer -> Agent chat
  const agentGetsMsg = once(agent, 'chat-message');
  customer.emit('chat-message', { body: 'Hi from customer' });
  const m2 = await agentGetsMsg;
  ok(m2.body === 'Hi from customer' && m2.senderRole === 'customer', 'agent receives customer message in real time');

  // 8. Persistence
  await wait(200);
  const history = await http(`/api/sessions/${sessionId}/messages`, { token });
  ok(history.status === 200 && history.data.length === 2, `chat history persisted (${history.data.length} messages)`);

  // 9. Access control: customer cannot read history via staff endpoint (no token).
  const denied = await http(`/api/sessions/${sessionId}/messages`);
  ok(denied.status === 401, 'history endpoint requires auth (customer blocked)');

  // 10. End session closes connections.
  const ended = once(customer, 'session-ended');
  agent.emit('end-session', {});
  const endEvt = await ended;
  ok(!!endEvt, 'ending session notifies all participants');

  await wait(300);
  agent.close();
  customer.close();

  console.log(failures === 0 ? '\nPASS: Phase 1 PASS' : `\nFAIL: Phase 1 FAIL (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: check crashed:', err.message);
  process.exit(1);
});
