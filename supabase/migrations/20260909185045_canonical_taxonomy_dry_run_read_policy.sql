-- The dry-run RPC is security-invoker; grant signed-in reviewers read-only
-- access to its transparent rule evidence while keeping all writes service-only.
grant select on table public.canonical_taxonomy_draft_rules to authenticated;
create policy canonical_taxonomy_draft_rules_authenticated_read
on public.canonical_taxonomy_draft_rules
for select to authenticated
using ((select auth.uid()) is not null);
