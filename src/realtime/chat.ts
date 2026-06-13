/**
 * In-call chat: validates the sender, persists the message for the session
 * record, and broadcasts it to everyone in the session room in real time.
 */
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { sessionRepo, messageRepo, fileRepo } from '../db/repos.ts';
import { metrics } from '../metrics/metrics.ts';
import type { SocketData } from './index.ts';

const messageSchema = z.object({
  body: z.string().max(4000).optional().default(''),
  fileId: z.string().uuid().optional(),
});

export function registerChatHandlers(io: Server, socket: Socket): void {
  socket.on('chat-message', (raw: unknown, ack?: (res: unknown) => void) => {
    const data = socket.data as SocketData;
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'invalid message' });
      return;
    }
    const { body, fileId } = parsed.data;
    if (!body.trim() && !fileId) {
      ack?.({ ok: false, error: 'empty message' });
      return;
    }

    // Session must still be active to accept new messages.
    const session = sessionRepo.findById(data.sessionId);
    if (!session || session.status !== 'active') {
      ack?.({ ok: false, error: 'session not active' });
      return;
    }

    // If a file is referenced, it must belong to this session.
    let fileMeta: { id: string; name: string; mime: string; size: number } | undefined;
    if (fileId) {
      const file = fileRepo.findById(fileId);
      if (!file || file.session_id !== data.sessionId) {
        ack?.({ ok: false, error: 'invalid file reference' });
        return;
      }
      fileMeta = { id: file.id, name: file.original_name, mime: file.mime, size: file.size };
    }

    const message = messageRepo.create({
      sessionId: data.sessionId,
      senderParticipantId: data.participantId,
      senderRole: data.role,
      senderName: data.displayName,
      body: body.trim(),
      fileId: fileId ?? null,
    });
    metrics.messagesTotal.inc();

    io.to(data.sessionId).emit('chat-message', {
      id: message.id,
      sessionId: data.sessionId,
      senderParticipantId: message.sender_participant_id,
      senderRole: message.sender_role,
      senderName: message.sender_name,
      body: message.body,
      file: fileMeta,
      createdAt: message.created_at,
    });
    ack?.({ ok: true, id: message.id });
  });
}
