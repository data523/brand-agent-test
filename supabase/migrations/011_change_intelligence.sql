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
