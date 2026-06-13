// Verifies the customer "track my request" flow: a reference is issued on intake,
// the public track endpoint returns a privacy-safe status that updates as an agent
// accepts, and the track page surfaces the timeline + a gated Join button.
import puppeteer from 'puppeteer';

const B = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
const j = (p, o = {}) =>
  fetch(B + p, { method: o.m || 'GET', headers: { 'Content-Type': 'application/json', ...(o.t ? { Authorization: `Bearer ${o.t}` } : {}) }, body: o.b ? JSON.stringify(o.b) : undefined }).then(
    (r) => r.json(),
  );

const agentTok = (await j('/api/auth/login', { m: 'POST', b: { username: 'agent', password: 'agent123' } })).token;

// 1) Submit intake -> get a reference.
const sub = await j('/api/intake', { m: 'POST', b: { name: 'Asha', phone: '+91 90000 00001', email: 'asha@example.com', problem: 'Fan noisy' } });
ok(/^[A-Z0-9]{8}$/.test(sub.reference || ''), `intake returns an 8-char reference (${sub.reference})`);

// 2) Public track lookup -> found, not accepted, no contact details leaked.
let t = await j(`/api/track/${sub.reference}`);
ok(t.found && t.status === 'open' && t.accepted === false, `track shows received/not-accepted (status=${t.status})`);
ok(t.requesterEmail === undefined && t.requesterPhone === undefined, 'track does NOT expose contact details');
ok(!!t.joinUrl, 'track provides a join link');

// 3) Bad reference -> 404 not found.
const bad = await fetch(`${B}/api/track/ZZZZZZZZ`);
ok(bad.status === 404, `unknown reference returns 404 (${bad.status})`);

// 4) Agent accepts -> track flips to accepted.
const avail = await j('/api/tasks/available', { t: agentTok });
await j(`/api/tasks/${avail[0].id}/accept`, { m: 'POST', t: agentTok });
t = await j(`/api/track/${sub.reference}`);
ok(t.accepted === true, 'after acceptance, track shows accepted = true');

// 4b) Lookup by mobile number returns all of that number's requests (privacy-safe).
await j('/api/intake', { m: 'POST', b: { name: 'Asha', phone: '+91 90000 00001', email: 'asha@example.com', problem: 'Second issue' } });
const byPhone = await j('/api/track/by-phone?phone=9000000001');
ok(byPhone.found && byPhone.requests.length >= 2, `by-phone returns the number's requests (${byPhone.requests?.length})`);
ok(byPhone.requests.every((r) => r.reference && !('joinUrl' in r) && !('requesterEmail' in r)), 'by-phone list is privacy-safe (no contact/join in list)');
const noPhone = await j('/api/track/by-phone?phone=9999999999');
ok(noPhone.found === false, 'by-phone with an unknown number returns none');

// 5) Track PAGE: shows timeline + an active Join button after acceptance.
const br = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000, args: ['--no-sandbox'] });
try {
  const page = await br.newPage();
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(`${B}/track.html?ref=${sub.reference}`, { waitUntil: 'networkidle0' });
  await wait(1200);
  const steps = await page.$$eval('#timeline li', (els) => els.map((e) => e.className));
  ok(steps.length === 4, `timeline renders 4 stages (${steps.length})`);
  ok(steps[0].includes('done') && steps[1].includes('done'), 'received + assigned stages marked done');
  const joinShown = await page.$eval('#trackJoin', (el) => !el.classList.contains('hidden') && !!el.getAttribute('href'));
  ok(joinShown, 'track page shows an active Join button once accepted');

  // 6) Track page for an OPEN (not yet accepted) request: Join hidden, waiting hint shown.
  const sub2 = await j('/api/intake', { m: 'POST', b: { name: 'Ravi', phone: '+91 90000 00002', email: 'ravi@example.com', problem: 'Remote issue' } });
  const p2 = await br.newPage();
  await p2.setViewport({ width: 900, height: 900 });
  await p2.goto(`${B}/track.html?ref=${sub2.reference}`, { waitUntil: 'networkidle0' });
  await wait(1000);
  const joinHidden = await p2.$eval('#trackJoin', (el) => el.classList.contains('hidden'));
  const hintShown = await p2.$eval('#trackHint', (el) => !el.classList.contains('hidden') && /agent/i.test(el.textContent));
  ok(joinHidden && hintShown, 'open request: Join hidden, waiting hint shown');

  // 7) Track page: searching by mobile number lists the requests.
  const p3 = await br.newPage();
  await p3.setViewport({ width: 900, height: 900 });
  await p3.goto(`${B}/track.html`, { waitUntil: 'networkidle0' });
  await p3.type('#ref', '9000000001');
  await p3.click('#trackBtn');
  await wait(800);
  const items = await p3.$$eval('#list .sess-item', (els) => els.length);
  ok(items >= 2, `phone search lists the customer's requests (${items})`);

  await br.close();
} catch (e) {
  console.error('error', e.message);
  failures++;
  await br.close();
}

console.log(failures === 0 ? '\nPASS: TRACK FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
