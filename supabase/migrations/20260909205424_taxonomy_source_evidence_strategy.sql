-- Refine only the bounded Canonical Taxonomy v1 review sample.
-- Source tests remain source structure: their titles are prior evidence, never taxonomy nodes.

alter table public.canonical_taxonomy_draft_sample
  add column if not exists classification_basis text,
  add column if not exists source_evidence_topic text,
  add column if not exists source_evidence_path text,
  add column if not exists source_evidence_strength numeric,
  add column if not exists source_topic_supported boolean not null default false,
  add column if not exists content_override boolean not null default false,
  add column if not exists classification_level text;

create or replace function public.qbank_taxonomy_classification_dry_run_v2(
  p_version_key text default 'canonical-medical-v1'
) returns table(
  question_id uuid,platform text,source_test text,existing_subject text,is_pyq boolean,
  proposed_system text,proposed_topic text,proposed_subtopic text,proposed_path text,
  classifier_confidence numeric,ambiguity boolean,secondary_concept text,
  cross_subject_ambiguity boolean,reason text,classification_basis text,
  source_evidence_topic text,source_evidence_path text,source_evidence_strength numeric,
  source_topic_supported boolean,content_override boolean,classification_level text
) language sql stable security invoker set search_path=''
as $$
with recursive version_row as (
  select id from public.canonical_taxonomy_versions where version_key=p_version_key and status='draft'
), sample as (
  select s.question_id,s.platform,s.source_test,s.existing_subject,s.is_pyq,s.sample_order,
    q.question_text,q.explanation_html,
    lower(coalesce(s.source_test,'')) ~ '(previous year|grand test|mock|mixed question|rapid revision|comprehensive)' source_is_broad,
    array(select distinct regexp_replace(word,'(es|s)$','','i')
      from unnest(regexp_split_to_array(trim(regexp_replace(lower(coalesce(s.source_test,'')),'[^a-z0-9]+',' ','g')),'\s+')) word
      where length(word)>2 and word not in ('and','the','for','with','part','module','test','questions','question','previous','year','years','pyq','general','introduction')) source_terms
  from public.canonical_taxonomy_draft_sample s
  join version_row v on v.id=s.taxonomy_version_id
  join public.questions q on q.id=s.question_id
), node_terms as (
  select n.id,n.parent_id,n.node_type,n.name,n.metadata,
    array(select distinct regexp_replace(word,'(es|s)$','','i')
      from unnest(regexp_split_to_array(trim(regexp_replace(lower(n.name),'[^a-z0-9]+',' ','g')),'\s+')) word
      where length(word)>2 and word not in ('and','the','for','with','general','system','disease','disorders')) terms
  from public.canonical_taxonomy_nodes n join version_row v on v.id=n.taxonomy_version_id
  where n.node_type in ('topic','subtopic')
), source_node_candidates as (
  select s.question_id,case when n.node_type='topic' then n.id else n.parent_id end topic_id,
    n.name evidence_node,n.node_type,
    overlap_count::numeric/nullif(cardinality(n.terms),0) match_ratio,overlap_count
  from sample s join node_terms n on n.metadata->>'subject'=s.existing_subject
  cross join lateral (
    select count(*)::integer overlap_count from unnest(n.terms) term where term=any(s.source_terms)
  ) overlap
  where not s.source_is_broad and cardinality(n.terms)>0
    and not (cardinality(n.terms)=1 and n.terms[1]=regexp_replace(lower(s.existing_subject),'(es|s)$','','i'))
    and (overlap_count>=2 or (cardinality(n.terms)=1 and overlap_count=1 and length(n.terms[1])>=6))
), source_topic_scores as (
  select c.question_id,c.topic_id,t.name topic_name,t.metadata->>'path' topic_path,
    max(c.match_ratio) strength,max(c.overlap_count) overlap_count,
    string_agg(distinct c.evidence_node,', ' order by c.evidence_node) evidence_nodes
  from source_node_candidates c join public.canonical_taxonomy_nodes t on t.id=c.topic_id
  group by c.question_id,c.topic_id,t.name,t.metadata->>'path'
), source_choices as (
  select st.*,row_number() over(partition by question_id order by strength desc,overlap_count desc,topic_id) choice_rank,
    lead(strength) over(partition by question_id order by strength desc,overlap_count desc,topic_id) second_strength,
    lead(topic_path) over(partition by question_id order by strength desc,overlap_count desc,topic_id) second_path
  from source_topic_scores st
), content_matches as (
  select s.question_id,n.id node_id,n.node_type,n.metadata,
    topic.id topic_id,sum(r.evidence_weight)::numeric score,
    string_agg(distinct r.match_phrase,', ' order by r.match_phrase) phrases
  from sample s cross join version_row v
  join public.canonical_taxonomy_draft_rules r on r.taxonomy_version_id=v.id and r.enabled
  join public.canonical_taxonomy_nodes n on n.id=r.taxonomy_node_id and n.taxonomy_version_id=v.id
  left join public.canonical_taxonomy_nodes topic on topic.taxonomy_version_id=v.id
    and topic.node_type='topic' and topic.metadata->>'subject'=n.metadata->>'subject'
    and topic.name=n.metadata->>'topic'
  where position(r.match_phrase in lower(coalesce(s.question_text,'')||' '||coalesce(s.explanation_html,'')))>0
  group by s.question_id,n.id,n.node_type,n.metadata,topic.id
), content_same_subject as (
  select m.*,row_number() over(partition by m.question_id order by m.score desc,m.node_id) choice_rank,
    sum(m.score) over(partition by m.question_id) total_score,
    lead(m.metadata->>'path') over(partition by m.question_id order by m.score desc,m.node_id) second_path,
    lead(m.score) over(partition by m.question_id order by m.score desc,m.node_id) second_score
  from content_matches m join sample s on s.question_id=m.question_id and s.existing_subject=m.metadata->>'subject'
), foreign_best as (
  select m.question_id,max(m.score) score from content_matches m
  join sample s on s.question_id=m.question_id and s.existing_subject<>m.metadata->>'subject' group by m.question_id
), evidence as (
  select s.*,sc.topic_id source_topic_id,sc.topic_name source_topic,sc.topic_path source_path,
    sc.strength source_strength,sc.second_strength,sc.second_path source_second_path,
    cc.node_id content_node_id,cc.topic_id content_topic_id,cc.node_type content_node_type,
    cc.metadata content_metadata,cc.score content_score,cc.total_score,cc.second_score content_second_score,cc.second_path content_second_path,cc.phrases,
    case when cc.score is null then 0 else round((cc.score/nullif(cc.total_score,0))*(1-exp(-cc.score/3.0)),4) end content_confidence,
    coalesce(f.score>=cc.score*.75,false) cross_subject
  from sample s
  left join source_choices sc on sc.question_id=s.question_id and sc.choice_rank=1
  left join content_same_subject cc on cc.question_id=s.question_id and cc.choice_rank=1
  left join foreign_best f on f.question_id=s.question_id
), decisions as (
  select e.*,
    case
      when source_topic_id is null and content_node_id is null then null
      when source_topic_id is not null and content_node_id is null then source_topic_id
      when source_topic_id is not null and content_topic_id=source_topic_id
        then case when content_node_type='subtopic' and content_score>=6 and coalesce(content_second_score,0)<content_score*.75 then content_node_id else source_topic_id end
      when source_topic_id is not null and content_topic_id<>source_topic_id
        and content_score>=6 and coalesce(content_second_score,0)<content_score*.75 then
          case when content_node_type='subtopic' then content_node_id else content_topic_id end
      when source_topic_id is not null then source_topic_id
      when content_node_type='subtopic' and content_score>=6 and coalesce(content_second_score,0)<content_score*.75 then content_node_id
      else content_topic_id
    end selected_node_id,
    case
      when source_topic_id is null and content_node_id is null then 'unclassifiable'
      when source_topic_id is not null and content_node_id is null then 'source_topic_supported'
      when source_topic_id is not null and content_topic_id=source_topic_id then 'source_topic_supported'
      when source_topic_id is not null and content_topic_id<>source_topic_id
        and content_score>=6 and coalesce(content_second_score,0)<content_score*.75 then 'content_override'
      when source_topic_id is not null and content_topic_id<>source_topic_id then 'ambiguous'
      else 'content_only'
    end basis
  from evidence e
)
select d.question_id,d.platform,d.source_test,d.existing_subject,d.is_pyq,
  selected.metadata->>'system',selected.metadata->>'topic',selected.metadata->>'subtopic',selected.metadata->>'path',
  case
    when d.basis='unclassifiable' then 0
    when d.basis='source_topic_supported' and d.content_node_id is null then round((.55+.25*coalesce(d.source_strength,0))::numeric,4)
    when d.basis='source_topic_supported' then round(greatest(d.content_confidence,.7+.2*coalesce(d.source_strength,0))::numeric,4)
    when d.basis='content_override' then d.content_confidence
    when d.basis='ambiguous' then least(d.content_confidence,.49)
    else d.content_confidence
  end classifier_confidence,
  (d.basis='ambiguous' or coalesce(d.second_strength>=d.source_strength*.9,false)
    or coalesce(d.content_second_score>=d.content_score*.75,false)),
  case when d.basis='content_override' then d.source_path
    when d.basis='ambiguous' then coalesce(d.content_metadata->>'path',d.source_second_path)
    else d.content_second_path end,
  d.cross_subject,
  case
    when d.basis='unclassifiable' then 'No reliable source-topic or content evidence; left unclassifiable.'
    when d.basis='source_topic_supported' and selected.node_type='subtopic' then 'Topic supported by source test title; subtopic inferred from stem.'
    when d.basis='source_topic_supported' then 'Topic supported by source test title; only topic-level evidence, so subtopic is blank.'
    when d.basis='content_override' then 'Question content overrides the source-test topic.'
    when d.basis='ambiguous' then 'Source title and question content suggest different topics; flagged for review.'
    when selected.node_type='subtopic' then 'Source title was broad; topic and subtopic inferred from question content.'
    else 'Only topic-level evidence; subtopic left blank.'
  end,
  d.basis,d.source_topic,d.source_path,round(coalesce(d.source_strength,0)::numeric,4),
  (d.source_topic_id is not null and d.basis='source_topic_supported'),
  (d.basis='content_override'),
  case when selected.node_type='subtopic' then 'subtopic'
    when selected.node_type='topic' then 'topic' else 'unclassifiable' end
