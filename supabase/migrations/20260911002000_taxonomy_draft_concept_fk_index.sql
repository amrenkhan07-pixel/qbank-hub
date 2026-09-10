-- Cover the composite draft concept foreign key used by review queries.
create index if not exists canonical_taxonomy_draft_sample_concept_version_idx
  on public.canonical_taxonomy_draft_sample(proposed_concept_id,taxonomy_version_id)
  where proposed_concept_id is not null;
