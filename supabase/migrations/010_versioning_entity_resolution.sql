-- Versioning and canonical entity resolution.
alter table public.brand_chunks
  add column if not exists document_key text not null default '',
  add column if not exists is_superseded boolean not null default false,
  add column if not exists entity_aliases text[] not null default '{}';

create index if not exists brand_chunks_document_key_idx on public.brand_chunks (brand_id, document_key, is_superseded);
create index if not exists brand_chunks_entity_aliases_idx on public.brand_chunks using gin (entity_aliases);

update public.brand_chunks
set document_key = lower(regexp_replace(coalesce(nullif(trim(source_path), ''), title, source), '\s+', ' ', 'g'))
where document_key = '';

with latest_sources as (
  select distinct on (brand_id, document_key)
    brand_id, document_key, source
  from public.brand_chunks
  where document_key <> ''
  order by brand_id, document_key, source_date desc nulls last, id desc
)
update public.brand_chunks bc
set is_superseded = true,
    is_current_candidate = false
where bc.document_key <> ''
  and exists (
    select 1 from latest_sources ls
    where ls.brand_id = bc.brand_id
      and ls.document_key = bc.document_key
      and ls.source <> bc.source
  );

drop function if exists public.match_brand_chunks(text, vector, text, integer, text[], text[], text[], text, text, boolean, boolean, text[]);

create or replace function public.match_brand_chunks(
  p_brand_id text, p_query_embedding vector(1536), p_query_text text default '',
  p_match_count integer default 8, p_document_types text[] default null,
  p_excluded_document_types text[] default null, p_preferred_domains text[] default null,
  p_knowledge_scope text default 'unknown', p_entity_name text default null,
  p_require_official boolean default false, p_require_current boolean default false,
  p_knowledge_scopes text[] default null,
  p_include_superseded boolean default false
)
returns table (
  id bigint, brand_id text, title text, source text, document_type text, source_date date,
  content text, similarity float, knowledge_scope text, owner text, entity_name text,
  entity_type text, authority text, status text, purpose text, knowledge_domains text[],
  is_brand_reference boolean, summary text, source_path text, source_location text,
  lexical_score float, visual_summary text, visual_elements text[], visual_colors text[],
  visual_typography text[], visual_layout text[], visual_composition text[], visual_hierarchy text[],
  visual_spacing text[], visual_logo_placement text[], visual_text_alignment text[],
  visual_confidence float, visual_pages jsonb, document_key text, is_superseded boolean,
  entity_aliases text[]
)
language sql stable as $$
  with candidates as (
    select bc.*, 1 - (bc.embedding <=> p_query_embedding) as semantic_score,
      case when nullif(trim(p_query_text),'') is null then 0
      else ts_rank_cd(bc.search_document, websearch_to_tsquery('simple', p_query_text)) end as lexical_score
    from public.brand_chunks bc
    where bc.brand_id=p_brand_id
      and (p_include_superseded or not bc.is_superseded)
      and (p_document_types is null or bc.document_type=any(p_document_types))
      and (p_excluded_document_types is null or not (bc.document_type=any(p_excluded_document_types)))
      and (((p_knowledge_scopes is not null and cardinality(p_knowledge_scopes)>0) and bc.knowledge_scope=any(p_knowledge_scopes))
        or ((p_knowledge_scopes is null or cardinality(p_knowledge_scopes)=0) and (p_knowledge_scope='unknown' or bc.knowledge_scope=p_knowledge_scope)))
      and (p_entity_name is null
        or lower(coalesce(bc.entity_name,''))=lower(p_entity_name)
        or lower(p_entity_name)=any(select lower(x) from unnest(coalesce(bc.entity_aliases,'{}')) x)
        or lower(p_entity_name)=any(select lower(x) from unnest(coalesce(bc.brands,'{}')) x)
        or lower(p_entity_name)=any(select lower(x) from unnest(coalesce(bc.projects,'{}')) x)
        or lower(p_entity_name)=any(select lower(x) from unnest(coalesce(bc.campaigns,'{}')) x)
        or lower(p_entity_name)=any(select lower(x) from unnest(coalesce(bc.products,'{}')) x))
      and (not p_require_official or bc.is_brand_reference)
      and (not p_require_current or (bc.is_current_candidate and bc.status in ('approved','current')))
  )
  select c.id,c.brand_id,c.title,c.source,c.document_type,c.source_date,c.content,
    ((c.semantic_score*.72)+(least(c.lexical_score,1)*.28)
      +case c.authority when 'very_high' then .10 when 'high' then .06 when 'medium' then .02 else 0 end
      +case when p_require_official and c.is_brand_reference then .10 else 0 end
      +case when p_require_current and c.is_current_candidate then .05 else 0 end
      +case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then .08 else 0 end)::float,
    c.knowledge_scope,c.owner,c.entity_name,c.entity_type,c.authority,c.status,c.purpose,
    c.knowledge_domains,c.is_brand_reference,c.summary,c.source_path,c.source_location,c.lexical_score,
    c.visual_summary,c.visual_elements,c.visual_colors,c.visual_typography,c.visual_layout,c.visual_composition,
    c.visual_hierarchy,c.visual_spacing,c.visual_logo_placement,c.visual_text_alignment,c.visual_confidence,c.visual_pages,
    c.document_key,c.is_superseded,c.entity_aliases
  from candidates c order by similarity desc limit p_match_count;
$$;
