// Shared client helpers: REST calls, token storage, small UI utilities.

export const store = {
  get token() {
    return localStorage.getItem('auth_token');
  },
  set token(v) {
    if (v) localStorage.setItem('auth_token', v);
    else localStorage.removeItem('auth_token');
  },
  get user() {
    const raw = localStorage.getItem('auth_user');
    return raw ? JSON.parse(raw) : null;
  },
  set user(v) {
    if (v) localStorage.setItem('auth_user', JSON.stringify(v));
    else localStorage.removeItem('auth_user');
  },
  clearAuth() {
    this.token = null;
    this.user = null;
  },
};

/**
 * On a signed-in page, treat pressing Back (navigating away from the profile) as a
 * sign-out, so the authenticated view is never left sitting in history or re-enterable
 * via the Forward button. Implemented with a history sentinel + popstate, so a normal
 * page refresh does NOT sign the user out (only an actual back/forward does).
 * `isBusy()` lets a page defer when it manages its own back behavior (e.g. a live call).
 */
export function installAuthBackGuard(isBusy) {
  history.pushState({ _authGuard: true }, '');
  window.addEventListener('popstate', () => {
    if (typeof isBusy === 'function' && isBusy()) {
      // The page (e.g. an in-call view) owns this Back press — keep our sentinel.
      history.pushState({ _authGuard: true }, '');
      return;
    }
    store.clearAuth();
    window.location.replace('/login.html');
  });
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && store.token) headers.Authorization = `Bearer ${store.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    // A 401 on an authed request means our stored token is invalid/expired (e.g. the
    // server restarted with a new secret). Clear it and bounce to login ONCE so we
    // never ping-pong between login and a dashboard.
    if (res.status === 401 && auth && store.token) {
      store.clearAuth();
      if (!location.pathname.endsWith('/login.html')) location.replace('/login.html');
    }
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let bannerTimer = null;
export function banner(message, kind = '') {
  let el = document.querySelector('.banner');
  if (!el) {
    el = document.createElement('div');
    el.className = 'banner';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `banner show ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    el.className = 'banner';
  }, 3500);
}

/** Formats a Date into a running mm:ss / h:mm:ss timer string from a start time. */
export function elapsed(startMs) {
  const total = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
