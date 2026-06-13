/**
 * WebRTC SFU (Selective Forwarding Unit) built on werift — pure-TS, no native
 * build. This is the media plane: every client opens ONE RTCPeerConnection to
 * the SERVER and the server forwards each participant's media to the other.
 * There is never a direct client-to-client (P2P) connection.
 *
 * Topology for a 2-party support call (A = agent, B = customer):
 *
 *     A ──(publish A's cam/mic)──▶  server  ──(forward A)──▶ B
 *     A ◀──(forward B)───────────  server  ◀──(publish B)── B
 *
 * Forwarding mechanism: for each incoming track we create a "relay"
 * MediaStreamTrack and pipe the publisher's RTP packets into it
 * (onReceiveRtp → relay.writeRtp). That relay track is then added to every other
 * participant's peer connection, which renegotiates and starts sending.
 *
 * Negotiation: the client makes the initial publish offer. After that, ALL
 * renegotiation offers are server-initiated and gated on signalingState==='stable'
 * (see renegotiate()), which avoids offer glare without full perfect-negotiation
 * bookkeeping on the client.
 */
import type { Server, Socket } from 'socket.io';
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import type { RTCRtpSender, RTCRtpReceiver } from 'werift';
import { metrics } from '../metrics/metrics.ts';
import { logger } from '../util/logger.ts';

const log = logger('sfu');

type Kind = 'audio' | 'video';

interface Peer {
  id: string; // participant id
  socket: Socket;
  pc: RTCPeerConnection;
  relays: Partial<Record<Kind, MediaStreamTrack>>; // tracks we forward to OTHERS
  incoming: Partial<Record<Kind, MediaStreamTrack>>; // raw publisher tracks (for recording)
  receivers: Partial<Record<Kind, { receiver: RTCRtpReceiver; ssrc: number }>>; // for PLI
  subscriptions: Map<string, RTCRtpSender>; // key `${publisherId}:${kind}` -> sender on THIS pc
  renegotiatePending: boolean;
  sdpChain: Promise<void>; // serializes all SDP operations on this peer (no glare)
}

/** Serialize an SDP operation on a peer so offers/answers never interleave. */
function enqueue(peer: Peer, fn: () => Promise<void>): Promise<void> {
  peer.sdpChain = peer.sdpChain.then(fn).catch((err) => {
    metrics.errorsTotal.inc({ kind: 'sfu_sdp' });
    log.error('sdp op failed', { participantId: peer.id, err: (err as Error).message });
  });
  return peer.sdpChain;
}

interface Room {
  sessionId: string;
  peers: Map<string, Peer>;
}

const rooms = new Map<string, Room>();

function getRoom(sessionId: string): Room {
  let room = rooms.get(sessionId);
  if (!room) {
    room = { sessionId, peers: new Map() };
    rooms.set(sessionId, room);
  }
  return room;
}

function buildPeerConnection(): RTCPeerConnection {
  // Defaults already include Opus + VP8 with NACK/PLI/REMB — browser-compatible.
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    bundlePolicy: 'max-bundle',
  });
}

/** Create (or reuse) the server-side peer for a connecting participant. */
function ensurePeer(io: Server, socket: Socket, sessionId: string, participantId: string): Peer {
  const room = getRoom(sessionId);
  const existing = room.peers.get(participantId);
  if (existing) return existing;

  const pc = buildPeerConnection();
  const peer: Peer = {
    id: participantId,
    socket,
    pc,
    relays: {},
    incoming: {},
    receivers: {},
    subscriptions: new Map(),
    renegotiatePending: false,
    sdpChain: Promise.resolve(),
  };
  room.peers.set(participantId, peer);

  // Trickle our ICE candidates down to this client.
  pc.onIceCandidate.subscribe((candidate) => {
    if (!candidate) return;
    const json = typeof (candidate as any).toJSON === 'function' ? (candidate as any).toJSON() : candidate;
    socket.emit('sfu-ice', { candidate: json });
  });

  pc.connectionStateChange.subscribe((state) => {
    log.info('server PC state', { sessionId, participantId, state });
  });

  // A publisher track arrived → set up forwarding to everyone else.
  pc.onTrack.subscribe((track) => {
    const kind = track.kind as Kind;
    log.info('received publisher track', { sessionId, participantId, kind });

    peer.incoming[kind] = track;
    const relay = new MediaStreamTrack({ kind });
    peer.relays[kind] = relay;
    track.onReceiveRtp.subscribe((rtp) => {
      try {
        relay.writeRtp(rtp);
      } catch {
        /* relay not yet attached to any sender — drop */
      }
    });

    // Remember the receiver so we can request keyframes (PLI) for new subscribers.
    const transceiver = pc.getTransceivers().find((t) => t.receiver?.track === track);
    if (transceiver?.receiver && track.ssrc) {
      peer.receivers[kind] = { receiver: transceiver.receiver, ssrc: track.ssrc };
    }

    // Subscribe every other peer to this newly published track…
    for (const other of room.peers.values()) {
      if (other.id === participantId) continue;
      subscribe(io, other, peer, kind);
    }
    // …and make sure this peer is subscribed to everyone else's existing tracks.
    for (const other of room.peers.values()) {
      if (other.id === participantId) continue;
      for (const k of Object.keys(other.relays) as Kind[]) {
        subscribe(io, peer, other, k);
      }
    }
  });

  metrics.connectedParticipants.inc();
  return peer;
}

