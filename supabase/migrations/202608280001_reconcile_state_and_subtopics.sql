-- Reconcile canonical learner state and backfill source-labeled subtopics.
-- Additive and idempotent: no questions, attempts, bookmarks, or labels are deleted.

select pg_advisory_xact_lock(hashtextextended('qbank:202608280001', 0));

do $$
declare v_problem text;
begin
  with required(table_name, column_name) as (
    values
      ('user_question_state', 'user_id'),
      ('user_question_state', 'question_id'),
      ('user_question_state', 'bookmarked'),
      ('user_question_state', 'revision'),
      ('user_question_state', 'marked_for_review'),
      ('bookmarks', 'user_id'),
      ('bookmarks', 'question_id'),
      ('questions', 'source_subtopic_label'),
      ('questions', 'topic_id'),
      ('question_topics', 'question_id'),
      ('question_topics', 'topic_id'),
      ('subtopics', 'id'),
      ('subtopics', 'topic_id'),
      ('subtopics', 'name'),
      ('question_subtopics', 'question_id'),
      ('question_subtopics', 'subtopic_id')
  )
  select string_agg(format('%I.%I', r.table_name, r.column_name), ', ')
  into v_problem
  from required r
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = r.table_name
   and c.column_name = r.column_name
  where c.column_name is null;

  if v_problem is not null then
    raise exception 'QBank reconciliation stopped; missing live columns: %', v_problem;
  end if;
end $$;

-- user_question_state.bookmarked is canonical. Preserve both historical
-- representations by taking their union, then refresh the bookmarks mirror.
insert into public.user_question_state (user_id, question_id, bookmarked)
select b.user_id, b.question_id, true
from public.bookmarks b
on conflict (user_id, question_id) do update
set bookmarked = true
where not public.user_question_state.bookmarked;

insert into public.bookmarks (user_id, question_id)
select s.user_id, s.question_id
from public.user_question_state s
where s.bookmarked
on conflict (user_id, question_id) do nothing;

-- marked_for_review is canonical. OR preserves the one legacy revision item;
-- revision remains a compatibility mirror for older clients.
update public.user_question_state
set marked_for_review = marked_for_review or revision,
    revision = marked_for_review or revision
where marked_for_review is distinct from revision;

-- Keep canonical bookmark state and the legacy bookmarks table synchronized
-- atomically for the browser client.
create or replace function public.qbank_set_bookmark(
  p_question_id uuid,
  p_bookmarked boolean
)
returns public.user_question_state
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_state public.user_question_state;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  insert into public.user_question_state (user_id, question_id, bookmarked)
  values (auth.uid(), p_question_id, coalesce(p_bookmarked, false))
  on conflict (user_id, question_id) do update
  set bookmarked = excluded.bookmarked
  returning * into v_state;

  if coalesce(p_bookmarked, false) then
    insert into public.bookmarks (user_id, question_id)
    values (auth.uid(), p_question_id)
    on conflict (user_id, question_id) do nothing;
  else
    delete from public.bookmarks
    where user_id = auth.uid() and question_id = p_question_id;
  end if;

  return v_state;
end;
$$;

revoke all on function public.qbank_set_bookmark(uuid, boolean) from public;
grant execute on function public.qbank_set_bookmark(uuid, boolean) to authenticated;

-- Build deterministic (question, effective topic, exact source label) pairs.
-- A child-topic relation is attached to its existing parent topic; the parent
-- relation is added to question_topics so hierarchy invariants remain explicit.
with source_pairs as (
  select distinct
    q.id as question_id,
    coalesce(t.parent_topic_id, t.id) as topic_id,
    btrim(q.source_subtopic_label) as name
  from public.questions q
  cross join lateral (
    select qt.topic_id from public.question_topics qt where qt.question_id = q.id
    union
    select q.topic_id where q.topic_id is not null
  ) relation
  join public.topics t on t.id = relation.topic_id
  where nullif(btrim(q.source_subtopic_label), '') is not null
)
insert into public.question_topics (question_id, topic_id)
select question_id, topic_id from source_pairs
on conflict (question_id, topic_id) do nothing;

with source_pairs as (
  select distinct
    coalesce(t.parent_topic_id, t.id) as topic_id,
    btrim(q.source_subtopic_label) as name
  from public.questions q
  cross join lateral (
    select qt.topic_id from public.question_topics qt where qt.question_id = q.id
    union
    select q.topic_id where q.topic_id is not null
  ) relation
  join public.topics t on t.id = relation.topic_id
  where nullif(btrim(q.source_subtopic_label), '') is not null
), deduplicated as (
  select topic_id, lower(name) as normalized_name, min(name collate "C") as name
  from source_pairs
  group by topic_id, lower(name)
)
insert into public.subtopics (topic_id, name)
select d.topic_id, d.name
from deduplicated d
where not exists (
  select 1 from public.subtopics s
  where s.topic_id = d.topic_id and lower(btrim(s.name)) = d.normalized_name
)
on conflict (topic_id, name) do nothing;

with source_pairs as (
  select distinct
    q.id as question_id,
    coalesce(t.parent_topic_id, t.id) as topic_id,
    btrim(q.source_subtopic_label) as name
  from public.questions q
  cross join lateral (
    select qt.topic_id from public.question_topics qt where qt.question_id = q.id
    union
    select q.topic_id where q.topic_id is not null
  ) relation
  join public.topics t on t.id = relation.topic_id
  where nullif(btrim(q.source_subtopic_label), '') is not null
), resolved as (
  select p.question_id,
         (array_agg(s.id order by (s.name = p.name) desc, s.created_at, s.id))[1] as subtopic_id
  from source_pairs p
  join public.subtopics s
    on s.topic_id = p.topic_id
   and lower(btrim(s.name)) = lower(p.name)
  group by p.question_id, p.topic_id, lower(p.name)
)
insert into public.question_subtopics (question_id, subtopic_id)
select question_id, subtopic_id from resolved
on conflict (question_id, subtopic_id) do nothing;
