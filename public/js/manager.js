import { api, store, banner, escapeHtml, installAuthBackGuard } from './common.js';

if (!store.token || store.user?.role !== 'manager') window.location.replace('/login.html');
window.addEventListener('pageshow', () => {
  if (!store.token) window.location.replace('/login.html');
});
// Leaving the profile via the Back button signs the user out.
installAuthBackGuard();

document.getElementById('logoutBtn').addEventListener('click', () => {
  store.clearAuth();
  window.location.replace('/login.html');
});

/* ----- modals ----- */
const pwModal = document.getElementById('pwModal');
const addAgentModal = document.getElementById('addAgentModal');
const resetModal = document.getElementById('resetModal');
const drawer = document.getElementById('drawer');
let resetTargetId = null;

document.getElementById('changePwBtn').addEventListener('click', () => pwModal.classList.remove('hidden'));
document.getElementById('pwCancel').addEventListener('click', () => pwModal.classList.add('hidden'));
document.getElementById('addAgentBtn').addEventListener('click', () => addAgentModal.classList.remove('hidden'));
document.getElementById('agCancel').addEventListener('click', () => addAgentModal.classList.add('hidden'));
document.getElementById('resetCancel').addEventListener('click', () => resetModal.classList.add('hidden'));
document.getElementById('drawerClose').addEventListener('click', () => drawer.classList.add('hidden'));
drawer.addEventListener('click', (e) => {
  if (e.target === drawer) drawer.classList.add('hidden');
});

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
  } catch (e) {
    err.textContent = e.message || 'Could not update password';
  }
});

document.getElementById('agSave').addEventListener('click', async () => {
  const err = document.getElementById('agError');
  err.textContent = '';
  try {
    await api('/api/manager/agents', {
      method: 'POST',
      body: {
        username: document.getElementById('agUsername').value.trim(),
        displayName: document.getElementById('agDisplay').value.trim(),
        employeeId: document.getElementById('agEmployeeId').value.trim(),
        phone: document.getElementById('agPhone').value.trim(),
        email: document.getElementById('agEmail').value.trim(),
        password: document.getElementById('agPassword').value,
      },
    });
    banner('Agent added', 'success');
    addAgentModal.classList.add('hidden');
    for (const id of ['agUsername', 'agDisplay', 'agEmployeeId', 'agPhone', 'agEmail', 'agPassword'])
      document.getElementById(id).value = '';
    loadMe();
  } catch (e) {
    err.textContent = e.message || 'Could not add agent';
  }
});

document.getElementById('resetSave').addEventListener('click', async () => {
  const err = document.getElementById('resetError');
  err.textContent = '';
  try {
    await api(`/api/manager/agents/${resetTargetId}/reset-password`, {
      method: 'POST',
      body: { newPassword: document.getElementById('resetPw').value },
    });
    banner('Password reset', 'success');
    resetModal.classList.add('hidden');
    document.getElementById('resetPw').value = '';
  } catch (e) {
    err.textContent = e.message || 'Could not reset';
  }
});

/* ----- create task ----- */
document.getElementById('createTaskBtn').addEventListener('click', async () => {
  const err = document.getElementById('taskError');
  err.textContent = '';
  const schedRaw = document.getElementById('taskSchedule').value;
  const body = {
    title: document.getElementById('taskTitle').value.trim() || undefined,
    description: document.getElementById('taskDesc').value.trim(),
  };
  if (schedRaw) body.scheduledAt = new Date(schedRaw).toISOString();
  try {
    await api('/api/tasks', { method: 'POST', body });
    banner('Task posted to your team', 'success');
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDesc').value = '';
    document.getElementById('taskSchedule').value = '';
    loadTasks();
    loadMe();
  } catch (e) {
    err.textContent = e.message || 'Could not post task';
  }
});

/* ----- dashboard ----- */
async function loadMe() {
  try {
    const me = await api('/api/manager/me');
    const cards = [
      ['Agents', me.agentCount],
      ['Open tasks', me.openTasks],
      ['Accepted', me.totalAccepted],
      ['Completed', me.totalCompleted],
      ['Resolved', me.totalResolved],
      ['Avg rating', me.avgRating == null ? '—' : `${me.avgRating} / 5`],
    ];
    document.getElementById('mgrStats').innerHTML = cards
      .map(([l, n]) => `<div class="stat"><span class="stat-num">${n}</span><span class="stat-label">${l}</span></div>`)
      .join('');
    renderAgents(me.agents);
  } catch (e) {
    if (e.status === 401) window.location.replace('/login.html');
  }
}

