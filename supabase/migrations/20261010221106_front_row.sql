-- Front Row Tier 1. App data is private; the browser only receives Realtime grants.
-- Apply to a dedicated Supabase project. This migration never changes existing policies.
create table public.front_row_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  title text not null default '' check (char_length(title) <= 120),
  language text not null check (language in ('en','es','fr','de','hi','pt')),
  status text not null default 'starting' check (status in ('starting','listening','reconnecting','ended')),
  speaker_secret_hash text not null check (speaker_secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  heartbeat_deadline timestamptz not null default (now() + interval '120 seconds'),
  ended_at timestamptz,
  purge_at timestamptz,
  version bigint not null default 1 check (version > 0)
);
create index front_row_rooms_active_expiry on public.front_row_rooms (heartbeat_deadline) where status <> 'ended';
create index front_row_rooms_purge on public.front_row_rooms (purge_at) where purge_at is not null;

create table public.front_row_captions (
  room_id uuid not null references public.front_row_rooms(id) on delete cascade,
  segment_id text not null check (segment_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  revision integer not null check (revision between 0 and 1000000000),
  text text not null check (char_length(text) <= 8000),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms >= start_ms and end_ms <= 21600000),
  created_at timestamptz not null default now(),
  primary key (room_id, segment_id)
);
create index front_row_captions_timeline on public.front_row_captions (room_id, start_ms, created_at);

-- These anonymous leases limit issued audience grants, not people or device identities.
create table public.front_row_guests (
  id uuid primary key,
  room_id uuid not null references public.front_row_rooms(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '10 minutes')
);
create index front_row_guests_room_expiry on public.front_row_guests (room_id, expires_at);
create index front_row_guests_expiry on public.front_row_guests (expires_at);

-- Keys contain a daily HMAC of the network address or a room UUID, never raw addresses.
create table public.front_row_rate_limits (
  key text primary key,
  hits integer not null,
  expires_at timestamptz not null
);
create index front_row_rates_expiry on public.front_row_rate_limits (expires_at);

alter table public.front_row_rooms enable row level security;
alter table public.front_row_captions enable row level security;
alter table public.front_row_guests enable row level security;
alter table public.front_row_rate_limits enable row level security;
revoke all on public.front_row_rooms, public.front_row_captions, public.front_row_guests, public.front_row_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.front_row_rooms, public.front_row_captions, public.front_row_guests, public.front_row_rate_limits to service_role;

create function public.front_row_room_json(p_room public.front_row_rooms)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id', (p_room).id, 'code', (p_room).code, 'title', (p_room).title,
    'language', (p_room).language, 'status', (p_room).status, 'createdAt', (p_room).created_at,
    'expiresAt', (p_room).expires_at, 'version', (p_room).version);
$$;

create function public.front_row_rate(p_key text, p_limit integer, p_seconds integer)
returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare v_hits integer;
begin
  insert into public.front_row_rate_limits as rates (key, hits, expires_at)
  values (p_key, 1, clock_timestamp() + make_interval(secs => p_seconds))
  on conflict (key) do update set
    hits = case when rates.expires_at <= clock_timestamp() then 1 else least(rates.hits + 1, 1000000) end,
    expires_at = case when rates.expires_at <= clock_timestamp() then clock_timestamp() + make_interval(secs => p_seconds) else rates.expires_at end
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

create function public.front_row_cleanup()
returns bigint language plpgsql volatile security invoker set search_path = '' as $$
declare v_deleted bigint;
begin
  update public.front_row_rooms
    set status = 'ended', ended_at = least(expires_at, heartbeat_deadline),
        purge_at = least(expires_at, heartbeat_deadline) + interval '24 hours', version = version + 1
    where status <> 'ended' and (expires_at <= clock_timestamp() or heartbeat_deadline <= clock_timestamp());
  delete from public.front_row_rooms where purge_at <= clock_timestamp();
  get diagnostics v_deleted = row_count;
  delete from public.front_row_guests where expires_at <= clock_timestamp();
  delete from public.front_row_rate_limits where expires_at <= clock_timestamp();
  return v_deleted;
end;
$$;

