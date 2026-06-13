// Verifies the Admin > Manager > Agent hierarchy, account-creation rules, the
// Rapido-style task pool (accept), cross-pool isolation, and performance stats.
const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? '[PASS]' : '[FAIL]'} ${m}`);
  if (!c) failures++;
};
async function http(p, o = {}) {
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const login = (u, p) => http('/api/auth/login', { method: 'POST', body: { username: u, password: p } }).then((r) => r.data?.token);

const adminTok = await login('admin', 'admin123');
const managerTok = await login('manager', 'manager123');
const agentTok = await login('agent', 'agent123');
ok(adminTok && managerTok && agentTok, 'admin, manager, agent all log in');

// 1. There is NO way to create an admin (the old endpoint is gone).
const oldAgentCreate = await http('/api/admin/agents', { method: 'POST', token: adminTok, body: { username: 'x', displayName: 'x', password: 'xxxxxx', role: 'admin' } });
ok(oldAgentCreate.status === 404, `no admin-creation path exists (old endpoint -> ${oldAgentCreate.status})`);

// 2. Admin creates a MANAGER (role is forced to manager).
const m2 = await http('/api/admin/managers', { method: 'POST', token: adminTok, body: { username: 'manager2', displayName: 'Manager Two', password: 'mgr12345', employeeId: 'M-002', phone: '+919000000002', email: 'm2@atomberg.test' } });
ok(m2.status === 201 && m2.data.role === 'manager', `admin creates a manager (role=${m2.data?.role})`);

// 3. Manager cannot create managers (admin-only).
const mgrMakesMgr = await http('/api/admin/managers', { method: 'POST', token: managerTok, body: { username: 'nope', displayName: 'n', password: 'nnnnnn' } });
ok(mgrMakesMgr.status === 403, `manager blocked from creating managers (${mgrMakesMgr.status})`);

// 4. Manager creates an AGENT in their pool.
const ag2 = await http('/api/manager/agents', { method: 'POST', token: managerTok, body: { username: 'agent2', displayName: 'Agent Two', password: 'agt12345', employeeId: 'A-002', phone: '+919000000022', email: 'a2@atomberg.test' } });
ok(ag2.status === 201 && ag2.data.role === 'agent', `manager creates an agent (role=${ag2.data?.role})`);

// 5. Agent cannot create agents.
const agentMakesAgent = await http('/api/manager/agents', { method: 'POST', token: agentTok, body: { username: 'z', displayName: 'z', password: 'zzzzzz' } });
ok(agentMakesAgent.status === 403, `agent blocked from creating agents (${agentMakesAgent.status})`);

// 6. Manager posts a task -> it is OPEN and visible to their agents only.
const task = await http('/api/tasks', { method: 'POST', token: managerTok, body: { title: 'Fix fan', description: 'Not spinning' } });
ok(task.status === 201 && task.data.status === 'open', `manager posts an open task (status=${task.data?.status})`);
const taskId = task.data.id;

const avail = await http('/api/tasks/available', { token: agentTok });
ok(avail.status === 200 && avail.data.some((t) => t.id === taskId), 'agent sees the task in the available pool');

// 7. Cross-pool isolation: an agent under a DIFFERENT manager cannot see it.
const m2Tok = await login('manager2', 'mgr12345');
await http('/api/manager/agents', { method: 'POST', token: m2Tok, body: { username: 'agent3', displayName: 'Agent Three', password: 'agt33333', employeeId: 'A-003', phone: '+919000000033', email: 'a3@atomberg.test' } });
const a3Tok = await login('agent3', 'agt33333');
const availOther = await http('/api/tasks/available', { token: a3Tok });
ok(!availOther.data.some((t) => t.id === taskId), "task is NOT visible to another manager's agent");
const acceptOther = await http(`/api/tasks/${taskId}/accept`, { method: 'POST', token: a3Tok });
ok(acceptOther.status === 403, `other pool's agent cannot accept (${acceptOther.status})`);

// 8. Agent accepts; a second accept fails (already taken).
const accept = await http(`/api/tasks/${taskId}/accept`, { method: 'POST', token: agentTok });
ok(accept.status === 200 && accept.data.status === 'scheduled', `agent accepts the task (status=${accept.data?.status})`);
const a2Tok = await login('agent2', 'agt12345');
const accept2 = await http(`/api/tasks/${taskId}/accept`, { method: 'POST', token: a2Tok });
ok(accept2.status === 409, `task can't be accepted twice (${accept2.status})`);

// 9. Agent completes it: resolution + end -> stats reflect a completed, resolved delivery.
await http(`/api/sessions/${taskId}/resolution`, { method: 'POST', token: agentTok, body: { resolved: true, notes: 'Fixed connector' } });
await http(`/api/sessions/${taskId}/end`, { method: 'POST', token: agentTok });
const stats = await http('/api/tasks/stats', { token: agentTok });
ok(stats.data.accepted >= 1 && stats.data.completed >= 1 && stats.data.resolved >= 1, `agent stats: accepted=${stats.data.accepted} completed=${stats.data.completed} resolved=${stats.data.resolved}`);

// 10. Manager sees the agent's performance; admin sees the manager's performance.
const mgrMe = await http('/api/manager/me', { token: managerTok });
const thisAgent = mgrMe.data.agents.find((a) => a.username === 'agent');
ok(thisAgent && thisAgent.resolved >= 1, `manager sees agent performance (resolved=${thisAgent?.resolved})`);
const adminManagers = await http('/api/admin/managers', { token: adminTok });
const thisManager = adminManagers.data.find((m) => m.username === 'manager');
ok(thisManager && thisManager.totalResolved >= 1, `admin sees manager performance (resolved=${thisManager?.totalResolved})`);

// 10b. Customer feedback (invite-token auth) is recorded and visible to admin.
const invite = new URL(accept.data.inviteUrl).searchParams.get('token');
const fb = await http(`/api/sessions/${taskId}/feedback`, { method: 'POST', body: { token: invite, rating: 5, resolved: true, comment: 'Great help' } });
ok(fb.status === 200, 'customer submits feedback via invite token');
const detail = await http(`/api/admin/sessions/${taskId}`, { token: adminTok });
ok(detail.data.session.customer_rating === 5, 'customer feedback is visible to admin');

// 11. Tier access control: agent/manager blocked from admin endpoints.
const agentToAdmin = await http('/api/admin/managers', { token: agentTok });
const mgrToAdmin = await http('/api/admin/overview', { token: managerTok });
ok(agentToAdmin.status === 403 && mgrToAdmin.status === 403, 'agents and managers are blocked from the admin API');

console.log(failures === 0 ? '\nPASS: HIERARCHY PASS' : `\nFAIL: HIERARCHY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
