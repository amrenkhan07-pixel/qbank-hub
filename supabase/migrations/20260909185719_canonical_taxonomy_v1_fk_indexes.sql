-- Cover composite foreign keys in declared column order for delete/update checks.
create index if not exists canonical_taxonomy_relations_from_fk_idx
  on public.canonical_taxonomy_node_relations(from_node_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_relations_to_fk_idx
  on public.canonical_taxonomy_node_relations(to_node_id,taxonomy_version_id);
create index if not exists canonical_global_evidence_node_fk_idx
  on public.canonical_global_evidence(taxonomy_node_id,taxonomy_version_id);
create index if not exists canonical_taxonomy_draft_rules_node_fk_idx
  on public.canonical_taxonomy_draft_rules(taxonomy_node_id,taxonomy_version_id);
