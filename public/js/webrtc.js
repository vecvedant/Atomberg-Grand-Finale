// Client media controller (Phase 2). Opens ONE RTCPeerConnection to the SERVER
// (never to the other browser), publishes the local camera/mic, and renders the
// forwarded remote media. The server is the SFU; this peer only ever talks to it.

import { banner } from './common.js';

const PC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bundlePolicy: 'max-bundle',
};

class MediaController {
  constructor(app) {
    this.app = app;
    this.socket = app.socket;
    this.pc = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.started = false;
  }

  async start() {
    this.pc = new RTCPeerConnection(PC_CONFIG);

    this.pc.addEventListener('track', (e) => {
      this.remoteStream.addTrack(e.track);
      this.refreshTiles();
    });
    this.pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.socket.emit('sfu-ice', { candidate: e.candidate.toJSON() });
    });
    this.pc.addEventListener('connectionstatechange', () => {
      if (this.pc.connectionState === 'failed') banner('Media connection failed', 'error');
    });

    // SDP must be processed strictly in order. Socket.IO does NOT await async
    // listeners, so without this chain an answer and a server renegotiation
    // offer can race and collide in have-local-offer state (offer glare).
    this._sdpChain = Promise.resolve();
    this._haveRemote = false;
    this._pendingIce = [];
    this.socket.on('sfu-description', ({ description }) => {
      if (!description) return;
      this._sdpChain = this._sdpChain.then(() => this._handleDescription(description)).catch((e) => console.error('sfu-description', e));
    });
    this.socket.on('sfu-ice', ({ candidate }) => {
      if (!candidate) return;
      // Buffer candidates that arrive before the remote description is set.
      if (!this._haveRemote) {
        this._pendingIce.push(candidate);
        return;
      }
      this.pc.addIceCandidate(candidate).catch((err) => console.warn('addIceCandidate', err));
    });

    // Acquire camera + mic. If denied, the call still works for chat.
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      banner('Camera/microphone blocked — joining without media', 'error');
      console.warn('getUserMedia denied', err);
      this.localStream = new MediaStream();
    }

    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    this.refreshTiles();

    // Initial publish offer (the only client-initiated offer).
    await this._publish();
    this.started = true;
  }

  async _handleDescription(description) {
    // Polite-peer rollback: if an offer arrives while we're mid-offer, roll our
    // local offer back first so the incoming offer can be applied cleanly.
    if (description.type === 'offer' && this.pc.signalingState === 'have-local-offer') {
      await this.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    }
    await this.pc.setRemoteDescription(description);
    this._haveRemote = true;
    for (const c of this._pendingIce.splice(0)) {
      await this.pc.addIceCandidate(c).catch((err) => console.warn('addIceCandidate(buffered)', err));
    }
    if (description.type === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.socket.emit('sfu-description', { description: { type: answer.type, sdp: answer.sdp } });
    }
  }

  async _publish() {
    const send = async () => {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await this.pc.setLocalDescription(offer);
      this.socket.emit('sfu-description', { description: { type: offer.type, sdp: offer.sdp } });
    };
    if (this.socket.connected) await send();
    else this.socket.once('connect', send);
  }

  /** Assign local/remote streams to the correct tiles and reveal the <video>s. */
  refreshTiles() {
    const selfId = this.app.participantId;
    for (const [pid, tile] of this.app.tiles) {
      if (!tile.videoEl) continue;
      const isSelf = pid === selfId;
      const stream = isSelf ? this.localStream : this.remoteStream;
      if (stream && tile.videoEl.srcObject !== stream) {
        tile.videoEl.srcObject = stream;
        if (isSelf) tile.videoEl.muted = true;
      }
      const hasVideo = stream && stream.getVideoTracks().length > 0;
      tile.videoEl.classList.toggle('hidden', !hasVideo);
      if (tile.avatarEl) tile.avatarEl.classList.toggle('hidden', !!hasVideo);
    }
  }

  /* Hooks called by CallApp */
  onJoined() {
    this.refreshTiles();
  }
  onTileCreated() {
    this.refreshTiles();
  }
  onPeerJoined() {
    this.refreshTiles();
  }
  onPeerLeft() {
    // In a 2-party call, drop the remote tracks so the tile falls back to avatar.
    for (const t of this.remoteStream.getTracks()) this.remoteStream.removeTrack(t);
    this.refreshTiles();
  }

  toggleAudio() {
    const t = this.localStream?.getAudioTracks()[0];
    if (!t) return true;
    t.enabled = !t.enabled;
    return t.enabled;
  }
  toggleVideo() {
    const t = this.localStream?.getVideoTracks()[0];
    if (!t) return true;
    t.enabled = !t.enabled;
    this.refreshTiles();
    return t.enabled;
  }

  /* ---- device switching (change camera / microphone live) ---- */
  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      mics: devices.filter((d) => d.kind === 'audioinput'),
      currentCam: this.localStream?.getVideoTracks()[0]?.getSettings().deviceId,
      currentMic: this.localStream?.getAudioTracks()[0]?.getSettings().deviceId,
    };
  }

  switchCamera(deviceId) {
    return this._switch('video', { video: { deviceId: { exact: deviceId } } });
  }
  switchMic(deviceId) {
    return this._switch('audio', { audio: { deviceId: { exact: deviceId } } });
  }

  async _switch(kind, constraints) {
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = kind === 'video' ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
      if (!newTrack) return;
      const oldTrack = kind === 'video' ? this.localStream.getVideoTracks()[0] : this.localStream.getAudioTracks()[0];
      if (oldTrack) newTrack.enabled = oldTrack.enabled;
      // Replace on the existing sender — seamless, no renegotiation needed.
      const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === kind);
      if (sender) await sender.replaceTrack(newTrack);
      if (oldTrack) {
        this.localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      this.localStream.addTrack(newTrack);
      this.refreshTiles();
      banner(kind === 'video' ? 'Camera switched' : 'Microphone switched', 'success');
    } catch (err) {
      console.warn('switch device failed', err);
      banner('Could not switch device', 'error');
    }
  }

  stop() {
    try {
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.pc?.close();
    } catch {
      /* ignore */
    }
  }
}

export async function attachMedia(app) {
  const controller = new MediaController(app);
  app.media = controller;
  await controller.start();
  return controller;
}
