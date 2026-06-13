import { api, store, banner, escapeHtml, installAuthBackGuard } from './common.js';

// Guard: admins only.
if (!store.token || store.user?.role !== 'admin') {
  window.location.replace('/login.html');
}
window.addEventListener('pageshow', () => {
  if (!store.token) window.location.replace('/login.html');
});
// Leaving the profile via the Back button signs the user out.
installAuthBackGuard();

document.getElementById('logoutBtn').addEventListener('click', () => {
  store.clearAuth();
  window.location.replace('/login.html');
});

const els = {
  managers: document.getElementById('statManagers'),
  agents: document.getElementById('statAgents'),
  active: document.getElementById('statActive'),
  connected: document.getElementById('statConnected'),
  total: document.getElementById('statTotal'),
  live: document.getElementById('liveSessions'),
  liveCount: document.getElementById('liveCount'),
  history: document.getElementById('historySessions'),
  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerBody: document.getElementById('drawerBody'),
};

document.getElementById('drawerClose').addEventListener('click', () => els.drawer.classList.add('hidden'));
els.drawer.addEventListener('click', (e) => {
  if (e.target === els.drawer) els.drawer.classList.add('hidden');
});

/* ----- metrics modal (readable observability view) ----- */
const metricsModal = document.getElementById('metricsModal');
document.getElementById('metricsClose').addEventListener('click', () => metricsModal.classList.add('hidden'));
metricsModal.addEventListener('click', (e) => {
  if (e.target === metricsModal) metricsModal.classList.add('hidden');
});
document.getElementById('metricsBtn').addEventListener('click', async () => {
  try {
    const m = await api('/api/admin/metrics');
    const mins = Math.floor(m.uptimeSeconds / 60);
    const uptime = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const cards = [
      ['Active sessions', m.sessions.active],
      ['Connected now', m.connectedParticipants],
      ['Errors', m.errorsTotal],
    ];
    document.getElementById('metricsCards').innerHTML = cards
      .map(([l, n]) => `<div class="stat-mini"><div class="n">${n}</div><div class="l">${l}</div></div>`)
      .join('');
    document.getElementById('metricsBreakdown').innerHTML = `
      <div class="kv"><span>Sessions (total)</span><span>${m.sessions.total}</span></div>
      <div class="kv"><span>&nbsp;&nbsp;open / scheduled / active / ended</span><span>${m.sessions.open} / ${m.sessions.scheduled} / ${m.sessions.active} / ${m.sessions.ended}</span></div>
      <div class="kv"><span>Managers / Agents</span><span>${m.managers} / ${m.agents}</span></div>
      <div class="kv"><span>Chat messages</span><span>${m.messagesTotal}</span></div>
      <div class="kv"><span>Recordings</span><span>${m.recordingsTotal}</span></div>
      <div class="kv"><span>Files shared</span><span>${m.filesShared}</span></div>
      <div class="kv"><span>Memory (RSS)</span><span>${m.memoryMB} MB</span></div>
      <div class="kv"><span>Uptime</span><span>${uptime}</span></div>`;
    metricsModal.classList.remove('hidden');
  } catch (e) {
    banner(e.message || 'Could not load metrics', 'error');
  }
});

/* ----- manager management + performance ----- */
const addManagerModal = document.getElementById('addManagerModal');
const resetModal = document.getElementById('resetModal');
let resetTargetId = null;

document.getElementById('addManagerBtn').addEventListener('click', () => addManagerModal.classList.remove('hidden'));
document.getElementById('mgCancel').addEventListener('click', () => addManagerModal.classList.add('hidden'));
document.getElementById('resetCancel').addEventListener('click', () => resetModal.classList.add('hidden'));

