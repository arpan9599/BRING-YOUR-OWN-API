-- Existing installations: retrieve ranked candidates without an uncalibrated score cutoff.
-- Ownership, ready-document filtering and service-only access remain unchanged.
create or replace function public.match_document_chunks(p_bot_id uuid,p_owner_id uuid,query_embedding extensions.vector(2048))
returns table(id uuid,title text,page integer,content text,similarity double precision)
language sql stable security invoker set search_path='' as $$
  with scoped as materialized (
    select c.id,d.title,c.page,c.content,c.embedding from public.document_chunks c
    join public.documents d on d.id=c.document_id and d.bot_id=c.bot_id and d.owner_id=c.owner_id
    where c.bot_id=p_bot_id and c.owner_id=p_owner_id and d.status='ready' and c.embedding is not null
  ) select id,title,page,content,1-(embedding operator(extensions.<=>) query_embedding)
  from scoped
  order by embedding operator(extensions.<=>) query_embedding limit 6;
$$;
revoke all on function public.match_document_chunks(uuid,uuid,extensions.vector) from public,anon,authenticated;
grant execute on function public.match_document_chunks(uuid,uuid,extensions.vector) to service_role;
