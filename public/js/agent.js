import { api, store, banner, escapeHtml, installAuthBackGuard } from './common.js';
import { CallApp } from './call.js';

if (!store.token || !store.user) window.location.replace('/login.html');
// Bounce to login if a back/forward restores this page after sign-out (bfcache).
window.addEventListener('pageshow', () => {
  if (!store.token) window.location.replace('/login.html');
});

const precall = document.getElementById('precall');
const callView = document.getElementById('call');

// Leaving the console via the Back button signs the user out — but during a live
// call, the call view owns the Back press (it leaves the call, see call.js).
installAuthBackGuard(() => !callView.classList.contains('hidden'));

document.getElementById('logoutBtn').addEventListener('click', () => {
  store.clearAuth();
  window.location.replace('/login.html');
});

/* ----- change password ----- */
const pwModal = document.getElementById('pwModal');
document.getElementById('changePwBtn').addEventListener('click', () => pwModal.classList.remove('hidden'));
document.getElementById('pwCancel').addEventListener('click', () => pwModal.classList.add('hidden'));
document.getElementById('pwSave').addEventListener('click', async () => {
  const err = document.getElementById('pwError');
  err.textContent = '';
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: document.getElementById('curPw').value, newPassword: document.getElementById('newPw').value },
    });
    banner('Password updated', 'success');
    pwModal.classList.add('hidden');
    document.getElementById('curPw').value = '';
    document.getElementById('newPw').value = '';
  } catch (e) {
    err.textContent = e.message || 'Could not update password';
  }
});

/* ----- stats ----- */
async function loadStats() {
  try {
    const s = await api('/api/tasks/stats');
    const cells = [
      ['Accepted', s.accepted],
      ['Completed', s.completed],
      ['Resolved', s.resolved],
      ['Avg rating', s.avgRating == null ? '—' : `${s.avgRating} / 5`],
    ];
    document.getElementById('agentStats').innerHTML = cells
      .map(([l, n]) => `<div class="stat-mini"><div class="n">${n}</div><div class="l">${l}</div></div>`)
      .join('');
  } catch {
    /* ignore */
  }
}

/* ----- available + my tasks ----- */
async function loadTasks() {
  await Promise.all([loadAvailable(), loadMine(), loadStats()]);
}

