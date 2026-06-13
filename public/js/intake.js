import { banner } from './common.js';
import { wireScheduleLater } from './schedule-later.js';

let warranty = null;
const warrantyBtns = document.querySelectorAll('#warranty button');
warrantyBtns.forEach((b) =>
  b.addEventListener('click', () => {
    warranty = b.dataset.val;
    warrantyBtns.forEach((x) => x.classList.toggle('selected', x === b));
  }),
);

// "As soon as possible" vs "Schedule for later" — reveal the date/time picker for the latter.
let when = 'now';
const whenBtns = document.querySelectorAll('#when button');
const scheduleField = document.getElementById('scheduleField');
whenBtns.forEach((b) =>
  b.addEventListener('click', () => {
    when = b.dataset.val;
    whenBtns.forEach((x) => x.classList.toggle('selected', x === b));
    scheduleField.classList.toggle('hidden', when !== 'later');
  }),
);

const submitBtn = document.getElementById('submitBtn');

submitBtn.addEventListener('click', async () => {
  const err = document.getElementById('intakeError');
  err.textContent = '';
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const email = document.getElementById('email').value.trim();
  const problem = document.getElementById('problem').value.trim();
  const purchaseDate = document.getElementById('purchaseDate').value;
  const scheduleRaw = document.getElementById('scheduleAt').value;
  const billFile = document.getElementById('bill').files?.[0];

  if (!name || !phone || !email || !problem) {
    err.textContent = 'Please fill in your name, mobile, email, and problem.';
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    err.textContent = 'Please enter a valid email address.';
    return;
  }

  let scheduledAt = null;
  if (when === 'later') {
    if (!scheduleRaw) {
      err.textContent = 'Please pick a date and time for your call, or choose "As soon as possible".';
      return;
    }
    const picked = new Date(scheduleRaw);
    if (Number.isNaN(picked.getTime()) || picked.getTime() <= Date.now()) {
      err.textContent = 'Please pick a date and time in the future.';
      return;
    }
    scheduledAt = picked.toISOString();
  }

  const fd = new FormData();
  fd.append('name', name);
  fd.append('phone', phone);
  fd.append('email', email);
  fd.append('problem', problem);
  if (purchaseDate) fd.append('purchaseDate', purchaseDate);
  if (warranty) fd.append('warranty', warranty);
  if (scheduledAt) fd.append('scheduledAt', scheduledAt);
  if (billFile) fd.append('bill', billFile);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  try {
    const res = await fetch('/api/intake', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not submit request');
    document.getElementById('intakeWrap').classList.add('hidden');
    document.getElementById('doneWrap').classList.remove('hidden');
    if (data.reference) {
      document.getElementById('doneRef').textContent = data.reference;
      document.getElementById('trackHere').href = `/track.html?ref=${encodeURIComponent(data.reference)}`;
    }
    awaitAcceptance(data.joinUrl, data.scheduledAt);
  } catch (e) {
    err.textContent = e.message || 'Could not submit request';
    banner('Submission failed', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit request';
  }
});

// On the thank-you screen, keep the Join button inactive until an agent accepts.
function awaitAcceptance(joinUrl, scheduledAt) {
  const token = new URL(joinUrl, location.origin).searchParams.get('token');
  const joinLink = document.getElementById('joinLink');
  const msg = document.getElementById('doneMsg');
  const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  let whenText = scheduledAt ? fmt(scheduledAt) : null;

  // "No agent yet? Schedule for later" — convert this waiting request into a booked one.
  const sched = wireScheduleLater(token, (iso) => {
    whenText = fmt(iso);
    sched.hide();
    msg.textContent = `Your call is now scheduled for ${whenText}. Come back to your tracking page to join — this button activates once an agent picks it up.`;
    joinLink.textContent = `Scheduled for ${whenText}`;
    banner('Your call has been scheduled', 'success');
  });

  const showLiveState = () => {
    msg.textContent = "You're on the line. Our agent will pick you up soon — this button activates automatically the moment they do.";
    joinLink.textContent = 'Waiting in the queue…';
    sched.show();
  };
  if (whenText) {
    msg.textContent = `Your call is scheduled for ${whenText}. We'll line up an agent for around then — come back to your tracking page to join, or use this button once it's accepted.`;
    joinLink.textContent = `Scheduled for ${whenText}`;
  } else {
    showLiveState();
  }
  joinLink.removeAttribute('href');
  joinLink.classList.add('is-waiting');

  const poll = async () => {
    try {
      const inv = await fetch(`/api/sessions/invite/${encodeURIComponent(token)}`).then((r) => r.json());
      if (!inv?.valid) return;
      if (inv.ended) {
        clearInterval(timer);
        sched.hide();
        joinLink.classList.add('is-waiting');
        joinLink.removeAttribute('href');
        joinLink.textContent = 'This request was closed';
        msg.textContent = 'This request is no longer active.';
        return;
      }
      // Live "get on the line" caller — keep the queue position fresh while waiting.
      if (!inv.accepted && !whenText && inv.queuePosition) {
        const n = inv.queuePosition;
        msg.textContent = `You're on the line — our agent will pick you up soon. ${n === 1 ? "You're next in the queue." : `You're number ${n} in the queue.`}`;
        joinLink.textContent = n === 1 ? "You're next — waiting for an agent…" : `In the queue · position ${n}`;
        sched.show();
      }
      if (inv.accepted) {
        clearInterval(timer);
        sched.hide();
        joinLink.href = joinUrl;
        joinLink.classList.remove('is-waiting');
        joinLink.textContent = 'Join the call';
        msg.textContent = 'An agent has accepted your request. Click below to join the call now.';
      }
    } catch {
      /* keep polling */
    }
  };
  const timer = setInterval(poll, 4000);
  poll();
}