from decisions d left join public.canonical_taxonomy_nodes selected on selected.id=d.selected_node_id
order by d.sample_order;
$$;

revoke all on function public.qbank_taxonomy_classification_dry_run_v2(text) from public,anon;
grant execute on function public.qbank_taxonomy_classification_dry_run_v2(text) to authenticated,service_role;
comment on function public.qbank_taxonomy_classification_dry_run_v2(text) is
  'Bounded draft classifier: source module titles are prior topic evidence; question content selects specificity or overrides when strong.';

with version_row as (
  select id from public.canonical_taxonomy_versions where version_key='canonical-medical-v1'
), refreshed as (
  select f.*,n.id proposed_node_id
  from public.qbank_taxonomy_classification_dry_run_v2('canonical-medical-v1') f cross join version_row v
  left join public.canonical_taxonomy_nodes n
    on n.taxonomy_version_id=v.id and n.metadata->>'path'=f.proposed_path
)
update public.canonical_taxonomy_draft_sample sample set
  proposed_node_id=refreshed.proposed_node_id,
  proposed_system=refreshed.proposed_system,
  proposed_topic=refreshed.proposed_topic,
  proposed_subtopic=refreshed.proposed_subtopic,
  proposed_path=refreshed.proposed_path,
  classifier_confidence=refreshed.classifier_confidence,
  ambiguity=refreshed.ambiguity,
  secondary_concept=refreshed.secondary_concept,
  cross_subject_ambiguity=refreshed.cross_subject_ambiguity,
  reason=refreshed.reason,
  classification_basis=refreshed.classification_basis,
  source_evidence_topic=refreshed.source_evidence_topic,
  source_evidence_path=refreshed.source_evidence_path,
  source_evidence_strength=refreshed.source_evidence_strength,
  source_topic_supported=refreshed.source_topic_supported,
  content_override=refreshed.content_override,
  classification_level=refreshed.classification_level,
  generated_at=now(),
  generator_version='canonical-medical-v1-source-evidence-v2'
