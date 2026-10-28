-- Firefly webhook processed meetings for idempotency
create table if not exists public.firefly_webhook_processed (
  meeting_id text primary key,
  payload_hash text not null,
  event_type text not null,
  brand_id text,
  processed_at timestamptz not null default now(),
  ingest_result jsonb
);
create index if not exists firefly_webhook_processed_brand_idx
  on public.firefly_webhook_processed (brand_id);
create index if not exists firefly_webhook_processed_processed_idx
  on public.firefly_webhook_processed (processed_at desc);
alter table public.firefly_webhook_processed enable row level security;