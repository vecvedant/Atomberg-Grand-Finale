import { escapeHtml } from './common.js';

const form = document.getElementById('trackForm');
const refInput = document.getElementById('ref');
const errEl = document.getElementById('trackError');
const result = document.getElementById('result');
const listEl = document.getElementById('list');
const timeline = document.getElementById('timeline');
const joinBtn = document.getElementById('trackJoin');
const hint = document.getElementById('trackHint');
const schedNote = document.getElementById('schedNote');
let pollTimer = null;

const fmtWhen = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_LABEL = { open: 'Awaiting an agent', scheduled: 'Agent assigned', active: 'In the call', ended: 'Completed' };

function looksLikePhone(v) {
  if (/^[A-Za-z0-9]{8}$/.test(v)) return false; // an 8-char reference code
  return v.replace(/\D/g, '').length >= 7;
}

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

// If a reference was passed in the URL, load it straight away.
const fromUrl = new URLSearchParams(location.search).get('ref');
if (fromUrl) {
  refInput.value = fromUrl.toUpperCase();
  load(refInput.value);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = refInput.value.trim();
  if (!raw) {
    errEl.textContent = 'Enter your reference code or mobile number.';
    return;
  }
  if (looksLikePhone(raw)) loadByPhone(raw);
  else load(raw.toUpperCase());
});

async function load(ref) {
  errEl.textContent = '';
  listEl.classList.add('hidden');
  try {
    const res = await fetch(`/api/track/${encodeURIComponent(ref)}`);
    const data = await res.json();
    if (!res.ok || !data.found) {
      result.classList.add('hidden');
      stopPoll();
      errEl.textContent = data.error || 'No request found for that reference.';
      return;
    }
    render(data);
    // Keep refreshing while the request is still in progress.
    if (!data.ended) startPoll(ref);
    else stopPoll();
  } catch {
    errEl.textContent = 'Could not reach the server. Please try again.';
  }
}

async function loadByPhone(phone) {
  errEl.textContent = '';
  stopPoll();
  result.classList.add('hidden');
  try {
    const res = await fetch(`/api/track/by-phone?phone=${encodeURIComponent(phone)}`);
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Could not look up that number.';
      return;
    }
    if (!data.found || !data.requests.length) {
      listEl.classList.add('hidden');
      errEl.textContent = 'No requests found for that mobile number.';
      return;
    }
    listEl.innerHTML = data.requests
      .map((r) => {
        const label = STATUS_LABEL[r.status] || r.status;
        const sched = r.scheduledAt && r.status !== 'ended' ? `<div class="s-when sched">Scheduled for ${escapeHtml(fmtWhen(r.scheduledAt))}</div>` : '';
        return `
          <div class="sess-item">
            <div class="grow">
              <div class="s-title">${escapeHtml(r.title)}</div>
              ${sched}
              <div class="s-when">Ref ${escapeHtml(r.reference)} · ${new Date(r.createdAt).toLocaleString()}</div>
            </div>
            <span class="tag ${r.status}">${escapeHtml(label)}</span>
            <div class="actions"><button class="secondary" data-ref="${escapeHtml(r.reference)}">View</button></div>
          </div>`;
      })
      .join('');
    listEl.querySelectorAll('button[data-ref]').forEach((b) =>
      b.addEventListener('click', () => {
        refInput.value = b.dataset.ref;
        load(b.dataset.ref);
      }),
    );
    listEl.classList.remove('hidden');
  } catch {
    errEl.textContent = 'Could not reach the server. Please try again.';
  }
}

function render(d) {
  document.getElementById('resRef').textContent = d.reference;
  result.classList.remove('hidden');

  // Show the scheduled time (if the customer picked one) until the call is done.
  if (d.scheduledAt && !d.ended) {
    schedNote.textContent = `Scheduled for ${fmtWhen(d.scheduledAt)}`;
    schedNote.classList.remove('hidden');
  } else {
    schedNote.classList.add('hidden');
  }

  // Derive the four lifecycle stages from the live status.
  const inCall = d.status === 'active';
  const stages = [
    { t: 'Request received', s: 'done' },
    { t: 'Assigned to an agent', s: d.accepted ? 'done' : 'current' },
    { t: 'In the video call', s: inCall ? 'done' : d.accepted && !d.ended ? 'current' : 'pending' },
    {
      t: d.resolved === 1 ? 'Resolved' : d.ended ? 'Closed' : 'Resolved',
      s: d.ended ? 'done' : 'pending',
    },
  ];

  timeline.innerHTML = stages
    .map(
      (st) => `
      <li class="${st.s}">
        <span class="ts-dot">${st.s === 'done' ? CHECK : ''}</span>
        <div class="tt">${escapeHtml(st.t)}</div>
      </li>`,
    )
    .join('');

  // Join button: only while an agent has accepted and the call is still live.
  if (d.accepted && !d.ended && d.joinUrl) {
    joinBtn.href = d.joinUrl;
    joinBtn.classList.remove('hidden');
    hint.classList.add('hidden');
  } else {
    joinBtn.classList.add('hidden');
    hint.classList.remove('hidden');
    hint.textContent = d.ended
      ? 'This request has been completed.'
      : "We'll connect you as soon as an agent accepts — this page updates automatically.";
  }
}

function startPoll(ref) {
  stopPoll();
  pollTimer = setInterval(() => load(ref), 5000);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
