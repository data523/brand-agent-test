-- Brand Agent production database bootstrap
-- Apply this once in the Supabase SQL Editor for the Supabase project used by Vercel.
-- Generated from migrations 001 through 014 in order.



-- ============================================================
-- supabase/migrations/001_init.sql
-- ============================================================
create extension if not exists vector;

create table if not exists public.brand_chunks (
  id bigserial primary key,
  brand_id text not null,
  title text not null,
  source text,
  document_type text not null default 'general',
  source_date date,
  chunk_index integer not null default 0,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index if not exists brand_chunks_brand_idx on public.brand_chunks (brand_id);
create index if not exists brand_chunks_type_idx on public.brand_chunks (brand_id, document_type);
create index if not exists brand_chunks_embedding_idx
  on public.brand_chunks using hnsw (embedding vector_cosine_ops);

create or replace function public.match_brand_chunks(
  p_brand_id text,
  p_query_embedding vector(1536),
  p_match_count integer default 8,
  p_document_types text[] default null
)
returns table (
  id bigint,
  brand_id text,
  title text,
  source text,
  document_type text,
  source_date date,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    bc.id,
    bc.brand_id,
    bc.title,
    bc.source,
    bc.document_type,
    bc.source_date,
    bc.content,
    1 - (bc.embedding <=> p_query_embedding) as similarity
  from public.brand_chunks bc
  where bc.brand_id = p_brand_id
    and (p_document_types is null or bc.document_type = any(p_document_types))
  order by bc.embedding <=> p_query_embedding
  limit p_match_count;
$$;

alter table public.brand_chunks enable row level security;
-- This service uses SUPABASE_SERVICE_ROLE_KEY server-side only. No public policies are created.



-- ============================================================
-- supabase/migrations/002_slack_conversation_memory.sql
-- ============================================================
create table if not exists public.slack_thread_messages (
  id bigserial primary key,
  workspace_id text not null,
  channel_id text not null,
  thread_ts text not null,
  message_ts text not null,
  user_id text,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, channel_id, message_ts)
);

create index if not exists slack_thread_messages_thread_idx
  on public.slack_thread_messages (workspace_id, channel_id, thread_ts, created_at);

alter table public.slack_thread_messages enable row level security;
-- Server-side access only through SUPABASE_SECRET_KEY. No public RLS policies.



-- ============================================================
-- supabase/migrations/003_semantic_context.sql
-- ============================================================
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



-- ============================================================
-- supabase/migrations/004_classification_review_queue.sql
-- ============================================================
-- Persistent semantic classification review queue.
create table if not exists public.classification_review_queue (
  id bigint generated by default as identity primary key,
  brand_id text not null,
  source text not null,
  title text not null,
  source_path text,
  knowledge_scope text not null default 'unknown',
  owner text not null default 'unknown',
  entity_name text,
  document_type text not null default 'general',
  classification_confidence double precision not null default 0.05,
  classification_reason text not null default '',
  status text not null default 'pending',
  proposed_metadata jsonb not null default '{}'::jsonb,
  reviewer text,
  review_notes text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (brand_id, source)
);

create index if not exists classification_review_queue_status_idx
  on public.classification_review_queue (brand_id, status, created_at);

create index if not exists classification_review_queue_scope_idx
  on public.classification_review_queue (knowledge_scope, status);

insert into public.classification_review_queue (
  brand_id, source, title, source_path, knowledge_scope, owner, entity_name,
  document_type, classification_confidence, classification_reason, proposed_metadata
)
select
  bc.brand_id,
  bc.source,
  max(bc.title),
  max(bc.source_path),
  max(bc.knowledge_scope),
  max(bc.owner),
  max(bc.entity_name),
  max(bc.document_type),
  min(bc.classification_confidence),
  'Existing indexed content has no reliable semantic classification yet.',
  jsonb_build_object(
    'knowledge_scope', max(bc.knowledge_scope),
    'owner', max(bc.owner),
    'entity_name', max(bc.entity_name),
    'document_type', max(bc.document_type),
    'classification_confidence', min(bc.classification_confidence)
  )
from public.brand_chunks bc
where bc.knowledge_scope = 'unknown'
group by bc.brand_id, bc.source
on conflict (brand_id, source) do nothing;



-- ============================================================
-- supabase/migrations/006_source_locations.sql
-- ============================================================
alter table public.brand_chunks
  add column if not exists source_location text;

create index if not exists brand_chunks_source_location_idx
  on public.brand_chunks (brand_id, source, source_location);



-- ============================================================


-- supabase/migrations/005_hybrid_retrieval.sql
-- ============================================================
-- Hybrid retrieval: exact lexical relevance + semantic similarity.
-- Trigger-maintained text-search column for Supabase/Postgres.
alter table public.brand_chunks
  add column if not exists search_document tsvector;

create or replace function public.refresh_brand_chunk_search_document()
returns trigger
language plpgsql
as $fn$
begin
  new.search_document := to_tsvector(
    'simple',
    coalesce(new.title, '') || ' ' ||
    coalesce(new.entity_name, '') || ' ' ||
    coalesce(new.summary, '') || ' ' ||
    coalesce(array_to_string(new.brands, ' '), '') || ' ' ||
    coalesce(array_to_string(new.projects, ' '), '') || ' ' ||
    coalesce(array_to_string(new.campaigns, ' '), '') || ' ' ||
    coalesce(array_to_string(new.products, ' '), '') || ' ' ||
    coalesce(array_to_string(new.topics, ' '), '') || ' ' ||
    coalesce(new.content, '')
  );
  return new;
end;
$fn$;

drop trigger if exists brand_chunks_search_document_trigger on public.brand_chunks;

create trigger brand_chunks_search_document_trigger
before insert or update of title, entity_name, summary, brands, projects, campaigns, products, topics, content
on public.brand_chunks
for each row
execute function public.refresh_brand_chunk_search_document();

update public.brand_chunks
set search_document = to_tsvector(
  'simple',
  coalesce(title, '') || ' ' ||
  coalesce(entity_name, '') || ' ' ||
  coalesce(summary, '') || ' ' ||
  coalesce(array_to_string(brands, ' '), '') || ' ' ||
  coalesce(array_to_string(projects, ' '), '') || ' ' ||
  coalesce(array_to_string(campaigns, ' '), '') || ' ' ||
  coalesce(array_to_string(products, ' '), '') || ' ' ||
  coalesce(array_to_string(topics, ' '), '') || ' ' ||
  coalesce(content, '')
)
where search_document is null;

create index if not exists brand_chunks_search_document_idx
  on public.brand_chunks using gin (search_document);

drop function if exists public.match_brand_chunks(
  text, vector, integer, text[], text[], text[], text, text, boolean, boolean
);

create or replace function public.match_brand_chunks(
  p_brand_id text,
  p_query_embedding vector(1536),
  p_query_text text default '',
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
  summary text,
  source_path text,
  source_location text,
  lexical_score float
)
language sql stable as $$
  with candidates as (
    select
      bc.*,
      1 - (bc.embedding <=> p_query_embedding) as semantic_score,
      case
        when nullif(trim(p_query_text), '') is null then 0
        else ts_rank_cd(
          bc.search_document,
          websearch_to_tsquery('simple', p_query_text)
        )
      end as lexical_score
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
        or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.products, '{}')) x)
      )
      and (not p_require_official or bc.is_brand_reference)
      and (not p_require_current or (
        bc.is_current_candidate
        and bc.status in ('approved', 'current')
      ))
  )
  select
    c.id,
    c.brand_id,
    c.title,
    c.source,
    c.document_type,
    c.source_date,
    c.content,
    (
      (c.semantic_score * 0.72)
      + (least(c.lexical_score, 1) * 0.28)
      + case c.authority
          when 'very_high' then 0.10
          when 'high' then 0.06
          when 'medium' then 0.02
          else 0
        end
      + case when p_require_official and c.is_brand_reference then 0.10 else 0 end
      + case when p_require_current and c.is_current_candidate then 0.05 else 0 end
      + case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then 0.08 else 0 end
    )::float as similarity,
    c.knowledge_scope,
    c.owner,
    c.entity_name,
    c.entity_type,
    c.authority,
    c.status,
    c.purpose,
    c.knowledge_domains,
    c.is_brand_reference,
    c.summary,
    c.source_path,
    c.source_location,
    c.lexical_score
  from candidates c
  order by similarity desc
  limit p_match_count;
