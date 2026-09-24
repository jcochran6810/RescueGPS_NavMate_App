-- Integration contract v1 — N2 (C4): a waypoint dropped during an incident
-- carries that incident's id, so the command system can find it.
-- team_id stays the crew scope; incident_id is the incident link.
alter table public.waypoints
  add column if not exists incident_id uuid references public.incidents(id) on delete set null;

create index if not exists waypoints_incident_id_idx
  on public.waypoints (incident_id) where incident_id is not null;
