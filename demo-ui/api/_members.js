// Members and Supabase Auth (M2 part 2 c, ADR-003).
//
// Identities live in Supabase Auth (auth.users); the members table carries
// the role, display name and active flag Maistro needs. The page signs the
// person in with a magic link (GoTrue /auth/v1/otp, anon key, client-side);
// the resulting access token is exchanged at POST /api/login for the Maistro
// session cookie, after this module verified the token with GoTrue and found
// an active members row. Invitations go through GoTrue's admin invite
// endpoint (service role) and create the members row with the chosen role.
const { fetchT } = require('./_http.js');
const { queryRows, insertRows, patchRows } = require('./_supabase.js');
const { ROLES } = require('../src/domain/stages.js');

const q = (v) => encodeURIComponent(String(v));
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function cfg() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  return { url, service, anon, ready: Boolean(url && service && anon) };
}

/** Which e-mail addresses become admin on first sign-in (comma-separated). */
function bootstrapAdmins() {
  return String(process.env.MAISTRO_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Ask GoTrue who this access token belongs to. */
async function verifyAccessToken(token) {
  const c = cfg();
  if (!c.url || !c.anon) throw new Error('Supabase Auth is not configured (SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  if (!/^[A-Za-z0-9_.-]{20,4096}$/.test(String(token || ''))) return null;
  const r = await fetchT(`${c.url}/auth/v1/user`, { headers: { apikey: c.anon, Authorization: `Bearer ${token}` } }, { timeoutMs: 10000 });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error(`auth check failed (${r.status})`);
  const u = await r.json().catch(() => null);
  if (!u || !u.id || !u.email) return null;
  return { id: String(u.id), email: String(u.email).toLowerCase(), name: (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || null };
}

const toMember = (m) => ({ id: m.id, email: m.email, role: m.role, name: m.display_name || null, active: Boolean(m.active), createdAt: m.created_at });

async function getMemberById(id) {
  const rows = await queryRows('members', `select=*&id=eq.${q(id)}&limit=1`);
  return rows[0] ? toMember(rows[0]) : null;
}
async function getMemberByEmail(email) {
  const rows = await queryRows('members', `select=*&email=eq.${q(String(email).toLowerCase())}&limit=1`);
  return rows[0] ? toMember(rows[0]) : null;
}
async function listMembers() {
  return (await queryRows('members', 'select=*&order=created_at.asc&limit=500')).map(toMember);
}

/** The member for a verified auth user, creating the row for a bootstrap
 *  admin on first sign-in. Returns null for someone who was never invited. */
async function memberForUser(user) {
  let m = await getMemberById(user.id);
  if (m) return m;
  // invited before they had an auth user? (row keyed by the invite's user id — same id) — otherwise bootstrap
  if (bootstrapAdmins().includes(user.email)) {
    const [row] = await insertRows('members', [{ id: user.id, email: user.email, display_name: user.name, role: 'admin', active: true }], { returning: true, onConflict: 'id', ignoreDuplicates: true });
    m = row ? toMember(row) : await getMemberById(user.id);
  }
  return m;
}

/** Admin action: invite by e-mail with a role. GoTrue creates the auth user
 *  and e-mails the invitation link; the members row is created with its id. */
async function inviteMember({ email, role, name, redirectTo }) {
  const c = cfg();
  if (!c.ready) throw Object.assign(new Error('Supabase Auth is not configured'), { status: 503 });
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw Object.assign(new Error('a valid e-mail address is required'), { status: 422 });
  if (!ROLES.includes(role)) throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { status: 422 });
  const existing = await getMemberByEmail(email);
  if (existing) throw Object.assign(new Error(`${email} is already a member (${existing.role})`), { status: 409 });
  const r = await fetchT(`${c.url}/auth/v1/invite`, {
    method: 'POST', headers: { apikey: c.service, Authorization: `Bearer ${c.service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, data: { role, full_name: name || null }, ...(redirectTo ? { redirect_to: redirectTo } : {}) }),
  }, { timeoutMs: 15000 });
  const j = await r.json().catch(() => ({}));
  let userId = j && j.id;
  if (!r.ok) {
    // already an auth user (signed up earlier, never invited): find them and attach the member row
    if (r.status === 422 || r.status === 400) {
      const list = await fetchT(`${c.url}/auth/v1/admin/users?page=1&per_page=1&email=${q(email)}`, { headers: { apikey: c.service, Authorization: `Bearer ${c.service}` } }, { timeoutMs: 10000 });
      const lj = await list.json().catch(() => ({}));
      const found = (lj.users || []).find((u) => String(u.email || '').toLowerCase() === email);
      if (found) userId = found.id;
    }
    if (!userId) throw Object.assign(new Error(`invite failed (${r.status}) ${String(j.msg || j.message || j.error_description || '').slice(0, 160)}`), { status: 502 });
  }
  const [row] = await insertRows('members', [{ id: userId, email, display_name: name || null, role, active: true }], { returning: true, onConflict: 'id', ignoreDuplicates: true });
  return row ? toMember(row) : await getMemberById(userId);
}

async function updateMember(id, patch) {
  const p = {};
  if (patch.role !== undefined) { if (!ROLES.includes(patch.role)) throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { status: 422 }); p.role = patch.role; }
  if (patch.active !== undefined) p.active = Boolean(patch.active);
  if (patch.name !== undefined) p.display_name = patch.name ? String(patch.name).slice(0, 120) : null;
  if (!Object.keys(p).length) throw Object.assign(new Error('nothing to update'), { status: 422 });
  const rows = await patchRows('members', `id=eq.${q(id)}`, p);
  if (!rows.length) throw Object.assign(new Error('member not found'), { status: 404 });
  return toMember(rows[0]);
}

module.exports = { cfg, bootstrapAdmins, verifyAccessToken, memberForUser, getMemberById, getMemberByEmail, listMembers, inviteMember, updateMember };