function renderAgents(agents) {
  const list = document.getElementById('agentList');
  if (!agents.length) {
    list.innerHTML = '<div class="empty-row">No agents yet. Add one to start assigning tasks.</div>';
    return;
  }
  list.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'sess-item';
    const contact = [a.employeeId ? `ID ${escapeHtml(a.employeeId)}` : null, a.phone ? escapeHtml(a.phone) : null, a.email ? escapeHtml(a.email) : null]
      .filter(Boolean)
      .join(' · ');
    el.innerHTML = `
      <div class="grow">
        <div class="s-title">${escapeHtml(a.displayName)} <span class="muted">@${escapeHtml(a.username)}</span></div>
        ${contact ? `<div class="s-desc">${contact}</div>` : ''}
        <div class="s-when">Accepted ${a.accepted} · Completed ${a.completed} · Resolved ${a.resolved} · Rating ${a.avgRating == null ? '—' : a.avgRating + '/5'}</div>
      </div>
      <div class="actions"></div>`;
    const report = document.createElement('button');
    report.className = 'secondary';
    report.textContent = 'Report';
    report.addEventListener('click', () => openReport(a));
    const reset = document.createElement('button');
    reset.className = 'secondary';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      resetTargetId = a.agentId;
      document.getElementById('resetWho').textContent = `New password for ${a.displayName} (@${a.username})`;
      resetModal.classList.remove('hidden');
    });
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove agent ${a.displayName}?`)) return;
      try {
        await api(`/api/manager/agents/${a.agentId}`, { method: 'DELETE' });
        banner('Agent removed', 'success');
        loadMe();
      } catch (e) {
        banner(e.message || 'Could not remove', 'error');
      }
    });
    el.querySelector('.actions').append(report, reset, remove);
    list.appendChild(el);
  }
}

async function openReport(a) {
  try {
    const rows = await api(`/api/manager/agents/${a.agentId}/report`);
    document.getElementById('drawerTitle').textContent = `${a.displayName} — task report`;
    const yn = (v) => (v === 1 ? 'Yes' : v === 0 ? 'No' : '—');
    const body =
      rows.length === 0
        ? '<p class="muted">No tasks handled yet.</p>'
        : `<table class="report-table"><thead><tr><th>Task</th><th>Problem</th><th>Status</th><th>Resolved</th><th>Rating</th></tr></thead><tbody>${rows
            .map(
              (r) =>
                `<tr><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.problem || '—')}</td><td>${r.status}</td><td>${yn(r.resolved)}</td><td>${r.customerRating ? r.customerRating + '/5' : '—'}</td></tr>`,
            )
            .join('')}</tbody></table>`;
    document.getElementById('drawerBody').innerHTML = `<div class="detail-section">${body}</div>`;
    drawer.classList.remove('hidden');
  } catch (e) {
    banner(e.message || 'Could not load report', 'error');
  }
}

async function loadTasks() {
  const list = document.getElementById('taskList');
  try {
    const tasks = await api('/api/manager/tasks');
    if (!tasks.length) {
      list.innerHTML = '<div class="empty-row">No tasks yet.</div>';
      return;
    }
    list.innerHTML = tasks
      .map((t) => {
        const meta = [
          t.source === 'intake' ? 'Self-service' : null,
          t.scheduledAt ? 'Scheduled ' + new Date(t.scheduledAt).toLocaleString() : null,
          t.requesterName ? escapeHtml(t.requesterName) : null,
          t.purchaseDate ? 'Bought ' + new Date(t.purchaseDate).toLocaleDateString() : null,
          t.warrantyStatus ? `Warranty: ${t.warrantyStatus}${t.warrantyAuto === 1 ? ' (in)' : t.warrantyAuto === 0 ? ' (exp)' : ''}` : null,
          t.billFileId
            ? `<a href="/api/files/${t.billFileId}?token=${encodeURIComponent(store.token)}" target="_blank" rel="noopener">Bill</a>`
            : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return `
        <div class="sess-item">
          <div class="grow">
            <div class="s-title">${escapeHtml(t.title)}</div>
            ${t.description ? `<div class="s-desc">${escapeHtml(t.description)}</div>` : ''}
            ${meta ? `<div class="s-when">${meta}</div>` : ''}
            <div class="s-when">${t.agent ? 'Agent: ' + escapeHtml(t.agent) : 'Unassigned'} · ${new Date(t.createdAt).toLocaleString()}</div>
          </div>
          <span class="tag ${t.status}">${t.status}</span>
        </div>`;
      })
      .join('');
  } catch {
    list.innerHTML = '<div class="empty-row">Could not load tasks.</div>';
  }
}

loadMe();
loadTasks();
setInterval(() => {
  loadMe();
  loadTasks();
}, 6000);
