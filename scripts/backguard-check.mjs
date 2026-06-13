// Verifies the auth Back-button behavior: pressing Back to leave a signed-in
// profile signs the user out (and Forward can't re-enter it), while a normal
// page refresh keeps the user signed in.
import puppeteer from 'puppeteer';

const B = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};

const CREDS = {
  admin: { user: 'admin', pass: 'admin123', page: '/admin.html' },
  manager: { user: 'manager', pass: 'manager123', page: '/manager.html' },
  agent: { user: 'agent', pass: 'agent123', page: '/agent.html' },
};

const br = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000, args: ['--no-sandbox'] });
try {
  for (const [role, c] of Object.entries(CREDS)) {
    const pg = await br.newPage();
    const tok = () => pg.evaluate(() => (localStorage.getItem('auth_token') ? 'TOKEN' : 'none'));
    // Build real history: landing -> login -> dashboard.
    await pg.goto(`${B}/index.html`, { waitUntil: 'networkidle0' });
    await pg.goto(`${B}/login.html`, { waitUntil: 'networkidle0' });
    await pg.type('#username', c.user);
    await pg.type('#password', c.pass);
    await Promise.all([pg.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {}), pg.click('#loginBtn')]);
    await wait(700);
    ok(pg.url().endsWith(c.page) && (await tok()) === 'TOKEN', `${role}: logged in on ${c.page}`);

    // A normal refresh must KEEP the user signed in.
    await pg.reload({ waitUntil: 'networkidle0' });
    await wait(500);
    ok(pg.url().endsWith(c.page) && (await tok()) === 'TOKEN', `${role}: refresh keeps the session (still signed in)`);

    // Pressing Back to leave the profile signs the user out.
    await pg.goBack({ waitUntil: 'networkidle0' }).catch(() => {});
    await wait(900);
    ok(pg.url().endsWith('/login.html') && (await tok()) === 'none', `${role}: Back signs out and lands on login`);

    // Forward must NOT re-enter the profile.
    await pg.goForward({ waitUntil: 'networkidle0' }).catch(() => {});
    await wait(900);
    ok(!pg.url().endsWith(c.page), `${role}: Forward (redo) does not re-enter the profile (${pg.url().replace(B, '')})`);

    await pg.close();
  }
  await br.close();
} catch (e) {
  console.error('error', e.message);
  failures++;
  await br.close();
}

console.log(failures === 0 ? '\nPASS: BACK-GUARD FLOW PASS' : `\nFAIL: (${failures})`);
process.exit(failures === 0 ? 0 : 1);
