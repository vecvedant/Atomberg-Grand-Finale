// Core in-call controller shared by the agent console and the customer view.
// Owns the Socket.IO connection, roster/video tiles, chat, the workflow panel,
// and media toggles. WebRTC media (Phase 2) plugs in via attachMedia().

import { api, store, initials, escapeHtml, banner, elapsed, fmtBytes } from './common.js';

export class CallApp {
  /** @param {{role:string, isAgent:boolean, token:string, sessionId:string, displayName:string}} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.socket = null;
    this.participantId = null;
    this.roster = [];
    this.startMs = Date.now();
    this.recording = { active: false, status: 'idle' };
    this.media = null; // set by attachMedia() in Phase 2
    this.tiles = new Map(); // participantId -> { el, videoEl }
    this.timer = null;

    this.el = {
      stage: document.getElementById('stage'),
      messages: document.getElementById('messages'),
      composerForm: document.getElementById('composerForm'),
      composerInput: document.getElementById('composerInput'),
      btnMic: document.getElementById('btnMic'),
      btnCam: document.getElementById('btnCam'),
      btnEnd: document.getElementById('btnEnd'),
      btnLeave: document.getElementById('btnLeave'),
      wfStatus: document.getElementById('wfStatus'),
      wfPeerName: document.getElementById('wfPeerName'),
      wfPeerPhone: document.getElementById('wfPeerPhone'),
      wfPeerEmail: document.getElementById('wfPeerEmail'),
      wfPurchase: document.getElementById('wfPurchase'),
      wfWarranty: document.getElementById('wfWarranty'),
      wfBill: document.getElementById('wfBill'),
      wfDuration: document.getElementById('wfDuration'),
      wfRecording: document.getElementById('wfRecording'),
      topStatus: document.getElementById('topStatus'),
      recPill: document.getElementById('recPill'),
      recBanner: document.getElementById('recBanner'),
      btnDevices: document.getElementById('btnDevices'),
      devicePanel: document.getElementById('devicePanel'),
      cameraSelect: document.getElementById('cameraSelect'),
      micSelect: document.getElementById('micSelect'),
    };
  }

  connect() {
    const auth = {
      token: this.cfg.token,
      displayName: this.cfg.displayName,
    };
    if (this.cfg.isAgent) auth.sessionId = this.cfg.sessionId;
    if (this.cfg.phone) auth.phone = this.cfg.phone;
    if (this.cfg.email) auth.email = this.cfg.email;
    const prior = sessionStorage.getItem(`pid_${this.cfg.sessionId}`);
    if (prior) auth.participantId = prior;

    // eslint-disable-next-line no-undef
    this.socket = io({ auth, reconnectionAttempts: 10, reconnectionDelay: 800 });
    this._wireSocket();
    this._bindControls();
    this._startTimer();
    this.renderRequest();
    this.setStatus('connecting', 'Connecting…');
    this._installExitGuards();
  }

  // Keep the browser Back button and page exits smooth: tear down the camera +
  // socket whenever we leave, and make Back during a live call leave it cleanly
  // instead of abandoning a zombie session with the camera still on.
  _installExitGuards() {
    this._onPageHide = () => this._cleanup();
    window.addEventListener('pagehide', this._onPageHide);
    history.pushState({ inCall: true }, '');
    this._onPopState = () => {
      if (this._left) return;
      this.leave();
    };
    window.addEventListener('popstate', this._onPopState);
  }

  _wireSocket() {
    const s = this.socket;

    s.on('connect_error', (err) => {
      this.setStatus('error', err.message || 'Connection error');
      banner(err.message || 'Connection failed', 'error');
    });

    s.on('joined', (data) => {
      this.participantId = data.participantId;
      // Remember our participant id so an auto-reconnect re-enters the same slot.
      sessionStorage.setItem(`pid_${this.cfg.sessionId}`, data.participantId);
      this.socket.auth.participantId = data.participantId;
      this.roster = data.roster || [];
      this.setStatus('connected', 'Connected');
      this.renderRoster();
      if (data.reconnected) banner('Reconnected', 'success');
      this._loadHistory();
      if (this.media) this.media.onJoined();
    });

    s.on('roster', ({ roster }) => {
      this.roster = roster || [];
      this.renderRoster();
    });

    s.on('participant-joined', (p) => {
      this.systemMessage(`${p.displayName} joined`);
      if (this.media) this.media.onPeerJoined(p);
    });

    s.on('participant-left', (p) => {
      this.systemMessage(`${p.displayName} left`);
      if (this.media) this.media.onPeerLeft(p);
    });

    s.on('participant-media', ({ participantId, media }) => {
      const entry = this.roster.find((r) => r.participantId === participantId);
      if (entry) entry.media = media;
      this.renderRoster();
    });

    s.on('chat-message', (m) => {
      this.addMessage(m);
    });

    s.on('session-ended', ({ endedBy }) => {
      this.setStatus('ended', 'Session ended');
      banner(`Session ended${endedBy ? ` by ${endedBy}` : ''}`);
      const dest = this.cfg.isAgent ? '/agent.html' : this._customerExitUrl();
      this._cleanup();
      setTimeout(() => window.location.replace(dest), 1500);
    });

    s.on('disconnect', (reason) => {
      if (reason === 'io server disconnect' || reason === 'io client disconnect') return;
      this.setStatus('reconnecting', 'Reconnecting…');
    });

    // Phase 2 SFU signaling is handled inside the media controller, which
    // listens on this same socket.
  }

  _bindControls() {
    this.el.composerForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendChat();
    });
    this.el.composerInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChat();
      }
    });
    this.el.btnMic?.addEventListener('click', () => this.toggleAudio());
    this.el.btnCam?.addEventListener('click', () => this.toggleVideo());
    this.el.btnEnd?.addEventListener('click', () => this.endSession());
    this.el.btnLeave?.addEventListener('click', () => this.leave());

    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) this.uploadFile(f);
      fileInput.value = '';
    });

    this.el.btnDevices?.addEventListener('click', () => this.toggleDevicePanel());
    this.el.cameraSelect?.addEventListener('change', () => this.media?.switchCamera(this.el.cameraSelect.value));
    this.el.micSelect?.addEventListener('change', () => this.media?.switchMic(this.el.micSelect.value));
  }

  async toggleDevicePanel() {
    const p = this.el.devicePanel;
    if (!p) return;
    const willShow = p.classList.contains('hidden');
    p.classList.toggle('hidden');
    if (willShow && this.media) await this.populateDevices();
  }

  async populateDevices() {
    const info = await this.media.listDevices();
    const fill = (sel, items, current) => {
      if (!sel) return;
      sel.innerHTML = '';
      for (const d of items) {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${d.kind} ${sel.length + 1}`;
        if (d.deviceId === current) o.selected = true;
        sel.appendChild(o);
      }
    };
    fill(this.el.cameraSelect, info.cameras, info.currentCam);
    fill(this.el.micSelect, info.mics, info.currentMic);
  }

  async uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('participantId', this.participantId || '');
    try {
      const res = await fetch(`/api/files/${this.cfg.sessionId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      this.sendFileMessage(data.id, data.name);
    } catch (err) {
      banner(err.message || 'Upload failed', 'error');
    }
  }

  _startTimer() {
    this.timer = setInterval(() => {
      if (this.el.wfDuration) this.el.wfDuration.textContent = elapsed(this.startMs);
    }, 1000);
  }

  async _loadHistory() {
    // Pull persisted chat so late-joiners / reconnects see prior messages.
    try {
      if (!this.cfg.isAgent) return; // customers get live messages; history endpoint is staff-only
      const msgs = await api(`/api/sessions/${this.cfg.sessionId}/messages`);
      this.el.messages.innerHTML = '';
      for (const m of msgs) this.addMessage(m, true);
    } catch {
      /* non-fatal */
    }
  }

  /* ---------------- roster / tiles ---------------- */
  renderRoster() {
    const stage = this.el.stage;
    if (!stage) return;
    const present = new Set(this.roster.map((r) => r.participantId));

    // Remove tiles for participants no longer present.
    for (const [pid, tile] of this.tiles) {
      if (!present.has(pid)) {
        tile.el.remove();
        this.tiles.delete(pid);
      }
    }

    for (const r of this.roster) {
      let tile = this.tiles.get(r.participantId);
      if (!tile) {
        tile = this._makeTile(r);
        this.tiles.set(r.participantId, tile);
        stage.appendChild(tile.el);
        if (this.media) this.media.onTileCreated(r, tile);
      }
      this._updateTile(tile, r);
    }

    if (this.roster.length === 0) this._renderWaiting();
    this.updateWorkflow();
  }

  _renderWaiting() {
    // No-op: tiles cover state. Workflow panel shows "waiting".
  }

  _makeTile(r) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `
      <div class="avatar">${escapeHtml(initials(r.displayName))}</div>
      <video autoplay playsinline class="hidden" ${r.participantId === this.participantId ? 'muted' : ''}></video>
      <span class="role-tag">${escapeHtml(r.role)}</span>
      <div class="nameplate">
        <span class="mic"></span>
        <span class="pname">${escapeHtml(r.displayName)}${r.participantId === this.participantId ? ' (you)' : ''}</span>
      </div>`;
    return { el, videoEl: el.querySelector('video'), avatarEl: el.querySelector('.avatar') };
  }

  _updateTile(tile, r) {
    const mic = tile.el.querySelector('.mic');
    if (mic) {
      mic.textContent = r.media?.audio === false ? 'Muted' : '';
      mic.className = r.media?.audio === false ? 'mic mic-off' : 'mic';
    }
    // Show avatar when camera is off or no stream yet; video element otherwise.
    const hasVideo = tile.videoEl && tile.videoEl.srcObject && r.media?.video !== false;
    if (tile.avatarEl) tile.avatarEl.classList.toggle('hidden', !!hasVideo);
    if (tile.videoEl) tile.videoEl.classList.toggle('hidden', !hasVideo);
  }

  /* ---------------- chat ---------------- */
  sendChat() {
    const input = this.el.composerInput;
    const body = (input?.value || '').trim();
    if (!body) return;
    this.socket.emit('chat-message', { body }, (res) => {
      if (!res?.ok) banner(res?.error || 'Message failed', 'error');
    });
    input.value = '';
  }

  sendFileMessage(fileId, name) {
    this.socket.emit('chat-message', { fileId, body: '' }, (res) => {
      if (!res?.ok) banner(res?.error || 'Share failed', 'error');
    });
  }

  addMessage(m, isHistory = false) {
    const mine = m.senderParticipantId && m.senderParticipantId === this.participantId;
    const wrap = document.createElement('div');
    wrap.className = `msg ${mine ? 'mine' : ''}`;
    const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let fileHtml = '';
    if (m.file) {
      const url = `/api/files/${m.file.id}?token=${encodeURIComponent(store.token || this.cfg.token)}`;
      fileHtml = `<a class="file-link" href="${url}" target="_blank" rel="noopener">${escapeHtml(m.file.name)} (${fmtBytes(
        m.file.size,
      )})</a>`;
    }
    wrap.innerHTML = `
      <div class="meta">${escapeHtml(m.senderName || 'Unknown')} · ${time}</div>
      <div class="bubble">${escapeHtml(m.body || '')}${fileHtml}</div>`;
    this.el.messages.appendChild(wrap);
    if (!isHistory) this.el.messages.scrollTop = this.el.messages.scrollHeight;
    else this.el.messages.scrollTop = this.el.messages.scrollHeight;
  }

  systemMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg system';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    this.el.messages.appendChild(wrap);
    this.el.messages.scrollTop = this.el.messages.scrollHeight;
  }

  /* ---------------- media toggles ---------------- */
  toggleAudio() {
    const on = this.media ? this.media.toggleAudio() : this._localFlagToggle('audio');
    this.el.btnMic?.classList.toggle('toggled-off', !on);
    if (this.el.btnMic) this.el.btnMic.textContent = on ? 'Mute' : 'Unmute';
    this.socket.emit('media-state', { audio: on });
  }

  toggleVideo() {
    const on = this.media ? this.media.toggleVideo() : this._localFlagToggle('video');
    this.el.btnCam?.classList.toggle('toggled-off', !on);
    if (this.el.btnCam) this.el.btnCam.textContent = on ? 'Stop video' : 'Start video';
    this.socket.emit('media-state', { video: on });
  }

  // Fallback toggles when there's no media stream yet (Phase 1).
  _localFlagToggle(kind) {
    this._localFlags = this._localFlags || { audio: true, video: true };
    this._localFlags[kind] = !this._localFlags[kind];
    return this._localFlags[kind];
  }

  /* ---------------- session control ---------------- */
  endSession() {
    // Agent pages supply onEndRequested to capture a resolution before ending.
    if (this.cfg.onEndRequested) {
      this.cfg.onEndRequested();
      return;
    }
    if (!confirm('End this session for everyone?')) return;
    this.confirmEnd();
  }

  confirmEnd() {
    this.socket.emit('end-session', {}, (res) => {
      if (!res?.ok) banner(res?.error || 'Could not end session', 'error');
    });
  }

  leave() {
    if (this._left) return;
    const dest = this.cfg.isAgent ? '/agent.html' : this._customerExitUrl();
    try {
      this.socket.emit('leave');
    } catch {
      /* socket may be gone */
    }
    this._cleanup();
    window.location.replace(dest);
  }

  _customerExitUrl() {
    return `/feedback.html?session=${encodeURIComponent(this.cfg.sessionId)}&token=${encodeURIComponent(this.cfg.token)}`;
  }

  _cleanup() {
    if (this._left) return;
    this._left = true;
    clearInterval(this.timer);
    if (this.media) this.media.stop();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('popstate', this._onPopState);
    sessionStorage.removeItem(`pid_${this.cfg.sessionId}`);
  }

  /* ---------------- workflow panel ---------------- */
  setStatus(state, label) {
    const map = { connecting: 'amber', connected: 'green', reconnecting: 'amber', ended: 'grey', error: 'red' };
    const dot = map[state] || 'grey';
    if (this.el.wfStatus) this.el.wfStatus.innerHTML = `<span class="status-dot ${dot}"></span>${label}`;
    if (this.el.topStatus) {
      this.el.topStatus.className = `pill ${state === 'connected' ? 'live' : ''}`;
      this.el.topStatus.innerHTML = `<span class="led"></span>${label}`;
    }
  }

  // Static request context for the agent panel (from the accepted task).
  renderRequest() {
    if (this.el.wfPurchase) {
      this.el.wfPurchase.textContent = this.cfg.purchaseDate ? new Date(this.cfg.purchaseDate).toLocaleDateString() : '—';
    }
    if (this.el.wfWarranty) {
      const declared = this.cfg.warrantyStatus;
      const auto = this.cfg.warrantyAuto;
      let txt = declared ? declared.charAt(0).toUpperCase() + declared.slice(1) : '—';
      if (auto === 1) txt += ' · in warranty';
      else if (auto === 0) txt += ' · expired';
      this.el.wfWarranty.textContent = txt;
    }
    if (this.el.wfBill) {
      this.el.wfBill.innerHTML = this.cfg.billUrl
        ? `<a href="${this.cfg.billUrl}" target="_blank" rel="noopener">View bill</a>`
        : '—';
    }
  }

  updateWorkflow() {
    const peer = this.roster.find((r) => r.participantId !== this.participantId);
    if (this.el.wfPeerName) {
      this.el.wfPeerName.textContent = peer
        ? peer.displayName
        : this.cfg.isAgent
          ? 'Waiting for customer…'
          : 'Waiting for agent…';
    }
    // Agent panel shows the customer's verified contact details.
    if (this.el.wfPeerPhone) this.el.wfPeerPhone.textContent = peer?.phone || '—';
    if (this.el.wfPeerEmail) this.el.wfPeerEmail.textContent = peer?.email || '—';
  }

  setRecording(status) {
    this.recording = status;
    const active = status.status === 'recording';
    if (this.el.wfRecording) {
      const dot = active ? 'red' : status.status === 'processing' ? 'amber' : status.status === 'ready' ? 'green' : 'grey';
      const label = { recording: 'Recording', processing: 'Processing', ready: 'Ready', idle: 'Not recording' }[status.status] || status.status;
      if (status.status === 'ready' && status.downloadUrl) {
        this.el.wfRecording.innerHTML = `<span class="status-dot green"></span>Ready &middot; <a href="${status.downloadUrl}" target="_blank" rel="noopener">Download</a>`;
      } else {
        this.el.wfRecording.innerHTML = `<span class="status-dot ${dot}"></span>${label}`;
      }
    }
    if (this.el.recPill) this.el.recPill.classList.toggle('hidden', !active);
    if (this.el.recBanner) this.el.recBanner.classList.toggle('hidden', !active);
  }
}
