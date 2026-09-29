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
