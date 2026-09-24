-- Integration contract v1 — N10: soft deletes on the NavMate tables the
-- command system reads. Delete in the app sets deleted_at; reads filter it.
-- RescueGPS's sar_records fan-out (R3) mirrors deleted_at onto its copies.
alter table public.waypoints   add column if not exists deleted_at timestamptz;
alter table public.sar_records add column if not exists deleted_at timestamptz;
alter table public.vessels     add column if not exists deleted_at timestamptz;
