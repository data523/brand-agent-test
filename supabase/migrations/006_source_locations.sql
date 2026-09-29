alter table public.brand_chunks
  add column if not exists source_location text;

create index if not exists brand_chunks_source_location_idx
  on public.brand_chunks (brand_id, source, source_location);
