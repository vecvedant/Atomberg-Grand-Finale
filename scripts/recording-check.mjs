/**
 * Recording proof (bonus 3.1), lean + low CDP pressure. Two fake-media browsers
 * establish a call; the agent records via socket; we then verify over REST that
 * the recording finalizes to "ready" and downloads as a valid WebM file.
 *
 * Run with the server up:  node scripts/recording-check.mjs
 */
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const loginAs = (username, password) =>
  fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((r) => r.json());
const login = () => loginAs('agent', 'agent123');

async function main() {
  const { token, user } = await login();
  const { token: managerTok } = await loginAs('manager', 'manager123');
  await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerTok}` },
    body: JSON.stringify({ title: 'Recording task', description: 'recording test' }),
  });
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 180000,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });

  try {
    const agent = await browser.newPage();
    await agent.evaluateOnNewDocument(
      (t, u) => {
        localStorage.setItem('auth_token', t);
        localStorage.setItem('auth_user', u);
      },
      token,
      JSON.stringify(user),
    );
    await agent.goto(`${BASE}/agent.html`, { waitUntil: 'networkidle0' });
    await agent.waitForFunction(
      () => [...document.querySelectorAll('#availableList button')].some((b) => b.textContent === 'Accept'),
      { timeout: 10000 },
    );
    await agent.evaluate(() => [...document.querySelectorAll('#availableList button')].find((b) => b.textContent === 'Accept').click());
    await agent.waitForFunction(() => document.getElementById('inviteUrl')?.value.includes('token='), { timeout: 10000 });
    const inviteUrl = await agent.$eval('#inviteUrl', (el) => el.value);
    const sessionId = await agent.evaluate(() => window.__call?.cfg?.sessionId);

    const customer = await browser.newPage();
    await customer.goto(inviteUrl, { waitUntil: 'networkidle0' });
    await customer.waitForSelector('#joinBtn', { visible: true, timeout: 8000 });
    await customer.type('#displayName', 'John Doe');
    await customer.type('#phone', '+91 98765 43210');
    await customer.type('#email', 'john@example.com');
    await customer.click('#joinBtn');
    ok(true, 'two-party call established');

    // Let media flow for a few seconds so there is something to record.
    await wait(6000);

    // Start recording via the socket (less CDP chatter than clicking).
    const startRes = await agent.evaluate(
      () => new Promise((res) => window.__call.socket.emit('start-recording', {}, res)),
    );
    ok(startRes?.ok, `recording started (id: ${startRes?.recordingId})`);

    await wait(5000); // record ~5s of the call

    const stopRes = await agent.evaluate(() => new Promise((res) => window.__call.socket.emit('stop-recording', {}, res)));
    ok(stopRes?.ok, `recording stopped (status: ${stopRes?.status})`);

    // Poll REST until the recording is finalized.
    let rec = null;
    for (let i = 0; i < 25; i++) {
      await wait(1000);
      const rr = await fetch(`${BASE}/api/recordings/${startRes.recordingId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
      rec = rr;
      if (rec.status === 'ready') break;
    }
    ok(rec?.status === 'ready', `recording finalized → ready (status: ${rec?.status}, ${rec?.durationSec}s)`);

    // Download + validate it is a real WebM (EBML magic 1A 45 DF A3).
    const dl = await fetch(`${BASE}/api/recordings/${startRes.recordingId}/download`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await dl.arrayBuffer());
    const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    ok(dl.status === 200 && isWebm && buf.length > 1000, `downloads as valid WebM (${buf.length} bytes, webm=${isWebm})`);

    // Non-owner cannot download (access control).
    const noauth = await fetch(`${BASE}/api/recordings/${startRes.recordingId}/download`);
    ok(noauth.status === 401, `download requires auth (${noauth.status})`);

    await browser.close();
  } catch (err) {
    console.error('FAIL: error:', err.message);
    failures++;
    await browser.close();
  }

  console.log(failures === 0 ? '\nPASS: RECORDING PASS' : `\nFAIL: RECORDING FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('crashed', e);
  process.exit(1);
});
