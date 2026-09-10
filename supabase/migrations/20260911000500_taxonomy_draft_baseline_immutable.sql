-- Keep the original v2 draft classification snapshot immutable across v3 reruns.
-- This affects review-only evidence; source content, production assignments and
-- learner state are untouched.

create or replace function public.qbank_preserve_taxonomy_draft_baseline()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  if old.evidence_metadata ? 'before_confidence' then
    new.evidence_metadata=old.evidence_metadata;
  end if;
  return new;
end;
$$;

drop trigger if exists canonical_taxonomy_draft_evidence_preserve_baseline
  on public.canonical_taxonomy_draft_evidence;
create trigger canonical_taxonomy_draft_evidence_preserve_baseline
before update on public.canonical_taxonomy_draft_evidence
for each row execute function public.qbank_preserve_taxonomy_draft_baseline();

revoke all on function public.qbank_preserve_taxonomy_draft_baseline() from public,anon,authenticated;
grant execute on function public.qbank_preserve_taxonomy_draft_baseline() to service_role;
