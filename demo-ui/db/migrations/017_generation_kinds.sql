-- 017 — generation_records.kind gains 'assemble' (6.6 b): the ffmpeg composition job records
-- its run like every other generation. Before this, those inserts were rejected by the check
-- constraint and the best-effort writer only logged it (found 2026-10-22 when the test fake
-- began enforcing the migrations' check constraints).
alter table generation_records drop constraint if exists generation_records_kind_check;
alter table generation_records add constraint generation_records_kind_check check (kind in ('claude','higgsfield_image','higgsfield_video','f1x8','trend_judge','trend_curation','assemble'));
