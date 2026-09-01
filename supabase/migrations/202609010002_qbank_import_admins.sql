-- Narrow allow-list for trusted importer Edge Functions.
begin;

create table if not exists public.qbank_import_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.qbank_import_admins enable row level security;
revoke all on public.qbank_import_admins from public, anon, authenticated;
grant select, insert, delete on public.qbank_import_admins to service_role;

commit;