create function public.front_row_manage(
  p_action text, p_code text, p_secret_hash text default null,
  p_guest_id uuid default null, p_claim_room uuid default null,
  p_payload jsonb default '{}'::jsonb, p_rate_key text default null
)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_room public.front_row_rooms;
  v_caption public.front_row_captions;
  v_captions jsonb;
  v_speaker boolean;
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_action not in ('create','join','snapshot','refresh','transcription-token','authorize','caption','heartbeat','state','end')
    or p_code is null or p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    return jsonb_build_object('error', 'INVALID_REQUEST');
  end if;

  if p_action = 'create' then
    if p_rate_key is null or p_secret_hash is null or p_secret_hash !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(p_payload->'title') <> 'string' or char_length(p_payload->>'title') > 120
      or p_payload->>'language' not in ('en','es','fr','de','hi','pt') then
      return jsonb_build_object('error', 'INVALID_REQUEST');
    end if;
    if not public.front_row_rate('create:' || p_rate_key, 5, 600) then return jsonb_build_object('error', 'RATE_LIMIT'); end if;
    -- Serialize only room creation, making the five-active-room cap race safe.
    perform pg_advisory_xact_lock(781122034);
    perform public.front_row_cleanup();
    select count(*) into v_count from public.front_row_rooms where status <> 'ended';
    if v_count >= 5 then return jsonb_build_object('error', 'ROOM_LIMIT'); end if;
    insert into public.front_row_rooms (code, title, language, speaker_secret_hash)
      values (p_code, p_payload->>'title', p_payload->>'language', p_secret_hash)
      on conflict (code) do nothing returning * into v_room;
    if not found then return jsonb_build_object('error', 'CODE_COLLISION'); end if;
    return jsonb_build_object('room', public.front_row_room_json(v_room), 'captions', '[]'::jsonb);
  end if;

  if p_action = 'join' then
    if p_rate_key is null or p_guest_id is null then return jsonb_build_object('error', 'INVALID_REQUEST'); end if;
    if not public.front_row_rate('join:' || p_rate_key, 120, 60) then return jsonb_build_object('error', 'RATE_LIMIT'); end if;
  end if;

  -- Every read/modify decision shares the room lock, including End vs final caption.
  select * into v_room from public.front_row_rooms where code = p_code for update;
  if not found then return jsonb_build_object('error', 'ROOM_UNAVAILABLE'); end if;
  v_speaker := p_secret_hash is not null and p_secret_hash = v_room.speaker_secret_hash;

  if p_action <> 'join' and not v_speaker then
    if p_action not in ('snapshot','refresh') or p_claim_room is distinct from v_room.id or p_guest_id is null
      or not exists (select 1 from public.front_row_guests where id = p_guest_id and room_id = v_room.id and expires_at > clock_timestamp()) then
      return jsonb_build_object('error', 'UNAUTHORIZED');
    end if;
  end if;

  -- Return errors rather than raising exceptions so an expiry update is committed.
  if v_room.status <> 'ended' and (v_room.expires_at <= clock_timestamp() or v_room.heartbeat_deadline <= clock_timestamp()) then
    update public.front_row_rooms set status = 'ended', ended_at = least(expires_at, heartbeat_deadline),
      purge_at = least(expires_at, heartbeat_deadline) + interval '24 hours', version = version + 1
      where id = v_room.id returning * into v_room;
  end if;
  if v_room.status = 'ended' then
    if p_action = 'join' then return jsonb_build_object('error', 'ROOM_UNAVAILABLE'); end if;
    if p_action not in ('snapshot','end') then return jsonb_build_object('error', 'ROOM_ENDED'); end if;
    if v_room.purge_at <= clock_timestamp() then return jsonb_build_object('error', 'ROOM_UNAVAILABLE'); end if;
  end if;

  if p_action = 'join' then
    delete from public.front_row_guests where room_id = v_room.id and expires_at <= clock_timestamp();
    select count(*) into v_count from public.front_row_guests where room_id = v_room.id;
    if v_count >= 100 then return jsonb_build_object('error', 'ROOM_FULL'); end if;
    insert into public.front_row_guests (id, room_id) values (p_guest_id, v_room.id);
  elsif p_action = 'refresh' and not v_speaker then
    update public.front_row_guests set expires_at = clock_timestamp() + interval '10 minutes' where id = p_guest_id;
  elsif p_action = 'transcription-token' then
    if not public.front_row_rate('token:' || v_room.id::text, 12, 60) then return jsonb_build_object('error', 'RATE_LIMIT'); end if;
  elsif p_action = 'heartbeat' then
    update public.front_row_rooms set heartbeat_deadline = least(expires_at, clock_timestamp() + interval '120 seconds')
      where id = v_room.id returning * into v_room;
  elsif p_action = 'state' then
    if p_payload->>'status' not in ('listening','reconnecting') then return jsonb_build_object('error', 'INVALID_REQUEST'); end if;
    if p_payload ? 'expectedVersion' and (p_payload->>'expectedVersion')::bigint <> v_room.version then
      return jsonb_build_object('error', 'STALE_STATE');
    end if;
    if p_payload->>'status' <> v_room.status then
      update public.front_row_rooms set status = p_payload->>'status', version = version + 1
        where id = v_room.id returning * into v_room;
    end if;
  elsif p_action = 'end' and v_room.status <> 'ended' then
    update public.front_row_rooms set status = 'ended', ended_at = clock_timestamp(),
      purge_at = clock_timestamp() + interval '24 hours', version = version + 1
      where id = v_room.id returning * into v_room;
  elsif p_action = 'caption' then
    if p_payload->>'roomId' is distinct from v_room.id::text then return jsonb_build_object('error', 'UNAUTHORIZED'); end if;
    if not public.front_row_rate('caption:' || v_room.id::text, 600, 60) then return jsonb_build_object('error', 'RATE_LIMIT'); end if;
    select * into v_caption from public.front_row_captions where room_id = v_room.id and segment_id = p_payload->>'segmentId';
    if found then
      if (p_payload->>'final')::boolean and v_caption.revision = (p_payload->>'revision')::integer
        and v_caption.text = p_payload->>'text' and v_caption.start_ms = (p_payload->>'startMs')::integer
        and v_caption.end_ms = (p_payload->>'endMs')::integer then
        -- Re-broadcast an exact retry so a previous failed network delivery can recover.
        return jsonb_build_object('room', public.front_row_room_json(v_room), 'accepted', true);
      end if;
      if not (p_payload->>'final')::boolean then
        return jsonb_build_object('room', public.front_row_room_json(v_room), 'accepted', false);
      end if;
      return jsonb_build_object('error', 'CAPTION_CONFLICT');
    end if;
    if (p_payload->>'final')::boolean then
      insert into public.front_row_captions (room_id, segment_id, revision, text, start_ms, end_ms)
        values (v_room.id, p_payload->>'segmentId', (p_payload->>'revision')::integer,
          p_payload->>'text', (p_payload->>'startMs')::integer, (p_payload->>'endMs')::integer);
    end if;
    return jsonb_build_object('room', public.front_row_room_json(v_room), 'accepted', true);
  end if;

  if p_action in ('join','snapshot','refresh') then
    select coalesce(jsonb_agg(jsonb_build_object(
      'v', 1, 'type', 'caption', 'roomId', room_id, 'segmentId', segment_id,
      'revision', revision, 'final', true, 'text', text, 'startMs', start_ms, 'endMs', end_ms)
      order by start_ms, created_at, segment_id), '[]'::jsonb)
      into v_captions from public.front_row_captions where room_id = v_room.id;
    return jsonb_build_object('room', public.front_row_room_json(v_room), 'captions', v_captions, 'guestId', p_guest_id);
  end if;
  return jsonb_build_object('room', public.front_row_room_json(v_room));
