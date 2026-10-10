-- Name a session after it ends, using the existing speaker secret.
create function public.front_row_title(p_code text, p_secret_hash text, p_title text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_room public.front_row_rooms;
begin
  if p_title is null or char_length(btrim(p_title)) > 120 or p_title ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', 'INVALID_REQUEST');
  end if;
  select * into v_room from public.front_row_rooms where code = p_code for update;
  if not found then return jsonb_build_object('error', 'ROOM_UNAVAILABLE'); end if;
  if p_secret_hash is null or p_secret_hash is distinct from v_room.speaker_secret_hash then
    return jsonb_build_object('error', 'UNAUTHORIZED');
  end if;
  if v_room.status <> 'ended' then return jsonb_build_object('error', 'INVALID_REQUEST'); end if;
  if v_room.purge_at <= clock_timestamp() then return jsonb_build_object('error', 'ROOM_UNAVAILABLE'); end if;
  if v_room.title is distinct from btrim(p_title) then
    update public.front_row_rooms set title = btrim(p_title), version = version + 1 where id = v_room.id returning * into v_room;
  end if;
  return jsonb_build_object('room', public.front_row_room_json(v_room));
end;
$$;
revoke all on function public.front_row_title(text,text,text) from public, anon, authenticated;
grant execute on function public.front_row_title(text,text,text) to service_role;
