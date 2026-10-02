-- Existing installations: apply once before deploying the reconnection routes.
-- Only the server's service role can change Telegram bindings. Documents never move.
alter table public.bots alter column telegram_bot_id drop not null;
alter table public.bots alter column telegram_token_encrypted drop not null;
alter table public.bots drop constraint bots_status_check;
alter table public.bots add constraint bots_status_check check(status in ('created','connected','disconnected'));

create table public.telegram_connection_leases (
  telegram_bot_id bigint primary key,
  lease_token uuid not null,
  lease_until timestamptz not null
);
alter table public.telegram_connection_leases enable row level security;
revoke all on public.telegram_connection_leases from public,anon,authenticated;
grant all on public.telegram_connection_leases to service_role;

create function public.reserve_bot_connection(
  p_bot_id uuid,p_owner_id uuid,p_telegram_bot_id bigint,p_username text,
  p_nvidia_key text,p_telegram_token text,p_secret_hash text,p_reconnect boolean
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare target public.bots; previous public.bots; operation uuid:=gen_random_uuid(); moved boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended('docbot-owner:'||p_owner_id::text,0));
  perform pg_advisory_xact_lock(p_telegram_bot_id);
  if exists(select 1 from public.telegram_connection_leases where telegram_bot_id=p_telegram_bot_id and lease_until>now()) then
    raise exception 'Bot connection in progress';
  end if;
  select * into target from public.bots where owner_id=p_owner_id for update;
  if target.id is not null and (target.id<>p_bot_id or (target.telegram_bot_id is not null and target.telegram_bot_id<>p_telegram_bot_id)) then
    raise exception 'Workspace connection changed';
  end if;
  select * into previous from public.bots where telegram_bot_id=p_telegram_bot_id for update;
  if previous.id is not null and previous.owner_id<>p_owner_id then
    if not coalesce(p_reconnect,false) then raise exception 'Bot reconnection confirmation required'; end if;
    moved:=true;
    update public.bots set telegram_bot_id=null,telegram_token_encrypted=null,status='disconnected',
      webhook_secret_sha256='',pending_webhook_secret_sha256=null,claim_sha256=null,paired_chat_id=null
      where id=previous.id and owner_id=previous.owner_id;
    delete from public.telegram_updates where bot_id=previous.id;
  end if;
  insert into public.telegram_connection_leases(telegram_bot_id,lease_token,lease_until)
    values(p_telegram_bot_id,operation,now()+interval '45 seconds')
    on conflict(telegram_bot_id) do update set lease_token=excluded.lease_token,lease_until=excluded.lease_until;
  if target.id is null then
    insert into public.bots(id,owner_id,telegram_bot_id,telegram_username,nvidia_key_encrypted,telegram_token_encrypted,
      webhook_secret_sha256,pending_webhook_secret_sha256,status)
      values(p_bot_id,p_owner_id,p_telegram_bot_id,p_username,p_nvidia_key,p_telegram_token,'',p_secret_hash,'created');
  else
    update public.bots set telegram_bot_id=p_telegram_bot_id,telegram_username=p_username,nvidia_key_encrypted=p_nvidia_key,
      telegram_token_encrypted=p_telegram_token,webhook_secret_sha256='',pending_webhook_secret_sha256=p_secret_hash,status='created',
      claim_sha256=case when moved then null else claim_sha256 end,
      paired_chat_id=case when moved then null else paired_chat_id end
      where id=p_bot_id and owner_id=p_owner_id;
    -- An old prepared reply must not survive a credential/connection change.
    delete from public.telegram_updates where bot_id=p_bot_id;
  end if;
  return jsonb_build_object('lease_token',operation,'moved',moved);
end $$;

create function public.finish_bot_connection(p_bot_id uuid,p_owner_id uuid,p_telegram_bot_id bigint,p_lease_token uuid,p_secret_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(p_telegram_bot_id);
  if not exists(select 1 from public.telegram_connection_leases where telegram_bot_id=p_telegram_bot_id
    and lease_token=p_lease_token and lease_until>now()) then return false; end if;
  update public.bots set status='connected',webhook_secret_sha256=p_secret_hash,pending_webhook_secret_sha256=null
    where id=p_bot_id and owner_id=p_owner_id and telegram_bot_id=p_telegram_bot_id and pending_webhook_secret_sha256=p_secret_hash;
  return found;
end $$;

create function public.reserve_bot_disconnect(p_bot_id uuid,p_owner_id uuid,p_telegram_bot_id bigint)
returns uuid language plpgsql security invoker set search_path='' as $$
declare operation uuid:=gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended('docbot-owner:'||p_owner_id::text,0));
  perform pg_advisory_xact_lock(p_telegram_bot_id);
  if exists(select 1 from public.telegram_connection_leases where telegram_bot_id=p_telegram_bot_id and lease_until>now()) then
    raise exception 'Bot connection in progress';
  end if;
  update public.bots set telegram_bot_id=null,telegram_token_encrypted=null,status='disconnected',
    webhook_secret_sha256='',pending_webhook_secret_sha256=null,claim_sha256=null,paired_chat_id=null
    where id=p_bot_id and owner_id=p_owner_id and telegram_bot_id=p_telegram_bot_id;
  if not found then raise exception 'Workspace connection changed'; end if;
  insert into public.telegram_connection_leases(telegram_bot_id,lease_token,lease_until)
    values(p_telegram_bot_id,operation,now()+interval '45 seconds')
    on conflict(telegram_bot_id) do update set lease_token=excluded.lease_token,lease_until=excluded.lease_until;
  delete from public.telegram_updates where bot_id=p_bot_id;
  return operation;
end $$;

create function public.release_bot_connection(p_telegram_bot_id bigint,p_lease_token uuid)
returns void language sql security invoker set search_path='' as $$
  delete from public.telegram_connection_leases where telegram_bot_id=p_telegram_bot_id and lease_token=p_lease_token;
$$;

revoke all on function public.reserve_bot_connection(uuid,uuid,bigint,text,text,text,text,boolean),
  public.finish_bot_connection(uuid,uuid,bigint,uuid,text),public.reserve_bot_disconnect(uuid,uuid,bigint),
  public.release_bot_connection(bigint,uuid) from public,anon,authenticated;
grant execute on function public.reserve_bot_connection(uuid,uuid,bigint,text,text,text,text,boolean),
  public.finish_bot_connection(uuid,uuid,bigint,uuid,text),public.reserve_bot_disconnect(uuid,uuid,bigint),
  public.release_bot_connection(bigint,uuid) to service_role;
