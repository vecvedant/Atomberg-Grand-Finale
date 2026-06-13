// Agent-only recording controls. Wires the Record button to socket start/stop
// and reflects status (recording → processing → ready) in the workflow panel.
import { store, banner } from './common.js';

export function wireRecording(app) {
  const btn = document.getElementById('btnRecord');
  if (!btn) return;
  let state = 'idle';

  const updateBtn = () => {
    btn.disabled = state === 'processing';
    if (state === 'recording') {
      btn.textContent = 'Stop recording';
      btn.classList.add('toggled-off');
    } else if (state === 'processing') {
      btn.textContent = 'Processing';
    } else {
      btn.textContent = 'Record';
      btn.classList.remove('toggled-off');
    }
  };

  app.socket.on('recording-status', (s) => {
    state = s.status === 'failed' ? 'idle' : s.status;
    const downloadUrl =
      s.status === 'ready' && s.recordingId
        ? `/api/recordings/${s.recordingId}/download?token=${encodeURIComponent(store.token || '')}`
        : undefined;
    app.setRecording({ status: state, downloadUrl });
    updateBtn();
    if (s.status === 'ready') banner('Recording ready', 'success');
    else if (s.status === 'failed') banner('Recording failed', 'error');
  });

  btn.addEventListener('click', () => {
    const ev = state === 'recording' ? 'stop-recording' : 'start-recording';
    app.socket.emit(ev, {}, (r) => {
      if (!r?.ok) banner(r?.error || 'Recording action failed', 'error');
    });
  });

  updateBtn();
}
