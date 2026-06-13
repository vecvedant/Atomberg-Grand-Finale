import { CallApp } from './call.js';
import { api } from './common.js';
import { wireScheduleLater } from './schedule-later.js';

const params = new URLSearchParams(window.location.search);
const inviteToken = params.get('token');

const prejoin = document.getElementById('prejoin');
const callView = document.getElementById('call');
const subtitle = document.getElementById('joinSubtitle');
const joinForm = document.getElementById('joinForm');
const joinError = document.getElementById('joinError');
const joinBtn = document.getElementById('joinBtn');

let sessionInfo = null;
let waitTimer = null;
let scheduledLater = false;

// "No agent yet? Schedule for later" — convert a waiting request into a booked one.
const sched = inviteToken
  ? wireScheduleLater(inviteToken, (iso) => {
      scheduledLater = true;
      sched.hide();
      stopWaiting();
      const when = new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      subtitle.textContent = `Your call is now scheduled for ${when}. You can close this page — come back to this link or your tracking page to join once an agent picks it up.`;
    })
  : { show() {}, hide() {} };

init();

async function init() {
  if (!inviteToken) {
    subtitle.textContent = '';
    joinError.textContent = 'This link is missing an invite token. Please use the link from your support request.';
    return;
  }
  await refresh();
}

async function refresh() {
  if (scheduledLater) return; // customer booked a later slot from the waiting room
  try {
    const info = await api(`/api/sessions/invite/${encodeURIComponent(inviteToken)}`, { auth: false });
    if (!info.valid) throw new Error('Invalid invite');
    sessionInfo = info;

    document.getElementById('joinTitle').textContent = info.title || 'Your support request';
    if (info.description) {
      document.getElementById('problemText').textContent = info.description;
      document.getElementById('problemBox').classList.remove('hidden');
    }

    if (info.ended) {
      stopWaiting();
      sched.hide();
      joinForm.classList.add('hidden');
      subtitle.textContent = '';
      joinError.textContent = 'This support session has ended.';
      return;
    }

    if (!info.accepted) {
      // No agent has picked it up yet — show a waiting screen and keep checking.
      joinForm.classList.add('hidden');
      joinError.textContent = '';
      // Live caller still waiting? Offer to book a later slot instead.
      if (!info.scheduledAt && info.canSchedule) sched.show();
      else sched.hide();
      if (info.scheduledAt) {
        const when = new Date(info.scheduledAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        subtitle.textContent = `Thanks! Your call is scheduled for ${when}. We'll line up an agent for around then — this page lets you in automatically once they accept.`;
      } else if (info.queuePosition) {
        const n = info.queuePosition;
        subtitle.textContent =
          n === 1
            ? "You're on the line — our agent will pick you up soon. You're next in the queue."
            : `You're on the line — our agent will pick you up soon. You're number ${n} in the queue.`;
      } else {
        subtitle.textContent =
          "You're on the line — our agent will pick you up soon. This page will let you in automatically.";
      }
      startWaiting();
      return;
    }

    // An agent has accepted — let the customer join.
    stopWaiting();
    sched.hide();
    if (info.requesterName) document.getElementById('displayName').value = info.requesterName;
    if (info.requesterPhone) document.getElementById('phone').value = info.requesterPhone;
    if (info.requesterEmail) document.getElementById('email').value = info.requesterEmail;
    subtitle.textContent = 'An agent is ready. Confirm your details to join the call.';
    joinForm.classList.remove('hidden');
  } catch (err) {
    stopWaiting();
    subtitle.textContent = '';
    joinError.textContent = err.message || 'This link is invalid or has expired.';
  }
}

function startWaiting() {
  if (waitTimer) return;
  waitTimer = setInterval(refresh, 4000);
}
function stopWaiting() {
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = null;
}

joinBtn.addEventListener('click', () => {
  const name = document.getElementById('displayName').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const email = document.getElementById('email').value.trim();
  if (!name || !phone || !email) {
    joinError.textContent = 'Please enter your name, mobile number, and email.';
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    joinError.textContent = 'Please enter a valid email address.';
    return;
  }
  startCall(name, phone, email);
});

function startCall(displayName, phone, email) {
  stopWaiting();
  prejoin.classList.add('hidden');
  callView.classList.remove('hidden');
  document.getElementById('sessionTitleLabel').textContent = sessionInfo.title;

  const app = new CallApp({
    role: 'customer',
    isAgent: false,
    token: inviteToken,
    sessionId: sessionInfo.sessionId,
    displayName,
    phone,
    email,
  });
  window.__call = app;
  app.connect();

  import('./webrtc.js')
    .then(({ attachMedia }) => attachMedia(app, { publish: true }))
    .catch(() => {
      /* chat/presence still work without media */
    });
}
