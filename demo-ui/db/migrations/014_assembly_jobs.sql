-- 014 — Phase 6.6 (b): the assembly and clip-check job kinds (ffmpeg inside
-- the job service): `assemble` turns approved clips into one cut, `clip_check`
-- extracts frames from a clip for the vision check.
alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check check (kind in ('director','higgsfield_image','higgsfield_video','f1x8_image','f1x8_video','hermes_stage','curation','vision_check','assemble','clip_check'));
