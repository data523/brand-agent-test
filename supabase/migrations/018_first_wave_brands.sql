-- First-wave brands, matched by name/alias from the question text (no channel mapping).
-- New brands start as 'onboarding' (known, but answers say "not loaded yet") and are
-- switched to 'active' once their material is ingested and QA has passed.
insert into public.brands (id, name, aliases, dropbox_path, status) values
  ('biergarten', 'BierGarten', array['Bier Garten', 'Biergarten'], 'BierGarten', 'active'),
  ('qp', 'QP', array['Quarter Peter'], 'QP', 'onboarding'),
  ('lllf', 'LLLF', array['LLL', 'Agents of Change', 'Artiste Corner', 'Lecture Series', 'Lecture Series Unplugged', 'Story of Hope'], 'LLLF', 'onboarding'),
  ('blive', 'BLive', array['B Live', 'B-Live'], 'BLive', 'onboarding'),
  ('cornerhouse', 'Corner House', array['CH'], 'Corner House', 'onboarding'),
  ('asc', 'ASC', array[]::text[], 'ASC', 'onboarding'),
  ('se', 'SE', array[]::text[], 'SE', 'onboarding')
on conflict (id) do update
  set name = excluded.name,
      aliases = excluded.aliases,
      dropbox_path = excluded.dropbox_path,
      updated_at = now();
