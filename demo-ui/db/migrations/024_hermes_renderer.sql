-- 024 — the owner's Hermes bots replace Higgsfield as the Studio's renderer (2026-10-27). New job kinds
-- hermes_image (moodboard, thumbnail, storyboard keyframes), hermes_video (draft/final clips) and
-- hermes_brief (the structured brief); their generation records carry the same kinds; a version made by
-- a bot is produced_by 'hermes'. The higgsfield_* values stay so rows from before the switch remain valid.
alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check check (kind in ('director','higgsfield_image','higgsfield_video','f1x8_image','f1x8_video','hermes_stage','curation','vision_check','assemble','clip_check','hermes_image','hermes_video','hermes_brief'));
alter table generation_records drop constraint if exists generation_records_kind_check;
alter table generation_records add constraint generation_records_kind_check check (kind in ('claude','higgsfield_image','higgsfield_video','f1x8','trend_judge','trend_curation','assemble','hermes_image','hermes_video','hermes_brief'));
alter table artifact_versions drop constraint if exists artifact_versions_produced_by_check;
alter table artifact_versions add constraint artifact_versions_produced_by_check check (produced_by in ('claude','higgsfield_soul','higgsfield_seedance','f1x8','external_hermes','manual','hermes'));
