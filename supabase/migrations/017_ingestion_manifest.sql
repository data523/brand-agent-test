-- Ingestion manifest for batched processing and idempotency
create table if not exists public.ingestion_manifest (
  id bigserial primary key,
  brand_id text not null,
  source text not null,           -- e.g., 'gdrive:fileId' or 'dropbox:path'
  source_path text,
  file_name text not null,
  mime_type text,
  file_size bigint,
  content_hash text,              -- SHA256 of file content for change detection
  status text not null default 'pending', -- pending, processing, ingested, skipped, failed
  skip_reason text,
  chunks_count integer default 0,
  visual_analyzed boolean default false,
  vision_pages integer default 0,
  vision_assets integer default 0,
  vision_confidence numeric(3,2),
  document_type text,
  knowledge_scope text,
  authority text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, source)
);
create index if not exists ingestion_manifest_brand_status_idx
  on public.ingestion_manifest (brand_id, status);
create index if not exists ingestion_manifest_source_idx
  on public.ingestion_manifest (source);
alter table public.ingestion_manifest enable row level security;