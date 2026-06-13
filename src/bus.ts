/**
 * Tiny in-process event bus that decouples the REST layer from the realtime
 * layer. The HTTP side can end a session without importing Socket.IO internals;
 * the realtime side subscribes and tears down live connections + SFU resources.
 */
import { EventEmitter } from 'node:events';

interface BusEvents {
  'session:ended': { sessionId: string; endedBy: string };
}

class TypedBus extends EventEmitter {
  emitEvent<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emit(event, payload);
  }
  onEvent<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.on(event, listener);
  }
}

export const bus = new TypedBus();
