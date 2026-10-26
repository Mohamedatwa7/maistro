// Spam filter for customer comments (2026-10-26). Spam never reaches the Performance page: it is removed from
// every post's comments before counts, themes, sentiment rates or examples are computed, and the number removed
// is reported beside the data. Two kinds:
// - Text rules: follow/DM bait, crypto, prophecy walls, and campaigns aimed at another market — a copy-pasted
//   protest tagging @SamsungIndia with ₹ prices ("SAMSUNG MEGA OFFER! … FREE GREEN LINE …") is not a Gulf customer
//   talking to Samsung Gulf. A real green-line complaint without those markers is kept.
// - Copy-paste campaigns: the same long message (≥ COPY_MIN_CHARS once punctuation, emoji, @mentions and case are
//   removed) posted by ≥ COPY_MIN_AUTHORS different accounts in the window.
// Idempotent: filtering a filtered list removes nothing more, so stored payloads can be re-filtered on read.
const R = (s) => new RegExp(s, 'iu');
const COPY_MIN_CHARS = 60;
const COPY_MIN_AUTHORS = 3;

const RULES = [
  { id: 'bait', re: R(String.raw`\bfollow me\b|\bcheck my (?:page|profile|channel)\b|\bdm me\b|\bcrypto\b|\bbitcoin\b|\bsuper ?ai\b|\bbequeath\w*\b|#seat28g\b|\bprophecy eternal\b`) },
  // another market's account or currency: the comment is addressed to a different Samsung region
  { id: 'other_market', re: R(String.raw`@samsung(?:india|in|us|usa|uk|mobileusa|mobilein|mobileindia|bangladesh|bd|pakistan|pk|nigeria|ng|philippines|ph|indonesia|malaysia|vietnam)\b|₹|\b(?:rs\.?|inr)\s?\d`) },
  { id: 'campaign', re: R(String.raw`\bmega offer\b|\bfree (?:green|pink|red) line\b|\bceo desk\b`) },
];

function key(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/@[\w.]+/g, ' ')
    .replace(/[\p{P}\p{S}\p{M}\s\u200b-\u200d\u2060\ufeff]+/gu, '');
}
const who = (c) => String(c.author || c.author_username || '').trim().toLowerCase().replace(/^@/, '');

/** the reason a comment's text is spam on its own, or null */
function spamReason(text) {
  const t = String(text || '');
  const hit = RULES.find((r) => r.re.test(t));
  return hit ? hit.id : null;
}

/** posts: [{ comments: [{ author, text, … }] }]. Returns new posts without spam comments (each with spamRemoved
 *  when any were dropped) and a summary { removed, byReason }. */
function filterSpam(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const authorsByKey = new Map();
  for (const p of list) for (const c of p.comments || []) {
    const k = key(c.text);
    if (k.length < COPY_MIN_CHARS) continue;
    (authorsByKey.get(k) || authorsByKey.set(k, new Set()).get(k)).add(who(c));
  }
  const byReason = {};
  let removed = 0;
  const out = list.map((p) => {
    if (!Array.isArray(p.comments) || !p.comments.length) return p;
    let dropped = 0;
    const comments = p.comments.filter((c) => {
      let r = spamReason(c.text);
      if (!r) { const a = authorsByKey.get(key(c.text)); if (a && a.size >= COPY_MIN_AUTHORS) r = 'copy_paste'; }
      if (!r) return true;
      byReason[r] = (byReason[r] || 0) + 1; dropped++;
      return false;
    });
    if (!dropped) return p;
    removed += dropped;
    return { ...p, comments, spamRemoved: (p.spamRemoved || 0) + dropped };
  });
  return { posts: out, removed, byReason };
}

module.exports = { filterSpam, spamReason, COPY_MIN_CHARS, COPY_MIN_AUTHORS };
