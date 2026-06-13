// Verifies: intake -> thank-you (no auto-join), Join button stays inactive until
// an agent accepts, the customer join page shows a "waiting" screen (not "ended")
// and auto-advances to the join form once accepted.
import puppeteer from 'puppeteer';

const B = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function acceptNextTask() {
  const avail = await j('/api/tasks/available', { t: agentTok });
  if (!avail.length) return false;
  await j(`/api/tasks/${avail[0].id}/accept`, { m: 'POST', t: agentTok });
  return true;
}

const br = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000, args: ['--no-sandbox'] });

try {
  /* ---------- 1) Customer join page: waiting -> accepted ---------- */
  const sub = await j('/api/intake', {
    m: 'POST',
    b: { name: 'Asha', phone: '+91 90000 00001', email: 'asha@example.com', problem: 'Fan noise' },
  });
  const token = new URL(sub.joinUrl).searchParams.get('token');

  const cust = await br.newPage();
  await cust.setViewport({ width: 900, height: 800 });
  await cust.goto(`${B}/customer.html?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle0' });
  await wait(800);
  let formHidden = await cust.$eval('#joinForm', (el) => el.classList.contains('hidden'));
  let errText = await cust.$eval('#joinError', (el) => el.textContent);
  let subText = await cust.$eval('#joinSubtitle', (el) => el.textContent);
  ok(formHidden, 'before acceptance: join form is hidden (waiting)');
  ok(!/ended/i.test(errText), `before acceptance: no "ended" message (error="${errText}")`);
  ok(/forward|wait/i.test(subText), 'before acceptance: shows a waiting message');

  await acceptNextTask();
  await wait(5000); // customer page polls every 4s and should auto-advance
  formHidden = await cust.$eval('#joinForm', (el) => el.classList.contains('hidden'));
  const prefilled = await cust.$eval('#displayName', (el) => el.value);
  ok(!formHidden, 'after acceptance: join form is shown automatically');
  ok(prefilled === 'Asha', 'after acceptance: form is prefilled from the request');

  /* ---------- 2) Intake confirmation: Join button gated on acceptance ---------- */
  const page = await br.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  await page.goto(`${B}/intake.html`, { waitUntil: 'networkidle0' });
  await page.type('#name', 'Ravi');
  await page.type('#phone', '+91 90000 00002');
  await page.type('#email', 'ravi@example.com');
  await page.type('#problem', 'Remote not pairing');
  await page.click('#submitBtn');
  await page.waitForFunction(() => !document.getElementById('doneWrap').classList.contains('hidden'), { timeout: 8000 });
  let link = await page.$eval('#joinLink', (el) => ({ t: el.textContent.trim(), href: el.getAttribute('href'), waiting: el.classList.contains('is-waiting') }));
  ok(link.waiting && !link.href && /waiting/i.test(link.t), `confirmation: Join button inactive while waiting ("${link.t}")`);

  await acceptNextTask();
  await wait(5000); // confirmation polls every 4s
  link = await page.$eval('#joinLink', (el) => ({ t: el.textContent.trim(), href: el.getAttribute('href'), waiting: el.classList.contains('is-waiting') }));
  ok(!link.waiting && !!link.href && /join the call/i.test(link.t), `confirmation: Join button activates after acceptance ("${link.t}")`);

  await br.close();
} catch (e) {
  console.error('error:', e.message);
  failures++;
  await br.close();
}

console.log(failures === 0 ? '\nPASS: INTAKE ACCEPT FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
