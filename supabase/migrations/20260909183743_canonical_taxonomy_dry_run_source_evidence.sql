-- Improve the review-only classifier by treating existing source labels as evidence.
-- Source labels are never inserted as taxonomy nodes and no assignments are written.
create or replace function public.qbank_taxonomy_classification_dry_run(p_version_key text default 'canonical-medical-v1',p_limit integer default 380)
returns table(
  question_id uuid,platform text,source_test text,existing_subject text,is_pyq boolean,
  proposed_system text,proposed_topic text,proposed_subtopic text,proposed_path text,
  classifier_confidence numeric,ambiguity boolean,secondary_concept text,
  cross_subject_ambiguity boolean,reason text
) language sql stable security invoker set search_path=''
as $$
with version_row as (
  select id from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft'
), ranked_sample as (
  select q.*,s.name subject_name,p.name platform_name,
    row_number() over(partition by s.id,(q.is_pyq is true) order by md5(q.id::text)) bucket_rank
  from public.questions q join public.subjects s on s.id=q.subject_id join public.platforms p on p.id=q.platform_id
  where q.is_usable is true
), initial_sample as (
  select * from ranked_sample where bucket_rank<=greatest(1,ceil(least(greatest(p_limit,1),500)::numeric/38.0))
), sample as (
  select * from initial_sample order by md5(id::text) limit least(greatest(p_limit,1),500)
), matches as (
  select q.id question_id,n.id node_id,n.metadata,n.metadata->>'subject' canonical_subject,
    sum(r.evidence_weight)::numeric score,string_agg(distinct r.match_phrase,', ' order by r.match_phrase) phrases
  from sample q cross join version_row v
  join public.canonical_taxonomy_draft_rules r on r.taxonomy_version_id=v.id and r.enabled
  join public.canonical_taxonomy_nodes n on n.id=r.taxonomy_node_id and n.taxonomy_version_id=v.id
  where position(r.match_phrase in lower(
    coalesce(q.question_text,'')||' '||coalesce(q.explanation_html,'')||' '
    ||coalesce(q.source_test_label,'')||' '||coalesce(q.source_subtopic_label,'')
  ))>0
  group by q.id,n.id,n.metadata,n.metadata->>'subject'
), same_subject as (
  select m.*,row_number() over(partition by m.question_id order by m.score desc,m.node_id) choice_rank,
    sum(m.score) over(partition by m.question_id) total_score,
    lead(m.metadata->>'path') over(partition by m.question_id order by m.score desc,m.node_id) second_path,
    lead(m.score) over(partition by m.question_id order by m.score desc,m.node_id) second_score
  from matches m join sample q on q.id=m.question_id and q.subject_name=m.canonical_subject
), foreign_best as (
  select m.question_id,max(m.score) score from matches m join sample q on q.id=m.question_id and q.subject_name<>m.canonical_subject group by m.question_id
)
select q.id,q.platform_name,coalesce(q.source_test_label,q.source_reference),q.subject_name,q.is_pyq,
  top.metadata->>'system',top.metadata->>'topic',top.metadata->>'subtopic',top.metadata->>'path',
  case when top.score is null then 0 else round((top.score/nullif(top.total_score,0))*(1-exp(-top.score/3.0)),4) end,
  coalesce(top.second_score>=top.score*0.75,false),top.second_path,
  coalesce(f.score>=top.score*0.75,false),
  case when top.score is null then 'No reviewed rule matched question content or source-label evidence.'
    else 'Matched reviewed phrase evidence: '||top.phrases||'. Question content and source labels are evidence only; labels are never taxonomy nodes. Confidence is evidence dominance and coverage, not clinical certainty.' end
from sample q left join same_subject top on top.question_id=q.id and top.choice_rank=1
left join foreign_best f on f.question_id=q.id
order by q.subject_name,q.is_pyq desc,md5(q.id::text);
$$;

-- Keep the API surface authenticated and read-only.
revoke all on function public.qbank_taxonomy_classification_dry_run(text,integer) from public,anon;
grant execute on function public.qbank_taxonomy_classification_dry_run(text,integer) to authenticated,service_role;
notify pgrst,'reload schema';