document.getElementById('mgSave').addEventListener('click', async () => {
  const err = document.getElementById('mgError');
  err.textContent = '';
  try {
    await api('/api/admin/managers', {
      method: 'POST',
      body: {
        username: document.getElementById('mgUsername').value.trim(),
        displayName: document.getElementById('mgDisplay').value.trim(),
        employeeId: document.getElementById('mgEmployeeId').value.trim(),
        phone: document.getElementById('mgPhone').value.trim(),
        email: document.getElementById('mgEmail').value.trim(),
        password: document.getElementById('mgPassword').value,
      },
    });
    banner('Manager created', 'success');
    addManagerModal.classList.add('hidden');
    for (const id of ['mgUsername', 'mgDisplay', 'mgEmployeeId', 'mgPhone', 'mgEmail', 'mgPassword'])
      document.getElementById(id).value = '';
    loadManagers();
  } catch (e) {
    err.textContent = e.message || 'Could not create manager';
  }
});

document.getElementById('resetSave').addEventListener('click', async () => {
  const err = document.getElementById('resetError');
  err.textContent = '';
  try {
    await api(`/api/admin/accounts/${resetTargetId}/reset-password`, {
      method: 'POST',
      body: { newPassword: document.getElementById('resetPw').value },
    });
    banner('Password reset', 'success');
    resetModal.classList.add('hidden');
    document.getElementById('resetPw').value = '';
  } catch (e) {
    err.textContent = e.message || 'Could not reset password';
  }
});

async function loadManagers() {
  const list = document.getElementById('managerList');
  try {
    const managers = await api('/api/admin/managers');
    if (!managers.length) {
      list.innerHTML = '<div class="empty-row">No managers yet. Add one to get started.</div>';
      return;
    }
    list.innerHTML = '';
    for (const m of managers) {
      const el = document.createElement('div');
      el.className = 'sess-item';
      const contact = [m.employeeId ? `ID ${escapeHtml(m.employeeId)}` : null, m.phone ? escapeHtml(m.phone) : null, m.email ? escapeHtml(m.email) : null]
        .filter(Boolean)
        .join(' · ');
      el.innerHTML = `
        <div class="grow">
          <div class="s-title">${escapeHtml(m.displayName)} <span class="muted">@${escapeHtml(m.username)}</span></div>
          ${contact ? `<div class="s-desc">${contact}</div>` : ''}
          <div class="s-when">${m.agentCount} agent(s) · Accepted ${m.totalAccepted} · Completed ${m.totalCompleted} · Resolved ${m.totalResolved} · Rating ${m.avgRating == null ? '—' : m.avgRating + '/5'}</div>
        </div>
        <div class="actions"></div>`;
      const view = document.createElement('button');
      view.className = 'secondary';
      view.textContent = 'View';
      view.addEventListener('click', () => openManager(m));
      const reset = document.createElement('button');
      reset.className = 'secondary';
      reset.textContent = 'Reset';
      reset.addEventListener('click', () => {
        resetTargetId = m.managerId;
        document.getElementById('resetWho').textContent = `New password for ${m.displayName} (@${m.username})`;
        resetModal.classList.remove('hidden');
      });
      const remove = document.createElement('button');
      remove.className = 'danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove manager ${m.displayName} and their agents?`)) return;
        try {
          await api(`/api/admin/managers/${m.managerId}`, { method: 'DELETE' });
          banner('Manager removed', 'success');
          loadManagers();
        } catch (e) {
          banner(e.message || 'Could not remove', 'error');
        }
      });
      el.querySelector('.actions').append(view, reset, remove);
      list.appendChild(el);
    }
  } catch {
    list.innerHTML = '<div class="empty-row">Could not load managers.</div>';
  }
}

