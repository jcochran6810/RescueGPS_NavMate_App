-- "Keep ___ ft from shallows" — the route planner's corridor, per boat, metres.
--
-- Outside marked channels the planned route keeps at least this far from
-- water charted shallower than the boat needs (inside a channel it keeps to
-- the middle). NULL means "not set": the app uses its default, 100 ft
-- (30.48 m). Additive and nullable, so nothing that reads `vessels` today —
-- RescueGPS's N3 read included — is affected.
--
-- NOT APPLIED by the app or its deploys. Until it is, the app keeps the
-- setting on the device (per vessel id) and does not send the column: it
-- only starts writing `shallow_margin_m` once the server's own rows show the
-- column exists (src/store/useVessels.ts, `serverHasShallowMargin`).
alter table public.vessels
  add column if not exists shallow_margin_m double precision
    check (shallow_margin_m is null or (shallow_margin_m >= 0 and shallow_margin_m <= 300));
