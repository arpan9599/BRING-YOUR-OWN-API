-- Run once in the SQL editor of a NEW Supabase project. Enable anonymous auth too.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
grant usage on schema extensions to service_role;

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  telegram_bot_id bigint not null unique,
  telegram_username text not null,
  nvidia_key_encrypted text not null,
  telegram_token_encrypted text not null,
  webhook_secret_sha256 text not null,
  pending_webhook_secret_sha256 text,
  claim_sha256 text,
  paired_chat_id bigint,
  status text not null default 'created' check(status in ('created','connected')),
  created_at timestamptz not null default now(),
  unique(id,owner_id)
);
create table public.documents (
  id uuid primary key default gen_random_uuid(), bot_id uuid not null, owner_id uuid not null,
  title text not null check(char_length(title) between 1 and 255),
  file_sha256 text not null check(file_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check(status in ('processing','ready')),
  created_at timestamptz not null default now(),
  unique(id,bot_id,owner_id), unique(bot_id,file_sha256),
  foreign key(bot_id,owner_id) references public.bots(id,owner_id) on delete cascade
);
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(), document_id uuid not null,
  bot_id uuid not null, owner_id uuid not null,
  chunk_index smallint not null check(chunk_index between 0 and 199),
  page integer check(page is null or page > 0),
  content text not null check(char_length(content) between 1 and 1400),
  embedding extensions.vector(2048),
  unique(bot_id,chunk_index),
  foreign key(document_id,bot_id,owner_id) references public.documents(id,bot_id,owner_id) on delete cascade
);
create index chunks_scope on public.document_chunks(bot_id,owner_id);
create index documents_owner on public.documents(owner_id);
create index documents_scope on public.documents(bot_id,owner_id);
create index chunks_owner on public.document_chunks(owner_id);
create index chunks_document on public.document_chunks(document_id,bot_id,owner_id);
create table public.telegram_updates (
  bot_id uuid references public.bots(id) on delete cascade,
  update_id bigint, state text not null default 'working', lease_until timestamptz not null,
  lease_token uuid not null default gen_random_uuid(), payload jsonb, next_part integer not null default 0,
  primary key(bot_id,update_id)
);
create table public.request_limits (
  bot_id uuid references public.bots(id) on delete cascade,
  kind text, minute bigint, count integer not null default 1,
  primary key(bot_id,kind,minute)
);

alter table public.bots enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.request_limits enable row level security;
revoke all on public.bots,public.documents,public.document_chunks,public.telegram_updates,public.request_limits from public,anon,authenticated;
grant all on public.bots,public.documents,public.document_chunks,public.telegram_updates,public.request_limits to service_role;
grant select on public.documents,public.document_chunks to authenticated;
create policy own_documents on public.documents for select to authenticated using(owner_id=(select auth.uid()));
create policy own_chunks on public.document_chunks for select to authenticated using(owner_id=(select auth.uid()));

-- Allocate all chunk slots atomically. Concurrent uploads cannot exceed the cap.
create function public.create_document(p_bot_id uuid,p_owner_id uuid,p_title text,p_hash text,p_chunks jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare doc_id uuid; item jsonb; slot integer; n integer;
begin
  perform 1 from public.bots where id=p_bot_id and owner_id=p_owner_id for update;
  if not found then raise exception 'Workspace not found'; end if;
  select id into doc_id from public.documents where bot_id=p_bot_id and file_sha256=p_hash;
  if doc_id is not null then return doc_id; end if;
  n:=jsonb_array_length(p_chunks);
  if n<1 or n+(select count(*) from public.document_chunks where bot_id=p_bot_id)>200 then raise exception 'Workspace limit: 200 chunks'; end if;
  insert into public.documents(bot_id,owner_id,title,file_sha256) values(p_bot_id,p_owner_id,p_title,p_hash) returning id into doc_id;
  for item in select value from jsonb_array_elements(p_chunks) loop
    select s into slot from generate_series(0,199) s where not exists(select 1 from public.document_chunks c where c.bot_id=p_bot_id and c.chunk_index=s) order by s limit 1;
    insert into public.document_chunks(document_id,bot_id,owner_id,chunk_index,page,content)
    values(doc_id,p_bot_id,p_owner_id,slot,(item->>'page')::integer,item->>'content');
  end loop;
  return doc_id;
end $$;

-- 2048 dimensions exceed ordinary vector-index limits; exact scans are bounded to 200 tenant chunks.
create function public.match_document_chunks(p_bot_id uuid,p_owner_id uuid,query_embedding extensions.vector(2048))
returns table(id uuid,title text,page integer,content text,similarity double precision)
language sql stable security invoker set search_path='' as $$
  with scoped as materialized (
    select c.id,d.title,c.page,c.content,c.embedding from public.document_chunks c
    join public.documents d on d.id=c.document_id and d.bot_id=c.bot_id and d.owner_id=c.owner_id
    where c.bot_id=p_bot_id and c.owner_id=p_owner_id and d.status='ready' and c.embedding is not null
  ) select id,title,page,content,1-(embedding operator(extensions.<=>) query_embedding)
  from scoped where 1-(embedding operator(extensions.<=>) query_embedding)>=0.35
  order by embedding operator(extensions.<=>) query_embedding limit 6;
$$;
create function public.claim_telegram_update(p_bot_id uuid,p_update_id bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.telegram_updates; new_token uuid:=gen_random_uuid();
begin
  insert into public.telegram_updates(bot_id,update_id,lease_until,lease_token) values(p_bot_id,p_update_id,now()+interval '180 seconds',new_token) on conflict do nothing;
  if not found then
    select * into job from public.telegram_updates where bot_id=p_bot_id and update_id=p_update_id for update;
    if job.state='done' then return jsonb_build_object('state','done'); end if;
    if job.lease_until>now() then return jsonb_build_object('state','busy'); end if;
    update public.telegram_updates set lease_until=now()+interval '180 seconds',lease_token=new_token where bot_id=p_bot_id and update_id=p_update_id;
  end if;
  select * into job from public.telegram_updates where bot_id=p_bot_id and update_id=p_update_id;
  return jsonb_build_object('state','claimed','lease_token',job.lease_token,'payload',job.payload,'next_part',job.next_part);
end $$;
create function public.consume_request(p_bot_id uuid,p_kind text,p_limit integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare current_minute bigint:=floor(extract(epoch from now())/60); used integer;
begin
  insert into public.request_limits(bot_id,kind,minute) values(p_bot_id,p_kind,current_minute)
  on conflict(bot_id,kind,minute) do update set count=public.request_limits.count+1 returning count into used;
  delete from public.request_limits where bot_id=p_bot_id and minute<current_minute-5;
  return used<=p_limit;
end $$;
revoke all on function public.create_document(uuid,uuid,text,text,jsonb),public.match_document_chunks(uuid,uuid,extensions.vector),public.claim_telegram_update(uuid,bigint),public.consume_request(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.create_document(uuid,uuid,text,text,jsonb),public.match_document_chunks(uuid,uuid,extensions.vector),public.claim_telegram_update(uuid,bigint),public.consume_request(uuid,text,integer) to service_role;
