/**
 * Performance reporting. An agent's "deliveries" are the tasks they accepted;
 * "completed" are the calls that finished; "resolved" are the ones the agent
 * marked solved. Managers roll these up across their agent pool; admins roll up
 * across each manager.
 */
import { agentRepo, sessionRepo } from '../db/repos.ts';
import type { Session } from '../types.ts';

export interface AgentStats {
  agentId: string;
  displayName: string;
  username: string;
  employeeId: string | null;
  phone: string | null;
  email: string | null;
  accepted: number; // tasks accepted (deliveries taken)
  completed: number; // calls that finished
  resolved: number; // marked resolved by the agent (successfully completed)
  inProgress: number; // accepted but not yet ended
  avgRating: number | null; // average customer rating
  ratingsCount: number;
}

function summarize(sessions: Session[]) {
  const completed = sessions.filter((s) => s.status === 'ended').length;
  const resolved = sessions.filter((s) => s.resolved === 1).length;
  const inProgress = sessions.filter((s) => s.status === 'active' || s.status === 'scheduled').length;
  const ratings = sessions.map((s) => s.customer_rating).filter((r): r is number => typeof r === 'number');
  const avgRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  return { accepted: sessions.length, completed, resolved, inProgress, avgRating, ratingsCount: ratings.length };
}

export function agentStats(agentId: string): AgentStats {
  const agent = agentRepo.findById(agentId);
  const sessions = sessionRepo.listByAgent(agentId);
  return {
    agentId,
    displayName: agent?.display_name ?? 'unknown',
    username: agent?.username ?? '',
    employeeId: agent?.employee_id ?? null,
    phone: agent?.phone ?? null,
    email: agent?.email ?? null,
    ...summarize(sessions),
  };
}

/** Recent task outcomes for an agent (the "what was the problem" report). */
export function agentReport(agentId: string) {
  return sessionRepo.listByAgent(agentId).map((s) => ({
    id: s.id,
    title: s.title,
    problem: s.description,
    status: s.status,
    resolved: s.resolved,
    customerRating: s.customer_rating,
    customerResolved: s.customer_resolved,
    createdAt: s.created_at,
    endedAt: s.ended_at,
  }));
}

export interface ManagerStats {
  managerId: string;
  displayName: string;
  username: string;
  employeeId: string | null;
  phone: string | null;
  email: string | null;
  agentCount: number;
  openTasks: number;
  totalAccepted: number;
  totalCompleted: number;
  totalResolved: number;
  avgRating: number | null;
  agents: AgentStats[];
}

export function managerStats(managerId: string): ManagerStats {
  const manager = agentRepo.findById(managerId);
  const agents = agentRepo.listByManager(managerId);
  const perAgent = agents.map((a) => agentStats(a.id));
  const totalAccepted = perAgent.reduce((n, a) => n + a.accepted, 0);
  const totalCompleted = perAgent.reduce((n, a) => n + a.completed, 0);
  const totalResolved = perAgent.reduce((n, a) => n + a.resolved, 0);
  const allRatings = agents.flatMap((a) =>
    sessionRepo.listByAgent(a.id).map((s) => s.customer_rating).filter((r): r is number => typeof r === 'number'),
  );
  const avgRating = allRatings.length ? Math.round((allRatings.reduce((x, y) => x + y, 0) / allRatings.length) * 10) / 10 : null;
  return {
    managerId,
    displayName: manager?.display_name ?? 'unknown',
    username: manager?.username ?? '',
    employeeId: manager?.employee_id ?? null,
    phone: manager?.phone ?? null,
    email: manager?.email ?? null,
    agentCount: agents.length,
    openTasks: sessionRepo.listOpenByManager(managerId).length,
    totalAccepted,
    totalCompleted,
    totalResolved,
    avgRating,
    agents: perAgent,
  };
}

/** Performance of every manager (admin view). */
export function allManagerStats(): ManagerStats[] {
  return agentRepo.listByRole('manager').map((m) => managerStats(m.id));
}
