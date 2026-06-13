/**
 * Reconnect handling check (bonus 3.3). A participant drops and reconnects within
 * the grace window; we assert the OTHER party is never told they left, and that
 * the reconnecting participant re-enters the SAME slot (same participant id).
 *
 * Run with the server up:  node scripts/reconnect-check.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), timeout);
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
  return res.json().catch(() => null);
}

async function main() {
  const { token } = await http('/api/auth/login', { method: 'POST', body: { username: 'agent', password: 'agent123' } });
  const mgr = await http('/api/auth/login', { method: 'POST', body: { username: 'manager', password: 'manager123' } });
  const task = await http('/api/tasks', { method: 'POST', token: mgr.token, body: { title: 'Reconnect check' } });
  const accepted = await http(`/api/tasks/${task.id}/accept`, { method: 'POST', token });
  const sessionId = task.id;
  const invite = new URL(accepted.inviteUrl).searchParams.get('token');

  const agent = io(BASE, { auth: { token, sessionId, displayName: 'Agent' }, transports: ['websocket'] });
  await once(agent, 'joined');

  let agentSawLeft = false;
  agent.on('participant-left', () => {
    agentSawLeft = true;
  });

  // Customer joins.
  const customer = io(BASE, { auth: { token: invite, displayName: 'Customer' }, transports: ['websocket'], reconnection: false });
  const joined = await once(customer, 'joined');
  const pid = joined.participantId;
  ok(!!pid, 'customer joined with a participant id');

  await wait(300);

  // Simulate an unexpected drop.
  customer.disconnect();
  console.log('... customer dropped; reconnecting within grace window');
  await wait(2000); // well within the default 15s grace

  // Reconnect presenting the same participant id.
  const customer2 = io(BASE, {
    auth: { token: invite, displayName: 'Customer', participantId: pid },
    transports: ['websocket'],
    reconnection: false,
  });
  const rejoined = await once(customer2, 'joined');

  ok(rejoined.participantId === pid, 'reconnected into the SAME participant slot');
  ok(rejoined.reconnected === true, 'server flagged the join as a reconnect');

  // Give any (incorrect) leave broadcast time to arrive.
  await wait(1500);
  ok(agentSawLeft === false, 'agent was NOT notified of the drop (seamless reconnect)');

  agent.close();
  customer2.close();
  await wait(300);
  console.log(failures === 0 ? '\nPASS: RECONNECT PASS' : `\nFAIL: RECONNECT FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('crashed', e);
  process.exit(1);
});
