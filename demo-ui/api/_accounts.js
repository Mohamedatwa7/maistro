// Named username + password accounts (2026-11-12, owner request).
//
// For people outside the Supabase members table who still need their own
// sign-in — e.g. the Samsung MENA guest account. Each account becomes a
// member-shaped session (id `acct:<username>`), so the rest of the app sees an
// ordinary member with a role. Only scrypt hashes live here, never passwords.
//
// A `viewer` account is read-only: the API router refuses every write for it
// with 403 code `not_permitted` (see VIEW_ONLY_ROLES and api/[route].js).
const crypto = require('node:crypto');

const ACCOUNTS = [
  {
    username: 'samsung.mena',
    name: 'Samsung MENA',
    role: 'viewer',
    salt: 'f2edcb4dd3d692c1b7649d6c77130070',
    hash: '709f915ff00345fc3bcc01556517814d648534e12150c07f42989140facc4ffa',
  },
];

const VIEW_ONLY_ROLES = ['viewer'];
const ID_PREFIX = 'acct:';

const norm = (u) => String(u || '').trim().toLowerCase();

function findAccount(username) {
  const u = norm(username);
  return ACCOUNTS.find((a) => a.username === u) || null;
}

function toMember(a) {
  return { id: ID_PREFIX + a.username, email: a.username, role: a.role, name: a.name, active: true };
}

/** The member for a username + password, or null when either is wrong. */
function verifyAccount(username, password) {
  const a = findAccount(username);
  if (!a) return null;
  const got = crypto.scryptSync(String(password || ''), a.salt, 32);
  const want = Buffer.from(a.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? toMember(a) : null;
}

/** The member for a session id `acct:<username>`, or null when it is not an account id / no longer exists. */
function accountMemberById(id) {
  const s = String(id || '');
  if (!s.startsWith(ID_PREFIX)) return null;
  const a = findAccount(s.slice(ID_PREFIX.length));
  return a ? toMember(a) : null;
}

const isAccountId = (id) => String(id || '').startsWith(ID_PREFIX);

module.exports = { findAccount, verifyAccount, accountMemberById, isAccountId, VIEW_ONLY_ROLES };
