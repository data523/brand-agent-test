-- Optional per-brand access control for Slack/agent requests.
create table if not exists public.brand_access (
  id bigserial primary key,
  brand_id text not null,
  slack_user_id text not null,
  role text not null default 'member',
  allowed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (brand_id, slack_user_id)
);

create index if not exists brand_access_brand_user_idx
  on public.brand_access (brand_id, slack_user_id, allowed);

alter table public.brand_access enable row level security;

create or replace function public.has_brand_access(
  p_brand_id text,
  p_slack_user_id text
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.brand_access
    where brand_id = p_brand_id
      and slack_user_id = p_slack_user_id
      and allowed = true
  );
$$;

-- Candidate conflicts are intentionally review candidates, not automatic truth decisions.
-- A conflict candidate means multiple current authoritative sources cover the same entity/domain
-- and should be inspected when their claims disagree.
create or replace function public.find_brand_conflict_candidates(
  p_brand_id text,
  p_limit integer default 50
)
returns table (
  entity_name text,
  knowledge_domain text,
  source_a_title text,
  source_a_path text,
  source_a_status text,
  source_b_title text,
  source_b_path text,
  source_b_status text
)
language sql
stable
as $$
  with current_rows as (
    select
      id,
      entity_name,
      unnest(coalesce(knowledge_domains, '{}'::text[])) as knowledge_domain,
      title,
      source_path,
      status
    from public.brand_chunks
    where brand_id = p_brand_id
      and not is_superseded
      and status in ('approved','current')
      and entity_name is not null
  )
  select
    a.entity_name,
    a.knowledge_domain,
    a.title,
    a.source_path,
    a.status,
    b.title,
    b.source_path,
    b.status
  from current_rows a
  join current_rows b
    on a.entity_name = b.entity_name
   and a.knowledge_domain = b.knowledge_domain
   and a.id < b.id
   and coalesce(a.source_path,'') <> coalesce(b.source_path,'')
  order by a.entity_name, a.knowledge_domain, a.id, b.id
  limit greatest(1, least(p_limit, 200));
$$;
