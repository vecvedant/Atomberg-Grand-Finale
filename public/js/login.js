import { api, store, banner } from './common.js';

// If already signed in, skip straight to the right console.
if (store.token && store.user) {
  redirectForRole(store.user.role);
}

const form = document.getElementById('loginForm');
const errEl = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    errEl.textContent = 'Enter your username and password.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const { token, user } = await api('/api/auth/login', { method: 'POST', auth: false, body: { username, password } });
    store.token = token;
    store.user = user;
    banner(`Welcome, ${user.displayName}`, 'success');
    redirectForRole(user.role);
  } catch (err) {
    errEl.textContent = err.message || 'Sign in failed';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

function redirectForRole(role) {
  const dest = { admin: '/admin.html', manager: '/manager.html', agent: '/agent.html' }[role] || '/agent.html';
  window.location.replace(dest);
}

document.getElementById('forgotBtn').addEventListener('click', () => {
  document.getElementById('forgotHelp').classList.toggle('hidden');
});