/** Attach `publisher`'s relay track of `kind` to `subscriber`'s peer connection. */
function subscribe(io: Server, subscriber: Peer, publisher: Peer, kind: Kind): void {
  const relay = publisher.relays[kind];
  if (!relay) return;
  const key = `${publisher.id}:${kind}`;
  if (subscriber.subscriptions.has(key)) return;

  const sender = subscriber.pc.addTrack(relay);
  subscriber.subscriptions.set(key, sender);
  log.info('subscribe', { sub: subscriber.id, pub: publisher.id, kind });

  // Ask the publisher's browser for a fresh keyframe so the new viewer paints fast.
  requestKeyframe(publisher, kind);
  setTimeout(() => requestKeyframe(publisher, kind), 300);
  setTimeout(() => requestKeyframe(publisher, kind), 1200);

  renegotiate(subscriber);
}

function requestKeyframe(publisher: Peer, kind: Kind): void {
  if (kind !== 'video') return;
  const r = publisher.receivers.video;
  if (!r) return;
  r.receiver.sendRtcpPLI(r.ssrc).catch(() => {
    /* best-effort */
  });
}

/** Server-initiated renegotiation, gated on a stable signaling state (no glare). */
function renegotiate(peer: Peer): void {
  void enqueue(peer, async () => {
    if (peer.pc.signalingState !== 'stable') {
      peer.renegotiatePending = true;
      return;
    }
    peer.renegotiatePending = false;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    peer.socket.emit('sfu-description', { description: { type: offer.type, sdp: offer.sdp } });
  });
}

function flushPending(peer: Peer): void {
  if (peer.renegotiatePending) renegotiate(peer);
}

export function registerSfuHandlers(io: Server, socket: Socket): void {
  const data = socket.data as { sessionId: string; participantId: string };
  const { sessionId, participantId } = data;
  const peer = ensurePeer(io, socket, sessionId, participantId);

  // SDP offer/answer exchange (handles both the client's initial publish offer
  // and answers to our server-initiated renegotiation offers).
  socket.on('sfu-description', (msg: { description?: { type: string; sdp: string } }) => {
    const description = msg?.description;
    if (!description?.type || !description?.sdp) return;
    void enqueue(peer, async () => {
      await peer.pc.setRemoteDescription(description as any);
      if (description.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('sfu-description', { description: { type: answer.type, sdp: answer.sdp } });
      }
    }).then(() => flushPending(peer));
  });

  socket.on('sfu-ice', async (msg: { candidate?: unknown }) => {
    if (!msg?.candidate) return;
    try {
      await peer.pc.addIceCandidate(msg.candidate as any);
    } catch {
      /* candidate may arrive before remote description; werift buffers most cases */
    }
  });
}

/** Close and detach one participant's media, updating the peers subscribed to them. */
export function teardownSfuForParticipant(sessionId: string, participantId: string): void {
  const room = rooms.get(sessionId);
  if (!room) return;
  const peer = room.peers.get(participantId);
  if (!peer) return;

  // Remove this publisher's tracks from everyone who was viewing them.
  for (const other of room.peers.values()) {
    if (other.id === participantId) continue;
    for (const kind of ['audio', 'video'] as Kind[]) {
      const key = `${participantId}:${kind}`;
      const sender = other.subscriptions.get(key);
      if (sender) {
        try {
          other.pc.removeTrack(sender);
        } catch {
          /* ignore */
        }
        other.subscriptions.delete(key);
        void renegotiate(other);
      }
    }
  }

  try {
    void peer.pc.close();
  } catch {
    /* ignore */
  }
  room.peers.delete(participantId);
  metrics.connectedParticipants.dec();
  log.info('participant SFU torn down', { sessionId, participantId });
  if (room.peers.size === 0) rooms.delete(sessionId);
}

export function teardownSfuForSession(sessionId: string): void {
  const room = rooms.get(sessionId);
  if (!room) return;
  for (const peer of room.peers.values()) {
    try {
      void peer.pc.close();
    } catch {
      /* ignore */
    }
  }
  rooms.delete(sessionId);
  log.info('session SFU torn down', { sessionId });
}

/** Exposed for the recorder: the live incoming publisher tracks for a session. */
export function getSessionIncomingTracks(sessionId: string): { participantId: string; kind: Kind; track: MediaStreamTrack }[] {
  const room = rooms.get(sessionId);
  if (!room) return [];
  const out: { participantId: string; kind: Kind; track: MediaStreamTrack }[] = [];
  for (const peer of room.peers.values()) {
    for (const kind of Object.keys(peer.incoming) as Kind[]) {
      const track = peer.incoming[kind];
      if (track) out.push({ participantId: peer.id, kind, track });
    }
  }
  return out;
}