function openManager(m) {
  els.drawerTitle.textContent = `${m.displayName} — performance`;
  const agents =
    m.agents.length === 0
      ? '<p class="muted">No agents in this pool.</p>'
      : `<table class="report-table"><thead><tr><th>Agent</th><th>ID / Contact</th><th>Accepted</th><th>Completed</th><th>Resolved</th><th>Rating</th></tr></thead><tbody>${m.agents
          .map((a) => {
            const c = [a.employeeId ? `ID ${escapeHtml(a.employeeId)}` : '', a.phone ? escapeHtml(a.phone) : '', a.email ? escapeHtml(a.email) : '']
              .filter(Boolean)
              .join('<br>');
            return `<tr><td>${escapeHtml(a.displayName)}</td><td>${c || '—'}</td><td>${a.accepted}</td><td>${a.completed}</td><td>${a.resolved}</td><td>${a.avgRating == null ? '—' : a.avgRating + '/5'}</td></tr>`;
          })
          .join('')}</tbody></table>`;
  els.drawerBody.innerHTML = `
    <div class="detail-section">
      <h3>Summary</h3>
      <div class="kv"><span>Agents</span><span>${m.agentCount}</span></div>
      <div class="kv"><span>Open tasks</span><span>${m.openTasks}</span></div>
      <div class="kv"><span>Accepted</span><span>${m.totalAccepted}</span></div>
      <div class="kv"><span>Completed</span><span>${m.totalCompleted}</span></div>
      <div class="kv"><span>Resolved</span><span>${m.totalResolved}</span></div>
      <div class="kv"><span>Avg rating</span><span>${m.avgRating == null ? '—' : m.avgRating + ' / 5'}</span></div>
    </div>
    <div class="detail-section"><h3>Agents</h3>${agents}</div>`;
  els.drawer.classList.remove('hidden');
}

