-- 021 — perf_payloads gains 'bench_90d' (Phase 10): the 7.2 benchmarks over the 90-day read, computed by the
-- 06:50 cron and served by /api/track?benchmarks=1 instead of a ~60 s cold read on the first visit each hour.
alter table perf_payloads drop constraint if exists perf_payloads_kind_check;
alter table perf_payloads add constraint perf_payloads_kind_check check (kind in ('track_60d','bench_90d'));
