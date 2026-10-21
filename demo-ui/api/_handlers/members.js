// /api/members — admin management of who may sign in and with which role
// (M2 part 2 c, ADR-003). Every method needs an admin member session.
//
//   GET                          → { count, members:[{id,email,role,name,active,createdAt}] }
//   POST  { email, role, name? } → invites through Supabase Auth and creates the
//                                  members row → 200 { ok, member }
//   PATCH { id, role?, active?, name? } → 200 { ok, member }
const { requireRole } = require('../_auth.js');
const { listMembers, inviteMember, updateMember } = require('../_members.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireRole(req, res, ['admin'])) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'storage is not configured' });
  const b = req.body || {};
  try {
    if (req.method === 'GET') {
      const members = await listMembers();
      return res.status(200).json({ count: members.length, members });
    }
    if (req.method === 'POST') {
      const proto = String(req.headers['x-forwarded-proto'] || 'https');
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      const member = await inviteMember({ email: b.email, role: b.role, name: b.name, redirectTo: host ? `${proto}://${host}/` : undefined });
      return res.status(200).json({ ok: true, member });
    }
    if (!b.id) return res.status(422).json({ error: 'id is required' });
    if (String(b.id) === req.member.id && b.active === false) return res.status(422).json({ error: 'you cannot deactivate yourself' });
    const member = await updateMember(String(b.id), { role: b.role, active: b.active, name: b.name });
    return res.status(200).json({ ok: true, member });
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    return res.status(status).json({ error: String((e && e.message) || e) });
  }
};
