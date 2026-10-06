-- Brand registry and Slack channel -> brand routing.
-- A Slack channel answers for exactly one brand. Unmapped channels get no brand
-- (the agent refuses politely) instead of guessing a default.
create table if not exists public.brands (
  id text primary key,
  name text not null,
  aliases text[] not null default '{}',
  dropbox_path text,
  status text not null default 'active'
    check (status in ('active', 'onboarding', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brands enable row level security;

create table if not exists public.channel_brands (
  workspace_id text not null,
  channel_id text not null,
  brand_id text not null references public.brands(id) on update cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, channel_id)
);

create index if not exists channel_brands_brand_idx
  on public.channel_brands (brand_id);

alter table public.channel_brands enable row level security;

-- Seed the existing test brand and the Slack channels it has already been used in.
insert into public.brands (id, name, aliases, status)
values ('biergarten', 'BierGarten', array['Bier Garten', 'Biergarten'], 'active')
on conflict (id) do nothing;

insert into public.channel_brands (workspace_id, channel_id, brand_id)
select distinct workspace_id, channel_id, 'biergarten'
from public.slack_events
where brand_id = 'biergarten'
  and workspace_id is not null
  and channel_id is not null
on conflict (workspace_id, channel_id) do nothing;
