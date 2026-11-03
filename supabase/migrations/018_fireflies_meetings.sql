-- Fireflies meetings storage
create table if not exists public.fireflies_meetings (
  id bigserial primary key,
  meeting_id text not null,
  event_type text not null,
  title text,
  host_email text,
  participants text[],
  transcript_url text,
  summary jsonb,
  duration integer, -- minutes
  started_at timestamptz,
  ended_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (meeting_id, event_type)
);
create index if not exists fireflies_meetings_meeting_idx
  on public.fireflies_meetings (meeting_id);
create index if not exists fireflies_meetings_created_idx
  on public.fireflies_meetings (created_at desc);
alter table public.fireflies_meetings enable row level security;