-- Integration check: every fixture and binding change is rolled back.
begin;
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  ba uuid:=gen_random_uuid(); bb uuid:=gen_random_uuid(); doc uuid;
  tid bigint:=900000000000000+(random()*1000000)::bigint; reservation jsonb;
  v extensions.vector(2048):=('['||array_to_string(array_fill(0.1::float8,array[2048]),',')||']')::extensions.vector;
begin
  insert into auth.users(id,aud,role,is_anonymous,created_at,updated_at)
    values(a,'authenticated','authenticated',true,now(),now()),(b,'authenticated','authenticated',true,now(),now());
  insert into public.bots(id,owner_id,telegram_bot_id,telegram_username,nvidia_key_encrypted,telegram_token_encrypted,
    webhook_secret_sha256,claim_sha256,paired_chat_id,status)
    values(ba,a,tid,'synthetic_test_bot','old-private-key','old-private-token',repeat('a',64),repeat('b',64),42,'connected');
  doc:=public.create_document(ba,a,'Old private test document',repeat('a',64),'[{"page":1,"content":"Old owner synthetic document."}]');
  update public.documents set status='ready' where id=doc;
  update public.document_chunks set embedding=v where document_id=doc;
  insert into public.telegram_updates(bot_id,update_id,lease_until,payload) values(ba,1,now()+interval '180 seconds','["Old private synthetic reply"]');
  begin
    perform public.reserve_bot_connection(bb,b,tid,'synthetic_test_bot','new-private-key','new-private-token',repeat('c',64),false);
    raise exception 'Unconfirmed reconnect was accepted';
  exception when others then
    if sqlerrm<>'Bot reconnection confirmation required' then raise; end if;
  end;
  if not exists(select 1 from public.bots where id=ba and telegram_bot_id=tid and status='connected') then raise exception 'Unconfirmed reconnect mutated ownership'; end if;
  reservation:=public.reserve_bot_connection(bb,b,tid,'synthetic_test_bot','new-private-key','new-private-token',repeat('c',64),true);
  if not (reservation->>'moved')::boolean then raise exception 'Reconnect did not report move'; end if;
  if not exists(select 1 from public.bots where id=ba and owner_id=a and telegram_bot_id is null and telegram_token_encrypted is null
    and webhook_secret_sha256='' and pending_webhook_secret_sha256 is null and paired_chat_id is null and claim_sha256 is null
    and status='disconnected' and nvidia_key_encrypted='old-private-key') then raise exception 'Old binding or private key invalidation failed'; end if;
  if not exists(select 1 from public.documents where id=doc and bot_id=ba and owner_id=a) then raise exception 'Old document moved or disappeared'; end if;
  if exists(select 1 from public.telegram_updates where bot_id=ba) then raise exception 'Old queued payload survived'; end if;
  if (select count(*) from public.match_document_chunks(ba,a,v))<>1 then raise exception 'Old owner lost its document'; end if;
  if exists(select 1 from public.match_document_chunks(ba,b,v)) then raise exception 'New owner could retrieve old document'; end if;
  begin
    perform public.reserve_bot_connection(bb,b,tid,'synthetic_test_bot','key','token',repeat('d',64),true);
    raise exception 'Concurrent reservation was accepted';
  exception when others then if sqlerrm<>'Bot connection in progress' then raise; end if; end;
  if public.finish_bot_connection(bb,b,tid,gen_random_uuid(),repeat('c',64)) then raise exception 'Stale operation finalized'; end if;
  if not public.finish_bot_connection(bb,b,tid,(reservation->>'lease_token')::uuid,repeat('c',64)) then raise exception 'Correct operation failed'; end if;
  perform public.release_bot_connection(tid,(reservation->>'lease_token')::uuid);
  perform public.create_document(bb,b,'New private test document',repeat('d',64),'[{"page":2,"content":"New owner synthetic document."}]');
  update public.bots set paired_chat_id=43,claim_sha256=repeat('e',64) where id=bb;
  reservation:=public.reserve_bot_connection(bb,b,tid,'synthetic_test_bot','new-private-key','new-token',repeat('f',64),false);
  if (reservation->>'moved')::boolean then raise exception 'Same-owner retry moved workspace'; end if;
  if not exists(select 1 from public.bots where id=bb and paired_chat_id=43 and claim_sha256=repeat('e',64)) then raise exception 'Same-owner retry lost pairing'; end if;
  if not public.finish_bot_connection(bb,b,tid,(reservation->>'lease_token')::uuid,repeat('f',64)) then raise exception 'Same-owner finalize failed'; end if;
  perform public.release_bot_connection(tid,(reservation->>'lease_token')::uuid);
  reservation:=jsonb_build_object('lease_token',public.reserve_bot_disconnect(bb,b,tid));
  if not exists(select 1 from public.bots where id=bb and owner_id=b and status='disconnected' and telegram_bot_id is null
    and telegram_token_encrypted is null and nvidia_key_encrypted='new-private-key') then raise exception 'Disconnect altered private key or left binding'; end if;
  if (select count(*) from public.documents where owner_id=b and bot_id=bb)<>1 then raise exception 'Disconnect lost document'; end if;
  if has_function_privilege('authenticated','public.reserve_bot_connection(uuid,uuid,bigint,text,text,text,text,boolean)','EXECUTE')
    or has_function_privilege('anon','public.reserve_bot_disconnect(uuid,uuid,bigint)','EXECUTE')
    or has_table_privilege('authenticated','public.telegram_connection_leases','SELECT') then raise exception 'Browser can access privileged binding operations'; end if;
  if not has_function_privilege('service_role','public.reserve_bot_connection(uuid,uuid,bigint,text,text,text,text,boolean)','EXECUTE') then raise exception 'Server cannot reserve connection'; end if;
  perform set_config('docbot.test_owner_b',b::text,true);
end $$;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('docbot.test_owner_b'),'role','authenticated')::text,true);
do $$ begin
  if exists(select 1 from public.documents where owner_id<>auth.uid()) then raise exception 'RLS exposes another owner document'; end if;
  if (select count(*) from public.documents)<>1 then raise exception 'RLS did not retain current owner document'; end if;
  if exists(select 1 from public.document_chunks where owner_id<>auth.uid()) then raise exception 'RLS exposes another owner chunk'; end if;
end $$;
reset role;
rollback;
select 'reconnect, disconnect, isolation, reservation and RLS checks passed; fixtures rolled back' as result;
