-- Semantic metadata and hard retrieval boundaries.
alter table public.brand_chunks
  add column if not exists knowledge_scope text not null default 'unknown',
  add column if not exists owner text not null default 'unknown',
  add column if not exists entity_name text,
  add column if not exists entity_type text not null default 'unknown',
  add column if not exists source_path text,
  add column if not exists classification_reason text,
  add column if not exists knowledge_domains text[] not null default '{}',
  add column if not exists purpose text not null default 'general',
  add column if not exists authority text not null default 'medium',
  add column if not exists status text not null default 'unknown',
  add column if not exists is_brand_reference boolean not null default false,
  add column if not exists is_current_candidate boolean not null default true,
  add column if not exists brands text[] not null default '{}',
  add column if not exists projects text[] not null default '{}',
  add column if not exists campaigns text[] not null default '{}',
  add column if not exists products text[] not null default '{}',
  add column if not exists topics text[] not null default '{}',
  add column if not exists summary text not null default '',
  add column if not exists effective_date date,
  add column if not exists supersedes text[] not null default '{}',
  add column if not exists classification_confidence double precision not null default 0.05;

create index if not exists brand_chunks_scope_idx on public.brand_chunks (brand_id, knowledge_scope);
create index if not exists brand_chunks_entity_idx on public.brand_chunks (brand_id, entity_name);
create index if not exists brand_chunks_scope_entity_idx on public.brand_chunks (brand_id, knowledge_scope, entity_name);
create index if not exists brand_chunks_authority_idx on public.brand_chunks (brand_id, authority, status);
create index if not exists brand_chunks_reference_idx on public.brand_chunks (brand_id, is_brand_reference);
create index if not exists brand_chunks_domains_idx on public.brand_chunks using gin (knowledge_domains);
create index if not exists brand_chunks_topics_idx on public.brand_chunks using gin (topics);

create or replace function public.match_brand_chunks(
  p_brand_id text,
  p_query_embedding vector(1536),
  p_match_count integer default 8,
  p_document_types text[] default null,
  p_excluded_document_types text[] default null,
  p_preferred_domains text[] default null,
  p_knowledge_scope text default 'unknown',
  p_entity_name text default null,
  p_require_official boolean default false,
  p_require_current boolean default false
)
returns table (
  id bigint,
  brand_id text,
  title text,
  source text,
  document_type text,
  source_date date,
  content text,
  similarity float,
  knowledge_scope text,
  owner text,
  entity_name text,
  entity_type text,
  authority text,
  status text,
  purpose text,
  knowledge_domains text[],
  is_brand_reference boolean,
  summary text
)
language sql stable as $$
  select
    bc.id,
    bc.brand_id,
    bc.title,
    bc.source,
    bc.document_type,
    bc.source_date,
    bc.content,
    (
      (1 - (bc.embedding <=> p_query_embedding))
      + case bc.authority when 'very_high' then 0.10 when 'high' then 0.06 when 'medium' then 0.02 else 0 end
      + case when p_require_official and bc.is_brand_reference then 0.10 else 0 end
      + case when p_require_current and bc.is_current_candidate then 0.05 else 0 end
      + case when p_preferred_domains is not null and bc.knowledge_domains && p_preferred_domains then 0.08 else 0 end
    )::float as similarity,
    bc.knowledge_scope,
    bc.owner,
    bc.entity_name,
    bc.entity_type,
    bc.authority,
    bc.status,
    bc.purpose,
    bc.knowledge_domains,
    bc.is_brand_reference,
    bc.summary
  from public.brand_chunks bc
  where bc.brand_id = p_brand_id
    and (p_document_types is null or bc.document_type = any(p_document_types))
    and (p_excluded_document_types is null or not (bc.document_type = any(p_excluded_document_types)))
    and (p_knowledge_scope = 'unknown' or bc.knowledge_scope = p_knowledge_scope)
    and (
      p_entity_name is null
      or lower(coalesce(bc.entity_name, '')) = lower(p_entity_name)
      or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.brands, '{}')) x)
      or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.projects, '{}')) x)
      or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.campaigns, '{}')) x)
    )
    and (not p_require_official or bc.is_brand_reference)
    and (not p_require_current or bc.is_current_candidate)
  order by similarity desc
  limit p_match_count;
$$;

-- Existing rows stay 'unknown' until they are re-ingested with source evidence.
