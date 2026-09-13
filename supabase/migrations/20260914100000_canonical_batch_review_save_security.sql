-- Allow authenticated reviewers to persist draft-only decisions without
-- granting direct access to protected canonical identity tables.
alter function public.qbank_save_canonical_batch_review(
  text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb
) security definer;

revoke all on function public.qbank_save_canonical_batch_review(
  text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb
) from public,anon;
grant execute on function public.qbank_save_canonical_batch_review(
  text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb
) to authenticated;

notify pgrst,'reload schema';