$$;



-- ============================================================
-- supabase/migrations/007_cross_scope_retrieval.sql
-- ============================================================
-- Allow retrieval across multiple scopes only when the query planner explicitly requests it.
drop function if exists public.match_brand_chunks(
  text, vector, text, integer, text[], text[], text[], text, text, boolean, boolean
);

create or replace function public.match_brand_chunks(
  p_brand_id text,
  p_query_embedding vector(1536),
  p_query_text text default '',
  p_match_count integer default 8,
  p_document_types text[] default null,
  p_excluded_document_types text[] default null,
  p_preferred_domains text[] default null,
  p_knowledge_scope text default 'unknown',
  p_entity_name text default null,
  p_require_official boolean default false,
  p_require_current boolean default false,
  p_knowledge_scopes text[] default null
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
  summary text,
  source_path text,
  source_location text,
  lexical_score float
)
language sql stable as $$
  with candidates as (
    select
      bc.*,
      1 - (bc.embedding <=> p_query_embedding) as semantic_score,
      case
        when nullif(trim(p_query_text), '') is null then 0
        else ts_rank_cd(bc.search_document, websearch_to_tsquery('simple', p_query_text))
      end as lexical_score
    from public.brand_chunks bc
    where bc.brand_id = p_brand_id
      and (p_document_types is null or bc.document_type = any(p_document_types))
      and (p_excluded_document_types is null or not (bc.document_type = any(p_excluded_document_types)))
      and (
        (p_knowledge_scopes is not null and cardinality(p_knowledge_scopes) > 0 and bc.knowledge_scope = any(p_knowledge_scopes))
        or
        ((p_knowledge_scopes is null or cardinality(p_knowledge_scopes) = 0) and (p_knowledge_scope = 'unknown' or bc.knowledge_scope = p_knowledge_scope))
      )
      and (
        p_entity_name is null
        or lower(coalesce(bc.entity_name, '')) = lower(p_entity_name)
        or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.brands, '{}')) x)
        or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.projects, '{}')) x)
        or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.campaigns, '{}')) x)
        or lower(p_entity_name) = any(select lower(x) from unnest(coalesce(bc.products, '{}')) x)
      )
      and (not p_require_official or bc.is_brand_reference)
      and (not p_require_current or (bc.is_current_candidate and bc.status in ('approved', 'current')))
  )
  select
    c.id,
    c.brand_id,
    c.title,
    c.source,
    c.document_type,
    c.source_date,
    c.content,
    (
      (c.semantic_score * 0.72)
      + (least(c.lexical_score, 1) * 0.28)
      + case c.authority
          when 'very_high' then 0.10
          when 'high' then 0.06
          when 'medium' then 0.02
          else 0
        end
      + case when p_require_official and c.is_brand_reference then 0.10 else 0 end
      + case when p_require_current and c.is_current_candidate then 0.05 else 0 end
      + case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then 0.08 else 0 end
    )::float as similarity,
    c.knowledge_scope,
    c.owner,
    c.entity_name,
    c.entity_type,
    c.authority,
    c.status,
    c.purpose,
    c.knowledge_domains,
    c.is_brand_reference,
    c.summary,
    c.source_path,
    c.source_location,
    c.lexical_score
  from candidates c
  order by similarity desc
  limit p_match_count;
