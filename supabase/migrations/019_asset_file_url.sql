-- Store the Dropbox (or other) direct-download link per inventory asset (logos, elements, fonts).
-- asset_kind: 'logo' | 'brand_element' | 'font' — mirrors classifyFile() kinds.
alter table public.ingestion_manifest
  add column if not exists file_url text,
  add column if not exists asset_kind text;

create index if not exists ingestion_manifest_asset_idx
  on public.ingestion_manifest (brand_id, asset_kind)
  where file_url is not null;
