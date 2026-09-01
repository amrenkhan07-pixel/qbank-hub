-- Canonicalize the Anaesthesia pilot and quarantine source-incomplete questions.
-- Additive and provenance-preserving: no question, option, occurrence, or study row is deleted.

do $migration$
declare
  alias_count integer;
  canonical_id uuid;
  quarantined integer;
  definition text;
begin
  select count(*) into alias_count
  from public.subjects
  where lower(btrim(name)) in ('anaesthesia','anesthesia','anaesthesiology','anesthesiology','anasthesia');

  if alias_count <> 1 then
    raise exception 'expected exactly one Anaesthesia alias subject row, found %', alias_count;
  end if;

  select id into canonical_id from public.subjects
  where lower(btrim(name)) in ('anaesthesia','anesthesia','anaesthesiology','anesthesiology','anasthesia')
  limit 1;

  update public.subjects set name='Anaesthesia' where id=canonical_id;
  update public.platform_subjects
  set native_label='Anaesthesia'
  where subject_id=canonical_id
    and lower(btrim(coalesce(native_label,''))) in ('anaesthesia','anesthesia','anaesthesiology','anesthesiology','anasthesia');

  alter table public.questions add column if not exists is_usable boolean not null default true;
  alter table public.questions add column if not exists unusable_reason text;

  update public.questions q
  set is_usable=false, unusable_reason='SOURCE_CONTENT_INCOMPLETE'
  from public.qbank_source_occurrences o
  join public.qbank_source_tests st on st.id=o.source_test_id
  join public.platforms p on p.id=st.platform_id
  where q.id=o.question_id and o.is_current
    and lower(p.name)='prepladder' and st.subject_id=canonical_id
    and o.source_question_id in ('846800','846703','846768','846764');

  select count(distinct q.id) into quarantined
  from public.questions q
  join public.qbank_source_occurrences o on o.question_id=q.id and o.is_current
  where o.source_question_id in ('846800','846703','846768','846764')
    and q.is_usable=false and q.unusable_reason='SOURCE_CONTENT_INCOMPLETE';
  if quarantined <> 4 then raise exception 'expected four quarantined source questions, found %', quarantined; end if;

  select pg_get_functiondef('public.qbank_commit_prepladder_import(jsonb)'::regprocedure) into definition;
  definition := replace(
    definition,
    'where lower(btrim(s.name)) in (''anaesthesia'',''anesthesia'') order by case when lower(btrim(s.name))=''anesthesia'' then 0 else 1 end limit 1;',
    'where lower(btrim(s.name)) in (''anaesthesia'',''anesthesia'',''anaesthesiology'',''anesthesiology'',''anasthesia'') order by case when lower(btrim(s.name))=''anaesthesia'' then 0 else 1 end limit 1;'
  );
  execute definition;
end
$migration$;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname='questions_unusable_reason_required') then
    alter table public.questions add constraint questions_unusable_reason_required
      check ((is_usable and unusable_reason is null) or (not is_usable and nullif(btrim(unusable_reason),'') is not null));
  end if;
end
$constraints$;

create unique index if not exists subjects_one_anaesthesia_alias
  on public.subjects ((case when lower(btrim(name)) in ('anaesthesia','anesthesia','anaesthesiology','anesthesiology','anasthesia') then true end));

create index if not exists questions_usable_scope_idx
  on public.questions(platform_id,subject_id,id) where is_usable;

comment on column public.questions.is_usable is 'False excludes a preserved source question from all learning populations.';
comment on column public.questions.unusable_reason is 'Stable machine-readable reason for excluding a preserved source question.';
