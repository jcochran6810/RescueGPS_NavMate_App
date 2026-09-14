-- Add 'jumper' to the shared incidents.incident_type CHECK.
--
-- `incidents` belongs to BOTH applications (see supabase/migrations/README.md).
-- This is deliberately the smallest possible change to it: a CHECK is widened,
-- never narrowed. Widening invalidates no existing row and breaks no command
-- system code path, so it is safe to apply to a live shared table. Narrowing
-- would be the opposite, which is why 'jetski' stays in the list below even
-- though NavMate has stopped offering it — the code is retired in the picker,
-- not in the data, and rows already carrying it must stay valid.
--
-- The one visible consequence on the other side: the command dashboard has its
-- own label map and will show a NavMate 'jumper' incident as the raw code until
-- it adds one. That is a cosmetic gap in a different repo, recorded in
-- fix_list.md rather than papered over here.

alter table public.incidents
  drop constraint if exists incidents_incident_type_check;

alter table public.incidents
  add constraint incidents_incident_type_check check (incident_type in (
    'piw', 'kayak', 'jetski', 'swimmer', 'diver', 'missing_vessel',
    'capsized_vessel', 'debris_field', 'life_raft', 'found_watercraft',
    'vessel_overdue', 'vessel_in_distress', 'missing_person', 'medical',
    'fire', 'hazmat', 'other',
    'missing_person_piw', 'debris_found', 'medical_emergency',
    'missing_person_land', 'mass_rescue',
    -- new: a jumper or long fall from a bridge, pier or height into water.
    'jumper'
  ));
