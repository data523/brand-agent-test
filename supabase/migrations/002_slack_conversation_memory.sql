create table if not exists public.slack_thread_messages (
  id bigserial primary key,
  workspace_id text not null,
  channel_id text not null,
  thread_ts text not null,
  message_ts text not null,
  user_id text,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, channel_id, message_ts)
);

create index if not exists slack_thread_messages_thread_idx
  on public.slack_thread_messages (workspace_id, channel_id, thread_ts, created_at);

alter table public.slack_thread_messages enable row level security;
-- Server-side access only through SUPABASE_SECRET_KEY. No public RLS policies.