from refreshed
where sample.question_id=refreshed.question_id
  and sample.taxonomy_version_id=(select id from version_row);

alter table public.canonical_taxonomy_draft_sample
  drop constraint if exists canonical_taxonomy_draft_sample_basis_check,
  add constraint canonical_taxonomy_draft_sample_basis_check
    check (classification_basis in ('source_topic_supported','content_override','content_only','ambiguous','unclassifiable')),
  drop constraint if exists canonical_taxonomy_draft_sample_level_check,
  add constraint canonical_taxonomy_draft_sample_level_check
    check (classification_level in ('topic','subtopic','unclassifiable'));

create or replace function public.qbank_taxonomy_review_page(
  p_version_key text default 'canonical-medical-v1',p_page integer default 1,p_page_size integer default 25,
  p_subject text default null,p_status text default null,p_confidence text default null,
  p_review_state text default null,p_search text default null
) returns jsonb language sql stable security invoker set search_path=''
as $$
with version as (select id from public.canonical_taxonomy_versions where version_key=p_version_key),
base as (
  select s.*,
    case when s.classifier_confidence=0 then 'unclassifiable'
      when s.ambiguity or s.cross_subject_ambiguity then 'ambiguous' else 'classified' end classifier_status,
    case when s.classifier_confidence=0 then 'none' when s.classifier_confidence<.5 then 'low'
      when s.classifier_confidence<.8 then 'medium' else 'high' end confidence_band,
    r.decision review_decision,r.corrected_subject_id,r.corrected_system_id,r.corrected_topic_id,
    r.corrected_subtopic_id,r.secondary_node_id,r.reviewer_note,r.reviewed_at,
    coalesce(csub.metadata->>'path',ctopic.metadata->>'path') corrected_path,
    secondary.metadata->>'path' secondary_path
  from public.canonical_taxonomy_draft_sample s cross join version v
  left join public.canonical_taxonomy_draft_reviews r
    on r.taxonomy_version_id=v.id and r.question_id=s.question_id and r.reviewer_id=(select auth.uid())
  left join public.canonical_taxonomy_nodes csub on csub.id=r.corrected_subtopic_id
  left join public.canonical_taxonomy_nodes ctopic on ctopic.id=r.corrected_topic_id
  left join public.canonical_taxonomy_nodes secondary on secondary.id=r.secondary_node_id
  where s.taxonomy_version_id=v.id
), filtered as (
  select b.* from base b left join public.questions q on q.id=b.question_id
  where (nullif(p_subject,'') is null or b.existing_subject=p_subject)
    and (nullif(p_status,'') is null or b.classifier_status=p_status)
    and (nullif(p_confidence,'') is null or b.confidence_band=p_confidence)
    and (nullif(p_review_state,'') is null
      or (p_review_state='unreviewed' and b.review_decision is null)
      or b.review_decision=p_review_state)
    and (
      nullif(trim(p_search),'') is null
      or b.question_id::text=lower(trim(p_search))
      or (upper(trim(p_search)) ~ '^Q-[0-9A-F]{8}$'
        and b.question_id::text ilike substr(trim(p_search),3)||'%')
      or q.question_text ilike '%'||trim(p_search)||'%'
    )
), paged as (
  select * from filtered order by sample_order
  offset (greatest(p_page,1)-1)*least(greatest(p_page_size,25),50)
  limit least(greatest(p_page_size,25),50)
)
select jsonb_build_object(
  'page',greatest(p_page,1),'page_size',least(greatest(p_page_size,25),50),
  'total',(select count(*) from filtered),'sample_total',(select count(*) from base),
  'reviewed',(select count(*) from base where review_decision is not null),
  'items',coalesce((select jsonb_agg(to_jsonb(p) order by sample_order) from paged p),'[]'::jsonb)
);
$$;

notify pgrst,'reload schema';
