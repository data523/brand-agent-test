-- Trust and temporal hardening for change intelligence.
alter table public.slack_events
  add column if not exists event_time timestamptz;

-- Backfill historical Slack timestamps when event_ts is the standard Slack epoch string.
update public.slack_events
set event_time = to_timestamp(split_part(event_ts, '.', 1)::double precision)
where event_time is null
  and event_ts ~ '^[0-9]+(\\.[0-9]+)?$';

-- New writes should be indexed by the actual Slack event time, not DB insertion time.
create index if not exists slack_events_brand_event_time_idx
  on public.slack_events (brand_id, event_time desc);

create index if not exists slack_events_brand_event_time_type_idx
  on public.slack_events (brand_id, event_time desc, event_type);

-- Human-readable evidence lookup uses the actual Slack timestamp.
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
  event_time timestamptz,
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
    e.event_time,
    e.created_at,
    case
      when nullif(trim(p_query), '') is null then 0
      else ts_rank_cd(to_tsvector('simple', e.content), websearch_to_tsquery('simple', p_query))
    end::float as lexical_score
  from public.slack_events e
  where e.brand_id = p_brand_id
    and coalesce(e.event_time, e.created_at) >= p_since
    and coalesce(e.event_time, e.created_at) <= p_until
    and (
      nullif(trim(p_query), '') is null
      or to_tsvector('simple', e.content) @@ websearch_to_tsquery('simple', p_query)
    )
  order by coalesce(e.event_time, e.created_at) desc, lexical_score desc
  limit greatest(1, least(p_limit, 100));
$$;
