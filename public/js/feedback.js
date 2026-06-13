import { api, banner } from './common.js';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session');
const token = params.get('token');

let rating = null;
let solved = null;

function wireChoice(containerId, onPick) {
  const btns = document.querySelectorAll(`#${containerId} button`);
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      onPick(b.dataset.val);
      btns.forEach((x) => x.classList.toggle('selected', x === b));
    }),
  );
}

wireChoice('rating', (v) => (rating = Number(v)));
wireChoice('solved', (v) => (solved = v === '1'));

document.getElementById('submitBtn').addEventListener('click', async () => {
  const err = document.getElementById('fbError');
  err.textContent = '';
  if (!sessionId || !token) {
    err.textContent = 'This feedback link is invalid.';
    return;
  }
  if (rating === null && solved === null) {
    err.textContent = 'Please rate your experience or tell us if your problem was solved.';
    return;
  }
  const body = { token, comment: document.getElementById('comment').value.trim() };
  if (rating !== null) body.rating = rating;
  if (solved !== null) body.resolved = solved;
  try {
    await api(`/api/sessions/${sessionId}/feedback`, { method: 'POST', auth: false, body });
    document.getElementById('formCard').classList.add('hidden');
    document.getElementById('thanksCard').classList.remove('hidden');
  } catch (e) {
    err.textContent = e.message || 'Could not submit feedback';
    banner('Could not submit feedback', 'error');
  }
});
