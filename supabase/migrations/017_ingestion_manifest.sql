-- One row per source file per brand: what happened the last time we tried to ingest it.
-- Lets us see what was kept, skipped (and why), or failed, and detect unchanged content by hash.
create table if not exists public.ingestion_manifest (
  id bigserial primary key,
  brand_id text not null,
  source text not null,
  source_path text,
  title text,
  mime_type text,
  content_hash text,
  status text not null check (status in ('ingested', 'skipped', 'failed')),
  skip_reason text,
  error text,
  chunk_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  ingested_at timestamptz,
  unique (brand_id, source)
);

create index if not exists ingestion_manifest_brand_status_idx
  on public.ingestion_manifest (brand_id, status, last_attempt_at desc);

create index if not exists ingestion_manifest_hash_idx
  on public.ingestion_manifest (brand_id, content_hash);

alter table public.ingestion_manifest enable row level security;
