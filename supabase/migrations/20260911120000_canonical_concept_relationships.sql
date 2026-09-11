-- Controlled, versioned relationships between canonical medical concepts.
-- Additive and review-only: this migration does not touch questions, source
-- occurrences, learner state, production taxonomy assignments, or SRM logic.

create table if not exists public.canonical_concept_relationships(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  from_concept_id uuid not null,
  to_concept_id uuid not null,
  relationship_type text not null check(relationship_type in (
    'same_as','parent_of','child_of','sibling_of','confusable_with','prerequisite_for',
    'complication_of','mechanism_of','diagnosis_of','treatment_of','associated_with',
    'good_transfer_question','good_discriminator','related_but_not_equivalent'
  )),
  provenance_type text not null check(provenance_type in (
    'taxonomy_hierarchy','expert_review','curated_seed','classifier_proposal','manual_override','published_taxonomy'
  )),
  source_reference text not null,
  confidence numeric(4,3) not null check(confidence between 0 and 1),
  review_status text not null default 'draft' check(review_status in ('draft','reviewed','rejected','published','retired')),
  reviewer_id text,
  reviewer_note text,
  reviewed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(from_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict,
  foreign key(to_concept_id,taxonomy_version_id)
    references public.canonical_medical_concepts(id,taxonomy_version_id) on delete restrict,
  unique(taxonomy_version_id,from_concept_id,to_concept_id,relationship_type),
  check(from_concept_id<>to_concept_id),
  check((review_status in ('reviewed','published') and reviewed_at is not null) or review_status not in ('reviewed','published'))
);

comment on table public.canonical_concept_relationships is
  'Reviewable, versioned canonical-concept graph. It is not consumed by production QBank, Test, Analytics, or SRM code.';
comment on column public.canonical_concept_relationships.relationship_type is
  'Typed semantic or learning relationship. child_of input is stored canonically as the inverse parent_of edge.';
comment on column public.canonical_concept_relationships.source_reference is
  'Human-readable provenance reference; never a raw question relationship.';

create index if not exists canonical_concept_relationships_from_idx
  on public.canonical_concept_relationships(from_concept_id,taxonomy_version_id,relationship_type);
create index if not exists canonical_concept_relationships_to_idx
  on public.canonical_concept_relationships(to_concept_id,taxonomy_version_id,relationship_type);
create index if not exists canonical_concept_relationships_review_idx
  on public.canonical_concept_relationships(taxonomy_version_id,review_status,relationship_type);

create or replace function public.qbank_prepare_canonical_concept_relationship()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare swap_id uuid; expected_parent uuid;
begin
  -- Store hierarchy in one direction; the read view exposes child_of.
  if new.relationship_type='child_of' then
    swap_id:=new.from_concept_id;
    new.from_concept_id:=new.to_concept_id;
    new.to_concept_id:=swap_id;
    new.relationship_type:='parent_of';
  end if;

  -- Store symmetric relations once, independent of insertion order.
  if new.relationship_type in (
    'same_as','sibling_of','confusable_with','associated_with',
    'good_discriminator','related_but_not_equivalent'
  ) and new.from_concept_id::text>new.to_concept_id::text then
    swap_id:=new.from_concept_id;
    new.from_concept_id:=new.to_concept_id;
    new.to_concept_id:=swap_id;
  end if;

  if new.from_concept_id=new.to_concept_id then
    raise exception 'A canonical concept cannot relate to itself';
  end if;

  -- Typed hierarchy edges must agree with the existing concept parent link.
  if new.relationship_type='parent_of' then
    select c.parent_concept_id into expected_parent
    from public.canonical_medical_concepts c
    where c.id=new.to_concept_id and c.taxonomy_version_id=new.taxonomy_version_id;
    if expected_parent is distinct from new.from_concept_id then
      raise exception 'parent_of must agree with canonical_medical_concepts.parent_concept_id';
    end if;
  end if;

  if new.review_status in ('reviewed','published') and new.reviewed_at is null then
    new.reviewed_at:=now();
  end if;
  new.updated_at:=now();
  return new;
end $$;

drop trigger if exists qbank_prepare_canonical_concept_relationship_trigger
  on public.canonical_concept_relationships;
create trigger qbank_prepare_canonical_concept_relationship_trigger
before insert or update on public.canonical_concept_relationships
for each row execute function public.qbank_prepare_canonical_concept_relationship();

-- Bidirectional read projection. Directional medical relations remain directed;
-- parent_of gains child_of, while symmetric types are available from either side.
create or replace view public.canonical_concept_relationships_expanded
with (security_invoker=true) as
select id,taxonomy_version_id,from_concept_id,to_concept_id,relationship_type,
  provenance_type,source_reference,confidence,review_status,reviewer_id,reviewer_note,
  reviewed_at,metadata,created_at,updated_at
from public.canonical_concept_relationships
union all
select id,taxonomy_version_id,to_concept_id,from_concept_id,
  case when relationship_type='parent_of' then 'child_of' else relationship_type end,
  provenance_type,source_reference,confidence,review_status,reviewer_id,reviewer_note,
  reviewed_at,metadata,created_at,updated_at
from public.canonical_concept_relationships
where relationship_type in (
  'parent_of','same_as','sibling_of','confusable_with','associated_with',
  'good_discriminator','related_but_not_equivalent'
);

comment on view public.canonical_concept_relationships_expanded is
  'Service-only read projection adding inverse parent/child and symmetric directions without duplicate stored edges.';

alter table public.canonical_concept_relationships enable row level security;
revoke all on table public.canonical_concept_relationships from public,anon,authenticated;
revoke all on table public.canonical_concept_relationships_expanded from public,anon,authenticated;
grant all on table public.canonical_concept_relationships to service_role;
grant select on table public.canonical_concept_relationships_expanded to service_role;

-- Deliberately small, high-confidence seed from the reviewed Pathology vocabulary.
-- Aliases are not looked up or materialized as concepts.
with version as (
  select id from public.canonical_taxonomy_versions
  where version_key='canonical-medical-v1' and status='draft'
), hierarchy_edges(parent_name,child_name) as (
  values
    ('Sickle Cell Disease','Vaso-occlusive crisis'),
    ('Sickle Cell Disease','Acute chest syndrome'),
    ('Sickle Cell Disease','Aplastic crisis'),
    ('Sickle Cell Disease','Splenic sequestration crisis')
)
insert into public.canonical_concept_relationships(
  taxonomy_version_id,from_concept_id,to_concept_id,relationship_type,
  provenance_type,source_reference,confidence,review_status,reviewer_id,reviewer_note,metadata
)
select v.id,parent.id,child.id,'parent_of','taxonomy_hierarchy',
  'Canonical Taxonomy v1 reviewed vocabulary',1.000,'reviewed','taxonomy-v1-review',
  'Mirrors the reviewed canonical concept parent link.',jsonb_build_object('seed_set','canonical-medical-v1-relationships-1')
from version v cross join hierarchy_edges e
join public.canonical_medical_concepts parent
  on parent.taxonomy_version_id=v.id and parent.subject_name='Pathology' and parent.canonical_name=e.parent_name
join public.canonical_medical_concepts child
  on child.taxonomy_version_id=v.id and child.subject_name='Pathology' and child.canonical_name=e.child_name
on conflict(taxonomy_version_id,from_concept_id,to_concept_id,relationship_type) do nothing;

with version as (
  select id from public.canonical_taxonomy_versions
  where version_key='canonical-medical-v1' and status='draft'
), complication_edges(complication_name,disease_name) as (
  values
    ('Vaso-occlusive crisis','Sickle Cell Disease'),
    ('Acute chest syndrome','Sickle Cell Disease'),
    ('Aplastic crisis','Sickle Cell Disease'),
    ('Splenic sequestration crisis','Sickle Cell Disease')
)
insert into public.canonical_concept_relationships(
  taxonomy_version_id,from_concept_id,to_concept_id,relationship_type,
  provenance_type,source_reference,confidence,review_status,reviewer_id,reviewer_note,metadata
)
select v.id,complication.id,disease.id,'complication_of','curated_seed',
  'Canonical Taxonomy v1 reviewed Pathology concepts',0.990,'reviewed','taxonomy-v1-review',
  'High-confidence disease-to-complication relation.',jsonb_build_object('seed_set','canonical-medical-v1-relationships-1')
from version v cross join complication_edges e
join public.canonical_medical_concepts complication
  on complication.taxonomy_version_id=v.id and complication.subject_name='Pathology' and complication.canonical_name=e.complication_name
join public.canonical_medical_concepts disease
  on disease.taxonomy_version_id=v.id and disease.subject_name='Pathology' and disease.canonical_name=e.disease_name
on conflict(taxonomy_version_id,from_concept_id,to_concept_id,relationship_type) do nothing;

with version as (
  select id from public.canonical_taxonomy_versions
  where version_key='canonical-medical-v1' and status='draft'
), relation_seed(from_name,to_name,relation_type,confidence,note) as (
  values
    ('Acute promyelocytic leukemia','Disseminated intravascular coagulation','associated_with',0.990::numeric,'APL has a high-confidence clinical association with DIC.'),
    ('Hereditary spherocytosis','Autoimmune hemolytic anemia','confusable_with',0.950::numeric,'Both may present with spherocytes but have different causes.'),
    ('Hereditary spherocytosis','Autoimmune hemolytic anemia','good_discriminator',0.950::numeric,'The direct antiglobulin test helps discriminate acquired immune hemolysis.'),
    ('Hereditary spherocytosis','Autoimmune hemolytic anemia','related_but_not_equivalent',0.990::numeric,'Related hemolytic-anemia concepts must not be merged.')
)
insert into public.canonical_concept_relationships(
  taxonomy_version_id,from_concept_id,to_concept_id,relationship_type,
  provenance_type,source_reference,confidence,review_status,reviewer_id,reviewer_note,metadata
)
select v.id,source.id,target.id,r.relation_type,'expert_review',
  'Canonical Taxonomy v1 reviewed Pathology concepts',r.confidence,'reviewed','taxonomy-v1-review',r.note,
  jsonb_build_object('seed_set','canonical-medical-v1-relationships-1')
from version v cross join relation_seed r
join public.canonical_medical_concepts source
  on source.taxonomy_version_id=v.id and source.subject_name='Pathology' and source.canonical_name=r.from_name
join public.canonical_medical_concepts target
  on target.taxonomy_version_id=v.id and target.subject_name='Pathology' and target.canonical_name=r.to_name
on conflict(taxonomy_version_id,from_concept_id,to_concept_id,relationship_type) do nothing;
