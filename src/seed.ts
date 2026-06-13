/**
 * Seeds the demo accounts judges use to log in instantly. Idempotent — running
 * it more than once leaves existing accounts untouched.
 *
 *   Admin   -> username: admin    password: admin123    (single master account)
 *   Manager -> username: manager  password: manager123  (owns an agent pool)
 *   Agent   -> username: agent    password: agent123     (belongs to the manager)
 */
import './db/index.ts';
import { agentRepo } from './db/repos.ts';
import { hashPassword } from './auth/passwords.ts';
import { logger } from './util/logger.ts';

const log = logger('seed');

function ensure(username: string, password: string, displayName: string, role: 'admin' | 'manager' | 'agent', managerId: string | null) {
  const existing = agentRepo.findByUsername(username);
  if (existing) {
    log.info(`account "${username}" already exists, skipping`);
    return existing;
  }
  const created = agentRepo.create({ username, passwordHash: hashPassword(password), displayName, role, managerId });
  log.info(`created ${role} account "${username}"`);
  return created;
}

// Admin first, then a manager, then an agent that belongs to that manager.
ensure('admin', 'admin123', 'Demo Admin', 'admin', null);
const manager = ensure('manager', 'manager123', 'Demo Manager', 'manager', null);
ensure('agent', 'agent123', 'Demo Agent', 'agent', manager.id);

log.info('seed complete');
process.exit(0);
