-- Keep the bounded pilot's recorded source prior aligned with the finalized
-- reviewed-rule proposal. Only pilot provenance is updated.
update public.canonical_taxonomy_assignment_pilot pilot set
  source_topic_node_id=proposal.proposed_topic_node_id,
  source_topic_confidence=proposal.confidence,
  content_overrode_source_topic=(case when primary_node.node_type='topic' then primary_node.id else primary_node.parent_id end) is distinct from proposal.proposed_topic_node_id,
  evidence_snapshot=pilot.evidence_snapshot||jsonb_build_object(
    'source_topic_status',proposal.classification_status,
    'source_evidence_title',proposal.evidence_title,
    'source_topic_generator',proposal.generator_version
  )
from public.canonical_source_test_topic_proposals proposal,
  public.canonical_taxonomy_nodes primary_node
where proposal.taxonomy_version_id=pilot.taxonomy_version_id
  and proposal.source_test_id=pilot.source_test_id
  and primary_node.id=pilot.primary_taxonomy_node_id
  and primary_node.taxonomy_version_id=pilot.taxonomy_version_id
  and proposal.proposed_topic_node_id is not null
  and (proposal.proposed_topic_node_id is distinct from pilot.source_topic_node_id
    or proposal.confidence is distinct from pilot.source_topic_confidence);