const fmtDur = (s) => {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function sessionRow(s) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.innerHTML = `
    <div>
      <div class="s-title">${escapeHtml(s.title)}</div>
      <div class="s-sub">Agent: ${escapeHtml(s.agent)} · ${s.participantCount} participant(s)</div>
    </div>
    <span class="badge ${s.status}">${s.status}</span>
    <div class="s-meta">${s.status === 'active' ? `${s.connectedCount} online` : ''}<br />${fmtDur(s.durationSec)}</div>
    <div>${s.status === 'active' ? `<button class="danger end-btn">End</button>` : ''}</div>`;
  row.addEventListener('click', (e) => {
    if (e.target.classList.contains('end-btn')) return;
    openDetail(s.id);
  });
  const endBtn = row.querySelector('.end-btn');
  endBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Force-end "${s.title}"?`)) return;
    try {
      await api(`/api/admin/sessions/${s.id}/end`, { method: 'POST' });
      banner('Session ended', 'success');
      refresh();
    } catch (err) {
      banner(err.message || 'Failed to end', 'error');
    }
  });
  return row;
}

function renderList(container, sessions, emptyText) {
  container.innerHTML = '';
  if (sessions.length === 0) {
    container.innerHTML = `<div class="empty-row">${emptyText}</div>`;
    return;
  }
  for (const s of sessions) container.appendChild(sessionRow(s));
}

async function openDetail(id) {
  try {
    const rec = await api(`/api/admin/sessions/${id}`);
    els.drawerTitle.textContent = rec.session.title;
    const participants = rec.participants
      .map((p) => {
        const contact = [p.phone ? escapeHtml(p.phone) : '', p.email ? escapeHtml(p.email) : ''].filter(Boolean).join(' · ');
        return `<div class="pitem"><span>${escapeHtml(p.display_name)} <span class="muted">(${p.role})</span>${
          contact ? `<br><span class="muted" style="font-size:12px">${contact}</span>` : ''
        }</span><span class="muted">${p.status}</span></div>`;
      })
      .join('');
    const events = rec.events
      .map(
        (e) =>
          `<div class="event-item"><span class="t">${new Date(e.created_at).toLocaleTimeString()}</span><span class="ev">${escapeHtml(
            e.type,
          )}</span></div>`,
      )
      .join('');
    const recordings = rec.recordings
      .map((r) => {
        const link =
          r.status === 'ready'
            ? `<a class="dl-link" href="/api/recordings/${r.id}/download?token=${encodeURIComponent(store.token)}" target="_blank">⬇ Download (${fmtDur(r.duration_sec)})</a>`
            : `<span class="muted">${r.status}</span>`;
        return `<div class="pitem"><span>Recording</span>${link}</div>`;
      })
      .join('');

    const s = rec.session;
    const yn = (v) => (v === 1 ? 'Yes' : v === 0 ? 'No' : '—');
    const feedback = `
      <div class="kv"><span>Agent: resolved</span><span>${yn(s.resolved)}</span></div>
      ${s.agent_notes ? `<div class="kv"><span>Agent notes</span><span>${escapeHtml(s.agent_notes)}</span></div>` : ''}
      <div class="kv"><span>Customer: solved</span><span>${yn(s.customer_resolved)}</span></div>
      <div class="kv"><span>Customer rating</span><span>${s.customer_rating ? `${s.customer_rating} / 5` : '—'}</span></div>
      ${s.customer_comment ? `<div class="kv"><span>Customer comment</span><span>${escapeHtml(s.customer_comment)}</span></div>` : ''}`;

    els.drawerBody.innerHTML = `
      <div class="detail-section">
        <h3>Overview</h3>
        <div class="kv"><span>Status</span><span>${s.status}</span></div>
        <div class="kv"><span>Source</span><span>${s.source === 'intake' ? 'Customer request' : 'Manager'}</span></div>
        ${s.description ? `<div class="kv"><span>Problem</span><span>${escapeHtml(s.description)}</span></div>` : ''}
        ${s.requester_name ? `<div class="kv"><span>Requester</span><span>${escapeHtml(s.requester_name)} · ${escapeHtml(s.requester_phone || '')} · ${escapeHtml(s.requester_email || '')}</span></div>` : ''}
        ${s.purchase_date ? `<div class="kv"><span>Purchased</span><span>${new Date(s.purchase_date).toLocaleDateString()}</span></div>` : ''}
        ${s.warranty_status ? `<div class="kv"><span>Warranty</span><span>${escapeHtml(s.warranty_status)}${s.warranty_auto === 1 ? ' · in warranty' : s.warranty_auto === 0 ? ' · expired' : ''}</span></div>` : ''}
        ${s.bill_file_id ? `<div class="kv"><span>Bill</span><span><a href="/api/files/${s.bill_file_id}?token=${encodeURIComponent(store.token)}" target="_blank" rel="noopener">View bill</a></span></div>` : ''}
        ${s.scheduled_at ? `<div class="kv"><span>Scheduled</span><span>${fmtTime(s.scheduled_at)}</span></div>` : ''}
        <div class="kv"><span>Created</span><span>${fmtTime(s.created_at)}</span></div>
        <div class="kv"><span>Ended</span><span>${fmtTime(s.ended_at)}</span></div>
        <div class="kv"><span>Messages</span><span>${rec.summary.messageCount}</span></div>
      </div>
      <div class="detail-section"><h3>Resolution &amp; feedback</h3>${feedback}</div>
      <div class="detail-section"><h3>Participants</h3><div class="plist">${participants || '<span class="muted">None</span>'}</div></div>
      <div class="detail-section"><h3>Recordings</h3><div class="plist">${recordings || '<span class="muted">None</span>'}</div></div>
      <div class="detail-section"><h3>Event log</h3><div class="event-log">${events || '<span class="muted">None</span>'}</div></div>`;
    els.drawer.classList.remove('hidden');
  } catch (err) {
    banner(err.message || 'Could not load session', 'error');
  }
}

async function refresh() {
  try {
    const [overview, sessions] = await Promise.all([api('/api/admin/overview'), api('/api/admin/sessions')]);
    els.managers.textContent = overview.managers;
    els.agents.textContent = overview.agents;
    els.active.textContent = overview.activeSessions;
    els.connected.textContent = overview.connectedParticipants;
    els.total.textContent = overview.totalSessions;
    const live = sessions.filter((s) => s.status === 'active');
    const history = sessions.filter((s) => s.status === 'ended');
    els.liveCount.textContent = `${live.length} active`;
    renderList(els.live, live, 'No active sessions right now.');
    renderList(els.history, history, 'No past sessions yet.');
  } catch (err) {
    if (err.status === 401) window.location.replace('/login.html');
  }
}

loadManagers();
refresh();
setInterval(() => {
  refresh();
  loadManagers();
}, 5000);
