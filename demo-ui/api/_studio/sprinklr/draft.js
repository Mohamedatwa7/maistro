// A planned slot → a Sprinklr OutboundMessage draft (spec schema OutboundMessage: content, scheduleDate, taxonomy and
// accountGroupIds are required; the video goes in as a VideoAttachment by URL, so no media upload is needed).
// The draft carries the slot time but is not scheduled; a person schedules it inside Sprinklr.

/** "platform:account=accountGroupId,…" → { 'tiktok:samsunggulf': 'gid' } */
function accountGroups() {
  const out = {};
  for (const x of String(process.env.SPRINKLR_ACCOUNT_GROUPS || '').split(',')) {
    const [k, gid] = x.trim().split('=');
    if (!k || !gid) continue;
    const [p, a] = k.trim().toLowerCase().split(':');
    if (p && a) out[`${p === 'twitter' ? 'x' : p}:${a.replace(/^@/, '')}`] = gid.trim();
  }
  return out;
}
const campaignId = () => String(process.env.SPRINKLR_CAMPAIGN_ID || '').trim() || null;

/** Every field the draft needs, or the first missing one as { error, code } */
function buildDraft({ slot, piece, videoUrl, thumbUrl, durationS }) {
  const gid = accountGroups()[`${slot.platform}:${slot.account}`];
  if (!gid) return { error: `no Sprinklr account group for ${slot.platform}:${slot.account} (SPRINKLR_ACCOUNT_GROUPS)`, code: 'sprinklr_account_unmapped' };
  if (!campaignId()) return { error: 'SPRINKLR_CAMPAIGN_ID is not set', code: 'sprinklr_campaign_unset' };
  if (!videoUrl) return { error: 'the approved final has no stored video to attach', code: 'sprinklr_no_video' };
  const attachment = { type: 'VIDEO', url: videoUrl, mimeType: 'video/mp4', title: piece.title || undefined };
  if (thumbUrl) attachment.previewUrl = thumbUrl;
  if (Number.isFinite(durationS)) attachment.duration = durationS;
  return {
    message: {
      content: { text: slot.caption || '', attachment },
      scheduleDate: Date.parse(slot.slot_at), // epoch ms; the draft holds the time, Sprinklr schedules nothing until a person does
      taxonomy: { name: `Maistro · ${piece.title || piece.legacy_id}`, campaignId: campaignId(), tags: ['maistro', `maistro-piece-${piece.legacy_id}`, `maistro-slot-${slot.id}`] },
      accountGroupIds: [gid],
      externalId: `maistro-slot-${slot.id}`,
    },
  };
}

module.exports = { accountGroups, campaignId, buildDraft };