end;
$$;

-- RPC functions are public for PostgREST discovery, executable only by the server role.
revoke all on function public.front_row_room_json(public.front_row_rooms), public.front_row_rate(text,integer,integer),
  public.front_row_cleanup(), public.front_row_manage(text,text,text,uuid,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.front_row_room_json(public.front_row_rooms), public.front_row_rate(text,integer,integer),
  public.front_row_cleanup(), public.front_row_manage(text,text,text,uuid,uuid,jsonb,text) to service_role;

-- Only RLS policies may be added to the hosted Realtime schema. Never ALTER its tables.
-- No room/table SELECT grants exist for guests; HTTP snapshots remain server-authorized.
create policy front_row_receive on realtime.messages for select to authenticated using (
  (select auth.jwt()->>'front_row_role') in ('speaker','audience')
  and (select realtime.topic()) = 'room:' || (select auth.jwt()->>'front_row_room')
  and realtime.messages.extension in ('broadcast','presence')
);
create policy front_row_presence on realtime.messages for insert to authenticated with check (
  (select auth.jwt()->>'front_row_role') in ('speaker','audience')
  and (select realtime.topic()) = 'room:' || (select auth.jwt()->>'front_row_room')
  and realtime.messages.extension = 'presence'
);

-- One-time owner setup after enabling pg_cron in the Supabase dashboard:
-- select cron.schedule('front-row-cleanup', '* * * * *', 'select public.front_row_cleanup();');
-- This runs as the scheduling database owner. Delete data within approximately one minute
-- after the 24-hour retention boundary. API requests enforce expiry even if cron is delayed.
