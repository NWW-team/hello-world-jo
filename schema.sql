-- ============================================================================
--  Early Warning System — Google Trends signalering
--  Ministerie van Buitenlandse Zaken (BZ)
--
--  Uitvoeren in: Supabase Dashboard -> SQL Editor.
--  Het script is idempotent en mag opnieuw gedraaid worden.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
--  Types
-- ----------------------------------------------------------------------------
do $types$
begin
  if not exists (select 1 from pg_type where typname = 'alert_severity') then
    create type public.alert_severity as enum ('low', 'medium', 'high', 'critical');
  end if;
end
$types$;

-- ----------------------------------------------------------------------------
--  Landen die gemonitord worden
-- ----------------------------------------------------------------------------
create table if not exists public.monitored_countries (
  code       text primary key,
  name       text not null,
  region     text,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.monitored_countries is
  'ISO-3166-1 alpha-2 landcodes waarvoor de Google Trends RSS-feed wordt opgehaald.';

insert into public.monitored_countries (code, name, region) values
  ('NG', 'Nigeria',        'West-Afrika'),
  ('VE', 'Venezuela',      'Latijns-Amerika'),
  ('UA', 'Oekraine',       'Oost-Europa'),
  ('LB', 'Libanon',        'Midden-Oosten'),
  ('ML', 'Mali',           'Sahel'),
  ('PK', 'Pakistan',       'Zuid-Azie'),
  ('ET', 'Ethiopie',       'Hoorn van Afrika'),
  ('CO', 'Colombia',       'Latijns-Amerika'),
  ('ID', 'Indonesie',      'Zuidoost-Azie'),
  ('NL', 'Nederland',      'West-Europa')
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
--  Opgehaalde trends
-- ----------------------------------------------------------------------------
create table if not exists public.trends (
  id              uuid primary key default gen_random_uuid(),
  country_code    text not null references public.monitored_countries (code) on update cascade,
  keyword         text not null,
  search_volume   bigint not null default 0,
  traffic_label   text,
  previous_volume bigint,
  volume_delta    bigint not null default 0,
  is_breakout     boolean not null default false,
  keyword_nl      text,
  news_title      text,
  news_title_nl   text,
  news_snippet    text,
  news_url        text,
  news_source     text,
  picture_url     text,
  trend_link      text,
  is_relevant     boolean not null default false,
  relevant_labels text[]  not null default '{}',
  pub_date        timestamptz not null,
  first_seen_at   timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint trends_unique_observation unique (country_code, keyword, pub_date)
);

-- Kolommen toevoegen aan een tabel die al bestond vóór deze wijziging
-- (create table if not exists slaat de body over als de tabel al bestaat).
alter table public.trends add column if not exists keyword_nl      text;
alter table public.trends add column if not exists news_title_nl   text;
alter table public.trends add column if not exists is_relevant     boolean not null default false;
alter table public.trends add column if not exists relevant_labels text[]  not null default '{}';

comment on column public.trends.keyword_nl is
  'Automatische Nederlandse vertaling van keyword, ingevuld door de fetch-trends edge function.';
comment on column public.trends.news_title_nl is
  'Automatische Nederlandse vertaling van news_title, ingevuld door de fetch-trends edge function.';
comment on column public.trends.is_relevant is
  'True als keyword/news_title matcht met een enabled alert_rules-patroon, ongeacht min_volume.';
comment on column public.trends.relevant_labels is
  'Labels van alle alert_rules die matchen (bv. "Verkiezingen", "Onrust en protest"), voor filtering/sortering in het dashboard.';

create index if not exists trends_country_pub_date_idx on public.trends (country_code, pub_date desc);
create index if not exists trends_created_at_idx       on public.trends (created_at desc);
create index if not exists trends_keyword_idx          on public.trends (keyword);
create index if not exists trends_breakout_idx         on public.trends (is_breakout) where is_breakout;
create index if not exists trends_relevant_idx         on public.trends (is_relevant) where is_relevant;

-- ----------------------------------------------------------------------------
--  Signaalwoorden-watchlist
-- ----------------------------------------------------------------------------
create table if not exists public.alert_rules (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  pattern    text not null,
  min_volume bigint not null default 0,
  severity   public.alert_severity not null default 'high',
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

comment on column public.alert_rules.pattern is
  'POSIX regex, hoofdletterongevoelig toegepast op het trending keyword.';

insert into public.alert_rules (label, pattern, min_volume, severity) values
  ('Staatsgreep',        'coup|staatsgreep|golpe de estado|putsch|junta|military takeover',                    0,      'critical'),
  ('Evacuatie',          'evacuat|evacuacion|evacuation|evacuatie|repatri',                                     0,      'critical'),
  ('Aanslag of explosie','attack|bombing|explosion|terror|atentado|aanslag|explosion|shooting|gunmen',          0,      'critical'),
  ('Ambassade',          'embassy|ambassade|embajada|consulate|consulaat|consulado',                            0,      'critical'),
  ('Ontvoering',         'kidnap|hostage|secuestro|ontvoering|gijzeling|abduct',                                0,      'critical'),
  ('Noodtoestand',       'curfew|state of emergency|estado de excepcion|noodtoestand|martial law|toque de queda',0,      'critical'),
  ('Onrust en protest',  'protest|riot|unrest|manifestacion|disturbios|betoging|rellen|uprising|huelga|strike', 20000,  'high'),
  ('Natuurramp',         'earthquake|terremoto|aardbeving|seisme|flood|inundacion|overstroming|hurricane|cyclone|wildfire', 20000, 'high'),
  ('Gezondheidscrisis',  'outbreak|epidemic|pandemic|cholera|ebola|uitbraak|brote|quarantine',                  20000,  'high'),
  ('Verkiezingen',       'election|verkiezing|elecciones|referendum|ballot|stembus',                            50000,  'medium'),
  ('Economische stress', 'devaluation|hyperinflation|fuel shortage|blackout|apagon|stroomuitval|bank run',      50000,  'medium'),
  ('Grens en migratie',  'border closure|frontera|grens|refugee|vluchteling|migrant|asylum',                    50000,  'medium')
on conflict (label) do nothing;

-- ----------------------------------------------------------------------------
--  Gegenereerde alerts
-- ----------------------------------------------------------------------------
create table if not exists public.alerts (
  id              uuid primary key default gen_random_uuid(),
  trend_id        uuid not null references public.trends (id) on delete cascade,
  rule_id         uuid references public.alert_rules (id) on delete set null,
  rule_key        text not null,
  country_code    text not null,
  keyword         text not null,
  severity        public.alert_severity not null,
  search_volume   bigint not null default 0,
  reason          text not null,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at      timestamptz not null default now(),
  constraint alerts_unique_per_rule unique (trend_id, rule_key)
);

create index if not exists alerts_created_at_idx on public.alerts (created_at desc);
create index if not exists alerts_severity_idx   on public.alerts (severity, created_at desc);
create index if not exists alerts_open_idx       on public.alerts (created_at desc) where acknowledged_at is null;

-- ----------------------------------------------------------------------------
--  Velocity: bereken groei ten opzichte van de vorige waarneming
-- ----------------------------------------------------------------------------
create or replace function public.fn_trends_compute_velocity()
returns trigger
language plpgsql
set search_path = public
as $velocity$
declare
  prev_volume bigint;
begin
  if tg_op = 'UPDATE' then
    new.first_seen_at := old.first_seen_at;

    -- Volume ongewijzigd: bestaande velocity bewaren zodat alerts niet flapperen.
    if new.search_volume = old.search_volume then
      new.previous_volume := old.previous_volume;
      new.volume_delta    := old.volume_delta;
      new.is_breakout     := old.is_breakout;
      new.updated_at      := now();
      return new;
    end if;

    prev_volume := old.search_volume;
  else
    select t.search_volume
      into prev_volume
      from public.trends t
     where t.country_code = new.country_code
       and t.keyword = new.keyword
       and t.id is distinct from new.id
     order by t.pub_date desc, t.created_at desc
     limit 1;
  end if;

  new.previous_volume := prev_volume;
  new.volume_delta    := new.search_volume - coalesce(prev_volume, 0);
  new.is_breakout     := (
       (prev_volume is null and new.search_volume >= 50000)
    or (coalesce(prev_volume, 0) > 0
        and new.search_volume >= prev_volume * 2
        and (new.search_volume - prev_volume) >= 20000)
  );
  new.updated_at := now();
  return new;
end;
$velocity$;

drop trigger if exists trg_trends_velocity on public.trends;
create trigger trg_trends_velocity
  before insert or update on public.trends
  for each row execute function public.fn_trends_compute_velocity();

-- ----------------------------------------------------------------------------
--  Relevantie voor internationale zaken/politiek: matcht keyword + nieuwstitel
--  tegen de bestaande alert_rules-watchlist, los van min_volume. Zo kan het
--  dashboard filteren/sorteren op relevantie, ook onder de alert-drempel.
-- ----------------------------------------------------------------------------
create or replace function public.fn_trends_flag_relevance()
returns trigger
language plpgsql
set search_path = public
as $relevance$
declare
  matched text[];
  haystack text;
begin
  haystack := new.keyword || ' ' || coalesce(new.news_title, '');

  select coalesce(array_agg(r.label order by r.label), '{}')
    into matched
    from public.alert_rules r
   where r.enabled
     and haystack ~* r.pattern;

  new.relevant_labels := matched;
  new.is_relevant      := coalesce(array_length(matched, 1), 0) > 0;
  return new;
end;
$relevance$;

drop trigger if exists trg_trends_relevance on public.trends;
create trigger trg_trends_relevance
  before insert or update on public.trends
  for each row execute function public.fn_trends_flag_relevance();

-- ----------------------------------------------------------------------------
--  Alert-generatie
-- ----------------------------------------------------------------------------
create or replace function public.fn_trends_evaluate_alerts()
returns trigger
language plpgsql
security definer
set search_path = public
as $alerts$
declare
  rule     public.alert_rules%rowtype;
  severity public.alert_severity;
begin
  for rule in
    select *
      from public.alert_rules r
     where r.enabled
       and new.search_volume >= r.min_volume
       and new.keyword ~* r.pattern
  loop
    severity := rule.severity;
    if new.is_breakout and severity = 'high' then
      severity := 'critical';
    end if;

    insert into public.alerts
      (trend_id, rule_id, rule_key, country_code, keyword, severity, search_volume, reason)
    values
      (new.id, rule.id, rule.id::text, new.country_code, new.keyword, severity, new.search_volume,
       format('Watchlist "%s" geraakt met %s geschatte zoekopdrachten', rule.label, new.search_volume))
    on conflict (trend_id, rule_key) do update
       set severity      = excluded.severity,
           search_volume = excluded.search_volume,
           reason        = excluded.reason;
  end loop;

  if new.search_volume >= 200000 or new.is_breakout then
    severity := case
      when new.search_volume >= 500000 then 'critical'::public.alert_severity
      else 'high'::public.alert_severity
    end;

    insert into public.alerts
      (trend_id, rule_id, rule_key, country_code, keyword, severity, search_volume, reason)
    values
      (new.id, null, 'volume_spike', new.country_code, new.keyword, severity, new.search_volume,
       case
         when new.is_breakout then format('Breakout: volume verdubbeld van %s naar %s',
                                          coalesce(new.previous_volume, 0), new.search_volume)
         else format('Hoog zoekvolume gedetecteerd: %s', new.search_volume)
       end)
    on conflict (trend_id, rule_key) do update
       set severity      = excluded.severity,
           search_volume = excluded.search_volume,
           reason        = excluded.reason;
  end if;

  return null;
end;
$alerts$;

drop trigger if exists trg_trends_alerts on public.trends;
create trigger trg_trends_alerts
  after insert or update on public.trends
  for each row execute function public.fn_trends_evaluate_alerts();

-- ----------------------------------------------------------------------------
--  Views voor het dashboard
-- ----------------------------------------------------------------------------
create or replace view public.v_trends_enriched as
  select t.*,
         c.name   as country_name,
         c.region as country_region
    from public.trends t
    join public.monitored_countries c on c.code = t.country_code;

alter view public.v_trends_enriched set (security_invoker = on);

create or replace view public.v_active_alerts as
  select a.*,
         c.name        as country_name,
         c.region      as country_region,
         t.keyword_nl,
         t.news_title,
         t.news_title_nl,
         t.news_url,
         t.is_breakout,
         t.is_relevant,
         t.relevant_labels,
         t.pub_date
    from public.alerts a
    join public.trends t             on t.id = a.trend_id
    join public.monitored_countries c on c.code = a.country_code
   where a.acknowledged_at is null;

alter view public.v_active_alerts set (security_invoker = on);

-- ----------------------------------------------------------------------------
--  Row Level Security: alleen ingelogde gebruikers lezen, schrijven via service_role
-- ----------------------------------------------------------------------------
alter table public.monitored_countries enable row level security;
alter table public.trends              enable row level security;
alter table public.alert_rules         enable row level security;
alter table public.alerts              enable row level security;

-- De anon-sleutel staat in de browser en geeft daarom nergens toegang toe.
revoke all on public.monitored_countries from anon;
revoke all on public.trends              from anon;
revoke all on public.alert_rules         from anon;
revoke all on public.alerts              from anon;
revoke all on public.v_trends_enriched   from anon;
revoke all on public.v_active_alerts     from anon;

drop policy if exists "countries_read" on public.monitored_countries;
create policy "countries_read" on public.monitored_countries
  for select to authenticated using (true);

drop policy if exists "trends_read" on public.trends;
create policy "trends_read" on public.trends
  for select to authenticated using (true);

drop policy if exists "alert_rules_read" on public.alert_rules;
create policy "alert_rules_read" on public.alert_rules
  for select to authenticated using (true);

drop policy if exists "alerts_read" on public.alerts;
create policy "alerts_read" on public.alerts
  for select to authenticated using (true);

-- Afvinken mag, maar uitsluitend op deze twee kolommen.
revoke update on public.alerts from authenticated;
grant  update (acknowledged_at, acknowledged_by) on public.alerts to authenticated;

drop policy if exists "alerts_acknowledge" on public.alerts;
create policy "alerts_acknowledge" on public.alerts
  for update to authenticated using (true) with check (true);

-- De client mag niet bepalen wie er afvinkte; dat leest de trigger uit het JWT.
create or replace function public.fn_alerts_stamp_ack()
returns trigger
language plpgsql
set search_path = public
as $ack$
begin
  if new.acknowledged_at is distinct from old.acknowledged_at then
    if new.acknowledged_at is null then
      new.acknowledged_by := null;
    else
      new.acknowledged_at := now();
      new.acknowledged_by := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
    end if;
  else
    new.acknowledged_by := old.acknowledged_by;
  end if;
  return new;
end;
$ack$;

drop trigger if exists trg_alerts_stamp_ack on public.alerts;
create trigger trg_alerts_stamp_ack
  before update on public.alerts
  for each row execute function public.fn_alerts_stamp_ack();

-- ----------------------------------------------------------------------------
--  Realtime voor live dashboard-updates
-- ----------------------------------------------------------------------------
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.trends;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.alerts;
    exception when duplicate_object then null;
    end;
  end if;
end
$realtime$;

-- ----------------------------------------------------------------------------
--  Retentie: waarnemingen ouder dan 90 dagen opruimen
-- ----------------------------------------------------------------------------
create or replace function public.fn_prune_trends()
returns integer
language plpgsql
security definer
set search_path = public
as $prune$
declare
  removed integer;
begin
  delete from public.trends where pub_date < now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end;
$prune$;

-- ----------------------------------------------------------------------------
--  Functierechten: niets in public is aanroepbaar via de REST-API.
--  Zonder dit kan iedereen met de anon-sleutel /rest/v1/rpc/fn_prune_trends
--  aanroepen en daarmee data verwijderen. Triggers draaien als tabeleigenaar
--  en blijven dus gewoon werken.
-- ----------------------------------------------------------------------------
revoke execute on function public.fn_prune_trends()            from anon, authenticated, public;
revoke execute on function public.fn_trends_evaluate_alerts()  from anon, authenticated, public;
revoke execute on function public.fn_trends_compute_velocity() from anon, authenticated, public;
revoke execute on function public.fn_trends_flag_relevance()   from anon, authenticated, public;
revoke execute on function public.fn_alerts_stamp_ack()        from anon, authenticated, public;

-- ============================================================================
--  OPTIONEEL: periodiek ophalen via pg_cron
--
--  Vervang <PROJECT_REF> en <SERVICE_ROLE_KEY> door de waarden uit
--  Supabase Dashboard -> Project Settings -> API, en voer dit blok apart uit.
--  De service role key hoort NIET in versiebeheer terecht te komen.
-- ============================================================================
--
-- create extension if not exists pg_cron with schema extensions;
-- create extension if not exists pg_net  with schema extensions;
--
-- select cron.schedule(
--   'fetch-trends-hourly',
--   '7 * * * *',
--   $cron$
--     select net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/fetch-trends',
--       headers := jsonb_build_object(
--                    'Content-Type',  'application/json',
--                    'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
--                  ),
--       body    := '{}'::jsonb
--     );
--   $cron$
-- );
--
-- select cron.schedule('prune-trends-daily', '30 3 * * *', $cron$ select public.fn_prune_trends(); $cron$);