$$;



-- ============================================================
-- supabase/migrations/008_visual_brand_context.sql
-- ============================================================
-- Visual brand intelligence extracted from images/assets in documents.
alter table public.brand_chunks
  add column if not exists visual_summary text not null default '',
  add column if not exists visual_elements text[] not null default '{}',
  add column if not exists visual_colors text[] not null default '{}',
  add column if not exists visual_typography text[] not null default '{}',
  add column if not exists visual_layout text[] not null default '{}',
  add column if not exists visual_composition text[] not null default '{}',
  add column if not exists visual_hierarchy text[] not null default '{}',
  add column if not exists visual_spacing text[] not null default '{}',
  add column if not exists visual_logo_placement text[] not null default '{}',
  add column if not exists visual_text_alignment text[] not null default '{}',
  add column if not exists visual_confidence double precision not null default 0;

create index if not exists brand_chunks_visual_elements_idx on public.brand_chunks using gin (visual_elements);
create index if not exists brand_chunks_visual_colors_idx on public.brand_chunks using gin (visual_colors);

drop function if exists public.match_brand_chunks(text, vector, text, integer, text[], text[], text[], text, text, boolean, boolean, text[]);

create or replace function public.match_brand_chunks(
  p_brand_id text, p_query_embedding vector(1536), p_query_text text default '',
  p_match_count integer default 8, p_document_types text[] default null,
  p_excluded_document_types text[] default null, p_preferred_domains text[] default null,
  p_knowledge_scope text default 'unknown', p_entity_name text default null,
  p_require_official boolean default false, p_require_current boolean default false,
  p_knowledge_scopes text[] default null
)
returns table (
  id bigint, brand_id text, title text, source text, document_type text, source_date date,
  content text, similarity float, knowledge_scope text, owner text, entity_name text,
  entity_type text, authority text, status text, purpose text, knowledge_domains text[],
  is_brand_reference boolean, summary text, source_path text, source_location text,
  lexical_score float, visual_summary text, visual_elements text[], visual_colors text[],
  visual_typography text[], visual_layout text[], visual_composition text[], visual_hierarchy text[], visual_spacing text[], visual_logo_placement text[], visual_text_alignment text[], visual_confidence float
)
language sql stable as $$
  with candidates as (
    select bc.*, 1 - (bc.embedding <=> p_query_embedding) as semantic_score,
      case when nullif(trim(p_query_text),'') is null then 0
      else ts_rank_cd(bc.search_document, websearch_to_tsquery('simple', p_query_text)) end as lexical_score
    from public.brand_chunks bc
    where bc.brand_id=p_brand_id
      and (p_document_types is null or bc.document_type=any(p_document_types))
      and (p_excluded_document_types is null or not (bc.document_type=any(p_excluded_document_types)))
      and (((p_knowledge_scopes is not null and cardinality(p_knowledge_scopes)>0) and bc.knowledge_scope=any(p_knowledge_scopes))
        or ((p_knowledge_scopes is null or cardinality(p_knowledge_scopes)=0) and (p_knowledge_scope='unknown' or bc.knowledge_scope=p_knowledge_scope)))
      and (p_entity_name is null or lower(coalesce(bc.entity_name,''))=lower(p_entity_name)
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
    c.visual_summary,c.visual_elements,c.visual_colors,c.visual_typography,c.visual_layout,c.visual_composition,c.visual_hierarchy,c.visual_spacing,c.visual_logo_placement,c.visual_text_alignment,c.visual_confidence
  from candidates c
  order by (
    (c.semantic_score * 0.72)
    + (least(c.lexical_score, 1) * 0.28)
    + case c.authority
        when 'very_high' then 0.10
        when 'high' then 0.06
        when 'medium' then 0.02
        else 0
      end
    + case when p_require_official and c.is_brand_reference then 0.10 else 0 end
    + case when p_require_current and c.is_current_candidate then 0.05 else 0 end
    + case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then 0.08 else 0 end
  ) desc
  limit p_match_count;
$$;



-- ============================================================
-- supabase/migrations/009_visual_page_evidence.sql
-- ============================================================
-- Preserve page/slide-level visual evidence so answers can cite exact locations.
alter table public.brand_chunks
  add column if not exists visual_pages jsonb not null default '[]'::jsonb;

drop function if exists public.match_brand_chunks(text, vector, text, integer, text[], text[], text[], text, text, boolean, boolean, text[]);

create or replace function public.match_brand_chunks(
  p_brand_id text, p_query_embedding vector(1536), p_query_text text default '',
  p_match_count integer default 8, p_document_types text[] default null,
  p_excluded_document_types text[] default null, p_preferred_domains text[] default null,
  p_knowledge_scope text default 'unknown', p_entity_name text default null,
  p_require_official boolean default false, p_require_current boolean default false,
  p_knowledge_scopes text[] default null
)
returns table (
  id bigint, brand_id text, title text, source text, document_type text, source_date date,
  content text, similarity float, knowledge_scope text, owner text, entity_name text,
  entity_type text, authority text, status text, purpose text, knowledge_domains text[],
  is_brand_reference boolean, summary text, source_path text, source_location text,
  lexical_score float, visual_summary text, visual_elements text[], visual_colors text[],
  visual_typography text[], visual_layout text[], visual_composition text[], visual_hierarchy text[],
  visual_spacing text[], visual_logo_placement text[], visual_text_alignment text[],
  visual_confidence float, visual_pages jsonb
)
language sql stable as $$
  with candidates as (
    select bc.*, 1 - (bc.embedding <=> p_query_embedding) as semantic_score,
      case when nullif(trim(p_query_text),'') is null then 0
      else ts_rank_cd(bc.search_document, websearch_to_tsquery('simple', p_query_text)) end as lexical_score
    from public.brand_chunks bc
    where bc.brand_id=p_brand_id
      and (p_document_types is null or bc.document_type=any(p_document_types))
      and (p_excluded_document_types is null or not (bc.document_type=any(p_excluded_document_types)))
      and (((p_knowledge_scopes is not null and cardinality(p_knowledge_scopes)>0) and bc.knowledge_scope=any(p_knowledge_scopes))
        or ((p_knowledge_scopes is null or cardinality(p_knowledge_scopes)=0) and (p_knowledge_scope='unknown' or bc.knowledge_scope=p_knowledge_scope)))
      and (p_entity_name is null or lower(coalesce(bc.entity_name,''))=lower(p_entity_name)
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
    c.visual_hierarchy,c.visual_spacing,c.visual_logo_placement,c.visual_text_alignment,c.visual_confidence,c.visual_pages
  from candidates c
  order by (
    (c.semantic_score * 0.72)
    + (least(c.lexical_score, 1) * 0.28)
    + case c.authority
        when 'very_high' then 0.10
        when 'high' then 0.06
        when 'medium' then 0.02
        else 0
      end
    + case when p_require_official and c.is_brand_reference then 0.10 else 0 end
    + case when p_require_current and c.is_current_candidate then 0.05 else 0 end
    + case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then 0.08 else 0 end
  ) desc
  limit p_match_count;
$$;



-- ============================================================
-- supabase/migrations/010_versioning_entity_resolution.sql
-- ============================================================
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
  from candidates c
  order by (
    (c.semantic_score * 0.72)
    + (least(c.lexical_score, 1) * 0.28)
    + case c.authority
        when 'very_high' then 0.10
        when 'high' then 0.06
        when 'medium' then 0.02
        else 0
      end
    + case when p_require_official and c.is_brand_reference then 0.10 else 0 end
    + case when p_require_current and c.is_current_candidate then 0.05 else 0 end
    + case when p_preferred_domains is not null and c.knowledge_domains && p_preferred_domains then 0.08 else 0 end
  ) desc
  limit p_match_count;
$$;



-- ============================================================
-- supabase/migrations/011_change_intelligence.sql
-- ============================================================
-- Change intelligence: retain normalized Slack events so dated updates can be queried as evidence.
create table if not exists public.slack_events (
  id bigserial primary key,
  workspace_id text not null,
  channel_id text not null,
  event_ts text not null,
  thread_ts text,
  user_id text,
  event_type text not null,
  brand_id text,
  content text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, channel_id, event_ts)
);

create index if not exists slack_events_brand_time_idx
  on public.slack_events (brand_id, created_at desc);

create index if not exists slack_events_thread_idx
  on public.slack_events (workspace_id, channel_id, thread_ts, created_at desc);

create index if not exists slack_events_content_search_idx
  on public.slack_events using gin (to_tsvector('simple', content));

alter table public.slack_events enable row level security;

-- Evidence lookup for recent/current client changes.
create or replace function public.search_recent_brand_events(
  p_brand_id text,
  p_since timestamptz,
  p_until timestamptz default now(),
  p_query text default '',
  p_limit integer default 30
)
returns table (
  id bigint,
  brand_id text,
  channel_id text,
  event_ts text,
  thread_ts text,
  user_id text,
  event_type text,
  content text,
  created_at timestamptz,
  lexical_score float
)
language sql
stable
as $$
  select
    e.id,
    e.brand_id,
    e.channel_id,
    e.event_ts,
    e.thread_ts,
    e.user_id,
    e.event_type,
    e.content,
    e.created_at,
    case
      when nullif(trim(p_query), '') is null then 0
      else ts_rank_cd(to_tsvector('simple', e.content), websearch_to_tsquery('simple', p_query))
    end::float as lexical_score
  from public.slack_events e
  where e.brand_id = p_brand_id
    and e.created_at >= p_since
    and e.created_at <= p_until
    and (
      nullif(trim(p_query), '') is null
      or to_tsvector('simple', e.content) @@ websearch_to_tsquery('simple', p_query)
    )
  order by e.created_at desc, lexical_score desc
  limit p_limit;
$$;



-- ============================================================
-- supabase/migrations/012_change_intelligence_indexes.sql
-- ============================================================
-- Performance and temporal indexes for change intelligence.
create index if not exists slack_events_brand_created_idx
  on public.slack_events (brand_id, created_at desc, event_type);

create index if not exists slack_events_brand_user_created_idx
  on public.slack_events (brand_id, user_id, created_at desc);

-- Partial index keeps current knowledge retrieval focused on active evidence.
create index if not exists brand_chunks_current_entity_idx
  on public.brand_chunks (brand_id, entity_name, knowledge_scope)
  where is_superseded = false;



-- ============================================================
-- supabase/migrations/013_trust_and_change_evidence.sql
-- ============================================================
-- Trust and temporal hardening for change intelligence.
alter table public.slack_events
  add column if not exists event_time timestamptz;

-- Backfill historical Slack timestamps when event_ts is the standard Slack epoch string.
update public.slack_events
set event_time = to_timestamp(split_part(event_ts, '.', 1)::double precision)
where event_time is null
  and event_ts ~ '^[0-9]+(\\.[0-9]+)?$';

-- New writes should be indexed by the actual Slack event time, not DB insertion time.
create index if not exists slack_events_brand_event_time_idx
  on public.slack_events (brand_id, event_time desc);

create index if not exists slack_events_brand_event_time_type_idx
  on public.slack_events (brand_id, event_time desc, event_type);

-- Human-readable evidence lookup uses the actual Slack timestamp.
create or replace function public.search_recent_brand_events(
  p_brand_id text,
  p_since timestamptz,
  p_until timestamptz default now(),
  p_query text default '',
  p_limit integer default 30
)
returns table (
  id bigint,
  brand_id text,
  channel_id text,
  event_ts text,
  thread_ts text,
  user_id text,
  event_type text,
  content text,
  event_time timestamptz,
  created_at timestamptz,
  lexical_score float
)
language sql
stable
as $$
  select
    e.id,
    e.brand_id,
    e.channel_id,
    e.event_ts,
    e.thread_ts,
    e.user_id,
    e.event_type,
    e.content,
    e.event_time,
    e.created_at,
    case
      when nullif(trim(p_query), '') is null then 0
      else ts_rank_cd(to_tsvector('simple', e.content), websearch_to_tsquery('simple', p_query))
    end::float as lexical_score
  from public.slack_events e
  where e.brand_id = p_brand_id
    and coalesce(e.event_time, e.created_at) >= p_since
    and coalesce(e.event_time, e.created_at) <= p_until
    and (
      nullif(trim(p_query), '') is null
      or to_tsvector('simple', e.content) @@ websearch_to_tsquery('simple', p_query)
    )
  order by coalesce(e.event_time, e.created_at) desc, lexical_score desc
  limit greatest(1, least(p_limit, 100));
$$;



-- ============================================================
-- supabase/migrations/014_access_and_conflict_review.sql
-- ============================================================
-- Optional per-brand access control for Slack/agent requests.
create table if not exists public.brand_access (
  id bigserial primary key,
  brand_id text not null,
  slack_user_id text not null,
  role text not null default 'member',
  allowed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (brand_id, slack_user_id)
);

create index if not exists brand_access_brand_user_idx
  on public.brand_access (brand_id, slack_user_id, allowed);

alter table public.brand_access enable row level security;

create or replace function public.has_brand_access(
  p_brand_id text,
  p_slack_user_id text
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.brand_access
    where brand_id = p_brand_id
      and slack_user_id = p_slack_user_id
      and allowed = true
  );
$$;

-- Candidate conflicts are intentionally review candidates, not automatic truth decisions.
-- A conflict candidate means multiple current authoritative sources cover the same entity/domain
-- and should be inspected when their claims disagree.
create or replace function public.find_brand_conflict_candidates(
  p_brand_id text,
  p_limit integer default 50
)
returns table (
  entity_name text,
  knowledge_domain text,
  source_a_title text,
  source_a_path text,
  source_a_status text,
  source_b_title text,
  source_b_path text,
  source_b_status text
)
language sql
stable
as $$
  with current_rows as (
    select
      id,
      entity_name,
      unnest(coalesce(knowledge_domains, '{}'::text[])) as knowledge_domain,
      title,
      source_path,
      status
    from public.brand_chunks
    where brand_id = p_brand_id
      and not is_superseded
      and status in ('approved','current')
      and entity_name is not null
  )
  select
    a.entity_name,
    a.knowledge_domain,
    a.title,
    a.source_path,
    a.status,
    b.title,
    b.source_path,
    b.status
  from current_rows a
  join current_rows b
    on a.entity_name = b.entity_name
   and a.knowledge_domain = b.knowledge_domain
   and a.id < b.id
   and coalesce(a.source_path,'') <> coalesce(b.source_path,'')
  order by a.entity_name, a.knowledge_domain, a.id, b.id
  limit greatest(1, least(p_limit, 200));
$$;
