-- Existing installations: run once to increase the workspace allowance.
alter table public.document_chunks drop constraint document_chunks_chunk_index_check;
alter table public.document_chunks add constraint document_chunks_chunk_index_check check(chunk_index between 0 and 499);

create or replace function public.create_document(p_bot_id uuid,p_owner_id uuid,p_title text,p_hash text,p_chunks jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare doc_id uuid; item jsonb; slot integer; n integer;
begin
  perform 1 from public.bots where id=p_bot_id and owner_id=p_owner_id for update;
  if not found then raise exception 'Workspace not found'; end if;
  select id into doc_id from public.documents where bot_id=p_bot_id and file_sha256=p_hash;
  if doc_id is not null then return doc_id; end if;
  n:=jsonb_array_length(p_chunks);
  if n<1 or n+(select count(*) from public.document_chunks where bot_id=p_bot_id)>500 then raise exception 'Workspace limit: 500 chunks'; end if;
  insert into public.documents(bot_id,owner_id,title,file_sha256) values(p_bot_id,p_owner_id,p_title,p_hash) returning id into doc_id;
  for item in select value from jsonb_array_elements(p_chunks) loop
    select s into slot from generate_series(0,499) s where not exists(select 1 from public.document_chunks c where c.bot_id=p_bot_id and c.chunk_index=s) order by s limit 1;
    insert into public.document_chunks(document_id,bot_id,owner_id,chunk_index,page,content)
    values(doc_id,p_bot_id,p_owner_id,slot,(item->>'page')::integer,item->>'content');
  end loop;
  return doc_id;
end $$;

