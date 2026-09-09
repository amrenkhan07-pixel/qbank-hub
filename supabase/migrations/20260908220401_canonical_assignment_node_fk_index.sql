-- Covers the composite taxonomy-node foreign key in its declared column order.
create index if not exists canonical_assignment_node_fk_idx
  on public.canonical_question_taxonomy_assignments
    (taxonomy_node_id, taxonomy_version_id);
