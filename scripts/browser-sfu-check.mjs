/**
 * Phase 2 HARD GATE — real-browser proof. Two Chromium tabs with FAKE camera/mic
 * drive the ACTUAL product UI: an agent creates a session, a customer joins via
 * the invite link, and we assert through getStats() that real RTP media flows
 * BOTH ways through the server SFU — plus a live chat round-trip.
 *
 *   Agent cam  → server → Customer   (customer inbound video bytes > 0)
 *   Customer cam → server → Agent     (agent inbound video bytes > 0)
 *
 * Run with the server up:  node scripts/browser-sfu-check.mjs
 */
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const loginAs = (username, password) =>
  fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((r) => r.json());
const login = () => loginAs('agent', 'agent123');

async function statsOf(page) {
  return page.evaluate(async () => {
    const pc = window.__call?.media?.pc;
    if (!pc) return { connState: 'no-pc', inV: 0, inA: 0, outV: 0 };
    const stats = await pc.getStats();
    let inV = 0,
      inA = 0,
      outV = 0;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp') {
        if (r.kind === 'video') inV += r.bytesReceived || 0;
        else inA += r.bytesReceived || 0;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'video') outV += r.bytesSent || 0;
    });
    return { connState: pc.connectionState, inV, inA, outV };
  });
}

async function remoteVideoLive(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    // The remote tile's video is the non-muted one with real dimensions.
    return vids.some((v) => !v.muted && v.videoWidth > 0 && v.videoHeight > 0);
  });
}

async function main() {
  const { token, user } = await login();
  const { token: managerTok } = await loginAs('manager', 'manager123');
  ok(!!token, 'agent logged in (REST)');
  // Manager posts a task into the pool for the agent to accept.
  await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerTok}` },
    body: JSON.stringify({ title: 'Gate task', description: 'media gate' }),
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 120000,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  try {
    // ---- Agent tab ----
    const agent = await browser.newPage();
    agent.on('pageerror', (e) => console.log('  [agent pageerror]', e.message));
    await agent.evaluateOnNewDocument(
      (t, u) => {
        localStorage.setItem('auth_token', t);
        localStorage.setItem('auth_user', u);
      },
      token,
      JSON.stringify(user),
    );
    await agent.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    // Accept the pooled task -> starts the call. The console splits the pool into a
    // live queue ("Pick up" on the front caller) and scheduled requests ("Accept").
    const TASK_BTN = '#liveQueueList button, #scheduledList button';
    await agent.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].some((b) => /Pick up|Accept/.test(b.textContent)),
      { timeout: 10000 },
      TASK_BTN,
    );
    await agent.evaluate((sel) => [...document.querySelectorAll(sel)].find((b) => /Pick up|Accept/.test(b.textContent)).click(), TASK_BTN);
    await agent.waitForFunction(() => document.getElementById('inviteUrl')?.value.includes('token='), { timeout: 10000 });
    const inviteUrl = await agent.$eval('#inviteUrl', (el) => el.value);
    ok(!!inviteUrl, 'agent accepted a pooled task and got the invite link');

    // ---- Customer tab ----
    const customer = await browser.newPage();
    customer.on('pageerror', (e) => console.log('  [customer pageerror]', e.message));
    await customer.goto(inviteUrl, { waitUntil: 'networkidle0' });
    await customer.waitForSelector('#joinBtn', { visible: true, timeout: 8000 });
    await customer.type('#displayName', 'John Doe');
    await customer.type('#phone', '+91 98765 43210');
    await customer.type('#email', 'john@example.com');
    await customer.click('#joinBtn');
    ok(true, 'customer opened invite and joined');

    // ---- Wait for bidirectional media ----
    console.log('... waiting for media to flow both ways (getStats polling)');
    let a = { inV: 0 },
      c = { inV: 0 };
    for (let i = 0; i < 20; i++) {
      await wait(1000);
      a = await statsOf(agent);
      c = await statsOf(customer);
      if (a.inV > 0 && c.inV > 0) break;
    }
    console.log('  agent  stats:', a);
    console.log('  customer stats:', c);

    ok(a.connState === 'connected', `agent PC connected to server (${a.connState})`);
    ok(c.connState === 'connected', `customer PC connected to server (${c.connState})`);
    ok(c.inV > 0, `AGENT cam → server → CUSTOMER video (${c.inV} bytes)`);
    ok(a.inV > 0, `CUSTOMER cam → server → AGENT video (${a.inV} bytes)`);
    ok(c.inA > 0, `AGENT mic → server → CUSTOMER audio (${c.inA} bytes)`);
    ok(a.inA > 0, `CUSTOMER mic → server → AGENT audio (${a.inA} bytes)`);

    // Poll for a painted frame (decode lags the first bytes by a moment).
    let agentPaints = false;
    let customerPaints = false;
    for (let i = 0; i < 10; i++) {
      agentPaints = agentPaints || (await remoteVideoLive(agent));
      customerPaints = customerPaints || (await remoteVideoLive(customer));
      if (agentPaints && customerPaints) break;
      await wait(800);
    }
    ok(agentPaints, 'agent renders live remote video (videoWidth > 0)');
    ok(customerPaints, 'customer renders live remote video (videoWidth > 0)');

    // ---- Chat round-trip ----
    await agent.type('#composerInput', 'Can you see my screen?');
    await agent.keyboard.press('Enter');
    const gotChat = await customer
      .waitForFunction(() => document.querySelector('#messages')?.textContent.includes('Can you see my screen?'), {
        timeout: 5000,
      })
      .then(() => true)
      .catch(() => false);
    ok(gotChat, 'chat message delivered agent → customer in real time');

    // Note: file sharing, recording, and admin each have dedicated, deterministic
    // tests (scripts/file-check.mjs, recording-check.mjs, and admin via REST) that
    // don't depend on headless-Chromium DOM timing under load. This script is the
    // focused media + chat gate.

    await browser.close();
  } catch (err) {
    console.error('FAIL: browser test error:', err.message);
    failures++;
    await browser.close();
  }

  console.log(
    failures === 0
      ? '\nPASS: SFU GATE PASS (real browsers) — bidirectional A/V + chat through the server'
      : `\nFAIL: SFU GATE FAIL (${failures} failures)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('crashed:', err);
  process.exit(1);
});
