/**
 * Database bootstrap using Node's built-in node:sqlite (zero native build).
 * Opens (creating if needed) the SQLite file and applies the schema on startup.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { logger } from '../util/logger.ts';

const log = logger('db');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure runtime directories exist before opening the DB / writing files.
for (const dir of [config.paths.data, config.paths.recordings, config.paths.uploads]) {
  mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(config.paths.db);

/** Add a column to a table if it doesn't already exist (idempotent migration). */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info('migration: added column', { table, column });
}

export function migrate(): void {
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Backfill columns on databases created before these features existed.
  addColumnIfMissing('sessions', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('sessions', 'scheduled_at', 'TEXT');
  addColumnIfMissing('sessions', 'resolved', 'INTEGER');
  addColumnIfMissing('sessions', 'agent_notes', 'TEXT');
  addColumnIfMissing('sessions', 'customer_rating', 'INTEGER');
  addColumnIfMissing('sessions', 'customer_resolved', 'INTEGER');
  addColumnIfMissing('sessions', 'customer_comment', 'TEXT');
  addColumnIfMissing('agents', 'manager_id', 'TEXT');
  addColumnIfMissing('agents', 'employee_id', 'TEXT');
  addColumnIfMissing('agents', 'phone', 'TEXT');
  addColumnIfMissing('agents', 'email', 'TEXT');
  addColumnIfMissing('participants', 'phone', 'TEXT');
  addColumnIfMissing('participants', 'email', 'TEXT');
  addColumnIfMissing('sessions', 'manager_id', 'TEXT');
  addColumnIfMissing('sessions', 'created_by', 'TEXT');
  addColumnIfMissing('sessions', 'accepted_at', 'TEXT');
  addColumnIfMissing('sessions', 'source', "TEXT NOT NULL DEFAULT 'manager'");
  addColumnIfMissing('sessions', 'requester_name', 'TEXT');
  addColumnIfMissing('sessions', 'requester_phone', 'TEXT');
  addColumnIfMissing('sessions', 'requester_email', 'TEXT');
  addColumnIfMissing('sessions', 'purchase_date', 'TEXT');
  addColumnIfMissing('sessions', 'warranty_status', 'TEXT');
  addColumnIfMissing('sessions', 'warranty_auto', 'INTEGER');
  addColumnIfMissing('sessions', 'bill_file_id', 'TEXT');
  addColumnIfMissing('sessions', 'ref', 'TEXT');
  log.info('schema applied', { db: config.paths.db });
}

migrate();
