-- Performance and temporal indexes for change intelligence.
create index if not exists slack_events_brand_created_idx
  on public.slack_events (brand_id, created_at desc, event_type);

create index if not exists slack_events_brand_user_created_idx
  on public.slack_events (brand_id, user_id, created_at desc);

-- Partial index keeps current knowledge retrieval focused on active evidence.
create index if not exists brand_chunks_current_entity_idx
  on public.brand_chunks (brand_id, entity_name, knowledge_scope)
  where is_superseded = false;