function schedLine(t) {
  if (!t.scheduledAt) return '';
  const when = new Date(t.scheduledAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="s-when sched">Scheduled for ${escapeHtml(when)}</div>`;
}

function intakeLine(t) {
  const parts = [];
  if (t.source === 'intake') parts.push('Self-service request');
  if (t.purchaseDate) parts.push('Bought ' + new Date(t.purchaseDate).toLocaleDateString());
  if (t.warrantyStatus) {
    let w = `Warranty: ${t.warrantyStatus}`;
    if (t.warrantyAuto === 1) w += ' (in warranty)';
    else if (t.warrantyAuto === 0) w += ' (expired)';
    parts.push(w);
  }
  if (t.billFileId) parts.push('Bill attached');
  return parts.length ? `<div class="s-when">${escapeHtml(parts.join(' · '))}</div>` : '';
}

function makeTaskCard(t, whenLine, acceptLabel) {
  const el = document.createElement('div');
  el.className = 'sess-item';
  el.innerHTML = `
    <div class="grow">
      <div class="s-title">${escapeHtml(t.title)}</div>
      ${t.description ? `<div class="s-desc">${escapeHtml(t.description)}</div>` : ''}
      ${schedLine(t)}
      ${intakeLine(t)}
      <div class="s-when">${escapeHtml(whenLine)}</div>
    </div>
    <div class="actions"></div>`;
  const accept = document.createElement('button');
  accept.textContent = acceptLabel;
  accept.addEventListener('click', async () => {
    accept.disabled = true;
    try {
      const claimed = await api(`/api/tasks/${t.id}/accept`, { method: 'POST' });
      banner('Task accepted', 'success');
      startCall(claimed);
    } catch (e) {
      banner(e.message || 'Could not accept', 'error');
      accept.disabled = false;
      loadTasks();
    }
  });
  el.querySelector('.actions').appendChild(accept);
  return el;
}

async function loadAvailable() {
  const liveList = document.getElementById('liveQueueList');
  const schedList = document.getElementById('scheduledList');
  const liveCount = document.getElementById('liveCount');
  try {
    const tasks = await api('/api/tasks/available');
    // "Get on the line" requests have no scheduled time — they wait in the live
    // queue (FIFO, oldest first). Scheduled requests are booked for later.
    const live = tasks.filter((t) => !t.scheduledAt).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const scheduled = tasks.filter((t) => t.scheduledAt).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    liveCount.textContent = String(live.length);
    if (!live.length) {
      liveList.innerHTML = '<div class="empty-note">No one waiting on the line right now.</div>';
    } else {
      liveList.innerHTML = '';
      live.forEach((t, i) => {
        const waited = `In queue · waiting since ${new Date(t.createdAt).toLocaleTimeString()}`;
        liveList.appendChild(makeTaskCard(t, waited, i === 0 ? 'Pick up' : 'Accept'));
      });
    }

    if (!scheduled.length) {
      schedList.innerHTML = '<div class="empty-note">No scheduled requests.</div>';
    } else {
      schedList.innerHTML = '';
      for (const t of scheduled) schedList.appendChild(makeTaskCard(t, `Posted ${new Date(t.createdAt).toLocaleString()}`, 'Accept'));
    }
  } catch {
    liveList.innerHTML = '<div class="empty-note">Could not load the queue.</div>';
    schedList.innerHTML = '';
  }
}

async function loadMine() {
  const list = document.getElementById('myList');
  try {
    const tasks = await api('/api/tasks/mine');
    if (!tasks.length) {
      list.innerHTML = '<div class="empty-note">You have no accepted tasks yet.</div>';
      return;
    }
    list.innerHTML = '';
    for (const t of tasks) {
      const el = document.createElement('div');
      el.className = 'sess-item';
      const when = t.status === 'ended' ? `Ended ${t.endedAt ? new Date(t.endedAt).toLocaleString() : ''}` : `Accepted`;
      el.innerHTML = `
        <div class="grow">
          <div class="s-title">${escapeHtml(t.title)}</div>
          ${t.description ? `<div class="s-desc">${escapeHtml(t.description)}</div>` : ''}
          ${schedLine(t)}
          ${intakeLine(t)}
          <div class="s-when">${escapeHtml(when)}</div>
        </div>
        <span class="tag ${t.status}">${t.status}</span>
        <div class="actions"></div>`;
      if (t.status !== 'ended') {
        const start = document.createElement('button');
        start.textContent = 'Start';
        start.addEventListener('click', () => startCall(t));
        const copy = document.createElement('button');
        copy.className = 'secondary';
        copy.textContent = 'Copy link';
        copy.addEventListener('click', () => copyLink(t.inviteUrl));
        el.querySelector('.actions').append(start, copy);
      }
      list.appendChild(el);
    }
  } catch {
    list.innerHTML = '<div class="empty-note">Could not load your tasks.</div>';
  }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    banner('Invite link copied', 'success');
  } catch {
    banner('Copy failed', 'error');
  }
}

/* ----- run a call ----- */
function startCall(task) {
  precall.classList.add('hidden');
  callView.classList.remove('hidden');
  document.getElementById('sessionTitleLabel').textContent = task.title;
  const inviteInput = document.getElementById('inviteUrl');
  inviteInput.value = task.inviteUrl;
  document.getElementById('copyInvite').onclick = () => copyLink(task.inviteUrl);

  const app = new CallApp({
    role: 'agent',
    isAgent: true,
    token: store.token,
    sessionId: task.id,
    displayName: store.user.displayName,
    purchaseDate: task.purchaseDate,
    warrantyStatus: task.warrantyStatus,
    warrantyAuto: task.warrantyAuto,
    billUrl: task.billFileId ? `/api/files/${task.billFileId}?token=${encodeURIComponent(store.token)}` : null,
    onEndRequested: () => openResolution(app, task.id),
  });
  window.__call = app;
  app.connect();
  import('./webrtc.js').then(({ attachMedia }) => attachMedia(app)).catch(() => {});
  import('./agent-recording.js').then(({ wireRecording }) => wireRecording(app)).catch(() => {});
}

/* ----- resolution modal on end ----- */
function openResolution(app, sessionId) {
  const modal = document.getElementById('resModal');
  let chosen = null;
  const choiceBtns = modal.querySelectorAll('#resChoice button');
  choiceBtns.forEach((b) =>
    b.addEventListener('click', () => {
      chosen = b.dataset.val;
      choiceBtns.forEach((x) => x.classList.toggle('selected', x === b));
    }),
  );
  modal.classList.remove('hidden');
  document.getElementById('resSkip').onclick = () => {
    modal.classList.add('hidden');
    app.confirmEnd();
  };
  document.getElementById('resSave').onclick = async () => {
    if (chosen === null) {
      banner('Choose resolved or not resolved', 'error');
      return;
    }
    try {
      await api(`/api/sessions/${sessionId}/resolution`, {
        method: 'POST',
        body: { resolved: chosen === '1', notes: document.getElementById('resNotes').value.trim() },
      });
    } catch {
      /* best-effort */
    }
    modal.classList.add('hidden');
    app.confirmEnd();
  };
}

loadTasks();
setInterval(() => {
  if (!callView.classList.contains('hidden')) return; // don't refresh during a call
  loadTasks();
}, 6000);
