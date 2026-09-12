-- Permit medically reviewed rule stems to match inflected/plural title words
-- (for example vaccine/vaccines, pigment/pigmentary, nutrient/nutrients).
with matched as (
  select p.taxonomy_version_id,p.source_test_id,r.topic_stable_code,r.confidence rule_confidence,r.rationale,
    row_number() over(partition by p.taxonomy_version_id,p.source_test_id order by r.priority,r.confidence desc,r.id) rank
  from public.canonical_source_test_topic_proposals p
  join public.canonical_source_test_topic_rules r on r.taxonomy_version_id=p.taxonomy_version_id
    and r.subject_name=p.existing_subject_name and r.review_status='reviewed'
    and public.qbank_normalize_medical_label(p.evidence_title) ~ regexp_replace(r.title_pattern,'\\m|\\M','','g')
), chosen as (
  select m.*,topic.id topic_id,case when parent.node_type='system' then parent.id end system_id,
    topic.name topic_name,parent.name parent_name
  from matched m join public.canonical_taxonomy_nodes topic
    on topic.taxonomy_version_id=m.taxonomy_version_id and topic.stable_code=m.topic_stable_code and topic.node_type='topic'
  join public.canonical_taxonomy_nodes parent on parent.id=topic.parent_id and parent.taxonomy_version_id=topic.taxonomy_version_id
  where m.rank=1
)
update public.canonical_source_test_topic_proposals p set
  proposed_system_node_id=c.system_id,proposed_topic_node_id=c.topic_id,
  classification_status=case when c.rule_confidence>=.8000 then 'confident' else 'ambiguous' end,
  confidence=c.rule_confidence,ambiguity=c.rule_confidence<.8000,
  classification_basis=case when lower(p.original_title) ~ '(previous year questions|grand test|mock test|mixed questions|rapid revision|comprehensive)' then 'adjacent_source_test_context' else 'source_title' end,
  rationale=c.rationale,
  candidates=jsonb_build_array(jsonb_build_object('topic_id',c.topic_id,'topic',c.topic_name,'system',case when c.system_id is not null then c.parent_name end,'score',c.rule_confidence,'reviewed_rule',true)),
  generator_version='canonical-medical-v1-source-test-v1.2',generated_at=now(),
  metadata=p.metadata||jsonb_build_object('reviewed_rule',true,'rule_topic_code',c.topic_stable_code,'stem_matching',true)
from chosen c where p.taxonomy_version_id=c.taxonomy_version_id and p.source_test_id=c.source_test_id;
