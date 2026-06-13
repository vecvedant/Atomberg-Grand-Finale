/**
 * Tiny structured logger. No dependency — keeps the demo lightweight and the
 * output greppable. Levels are prefixed so they're easy to filter in a terminal.
 */
type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] (${scope}) ${msg}`;
  const line = extra === undefined ? base : `${base} ${safeJson(extra)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
    debug: (msg: string, extra?: unknown) => {
      if (process.env.DEBUG) emit('debug', scope, msg, extra);
    },
  };
}

export type Logger = ReturnType<typeof logger>;
