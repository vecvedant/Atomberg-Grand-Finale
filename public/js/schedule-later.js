// Wires up the "no agent yet? schedule for later" control shown in the waiting
// room. A customer still waiting in the live queue can convert their open request
// into a scheduled-for-later one (authorized by their invite token). Both the
// intake thank-you screen and the customer join page reuse this.
export function wireScheduleLater(token, onScheduled) {
  const box = document.getElementById('schedLaterBox');
  const btn = document.getElementById('schedLaterBtn');
  const form = document.getElementById('schedLaterForm');
  const input = document.getElementById('schedLaterInput');
  const confirm = document.getElementById('schedLaterConfirm');
  const err = document.getElementById('schedLaterErr');
  if (!box) return { show() {}, hide() {} };

  btn.addEventListener('click', () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) input.focus();
  });

  confirm.addEventListener('click', async () => {
    err.textContent = '';
    const raw = input.value;
    if (!raw) {
      err.textContent = 'Please pick a date and time.';
      return;
    }
    const picked = new Date(raw);
    if (Number.isNaN(picked.getTime()) || picked.getTime() <= Date.now()) {
      err.textContent = 'Please pick a date and time in the future.';
      return;
    }
    confirm.disabled = true;
    try {
      const res = await fetch(`/api/sessions/invite/${encodeURIComponent(token)}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: picked.toISOString() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not schedule your call.');
      onScheduled(data.scheduledAt);
    } catch (e) {
      err.textContent = e.message || 'Could not schedule your call.';
      confirm.disabled = false;
    }
  });

  return {
    show() {
      box.classList.remove('hidden');
    },
    hide() {
      box.classList.add('hidden');
      form.classList.add('hidden');
    },
  };
}
