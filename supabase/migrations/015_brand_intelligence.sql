-- Brand Intelligence: durable synthesized understanding of each client brand.
create table if not exists public.brand_intelligence (
  brand_id text primary key,
  profile jsonb not null default '{}'::jsonb,
  source_fingerprint text not null default '',
  generated_at timestamptz not null default now(),
  profile_version integer not null default 1
);
create index if not exists brand_intelligence_generated_idx
  on public.brand_intelligence (generated_at desc);
alter table public.brand_intelligence enable row level security;
