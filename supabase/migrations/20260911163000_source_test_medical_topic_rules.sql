-- Curated subject-scoped rules for source titles whose abbreviations or disease
-- names are not explicit in the stable Topic labels. Rules are review evidence,
-- not source-test renames and not taxonomy-node creation.

create table if not exists public.canonical_source_test_topic_rules(
  id uuid primary key default gen_random_uuid(),
  taxonomy_version_id uuid not null references public.canonical_taxonomy_versions(id) on delete restrict,
  subject_name text not null,
  title_pattern text not null,
  topic_stable_code text not null,
  priority integer not null default 100,
  confidence numeric(5,4) not null check(confidence between 0 and 1),
  rationale text not null,
  provenance text not null default 'reviewed-medical-source-title-rule-v1',
  review_status text not null default 'reviewed' check(review_status in ('draft','reviewed','rejected','retired')),
  created_at timestamptz not null default now(),
  unique(taxonomy_version_id,subject_name,title_pattern,topic_stable_code)
);

create index if not exists canonical_source_test_rules_match_idx
  on public.canonical_source_test_topic_rules(taxonomy_version_id,subject_name,priority);

with v as (select id from public.canonical_taxonomy_versions where version_key='canonical-medical-v1' and status='draft'),
rules(subject_name,title_pattern,topic_code,priority,confidence,rationale) as (values
  ('Anaesthesia','\m(pac|pre anaesthetic|preoperative assessment)\M','subject.anaesthesia.topic.preanaesthetic-evaluation',10,.9700,'PAC is preanaesthetic evaluation.'),
  ('Anaesthesia','\m(cpcr|cpr|resuscitation|oxygen delivering|ventilator)\M','subject.anaesthesia.topic.respiratory-and-anaesthetic-emergencies',20,.9500,'Resuscitation, oxygen delivery, and ventilation are peri-anaesthetic respiratory/emergency content.'),
  ('Anaesthesia','\m(anaesthesia machine|monitoring)\M','subject.anaesthesia.topic.monitoring-and-safety',20,.9500,'Anaesthesia equipment and monitoring map to monitoring and safety.'),
  ('Anaesthesia','\m(pain management|critical care)\M','subject.anaesthesia.topic.critical-care-and-pain',20,.9700,'Pain and critical care are explicit topic evidence.'),

  ('Anatomy','\m(cerebrum|brainstem|cerebellum|basal ganglia|thalamus|limbic|spinal cord|tracts)\M','subject.anatomy.topic.brain-and-spinal-cord',20,.9600,'Central neuroanatomy structures.'),
  ('Anatomy','\m(blood supply of the brain|circle of willis|dural|meninges|ventricular system)\M','subject.anatomy.topic.meninges-and-cerebral-circulation',10,.9700,'Cerebral circulation, meninges, and CSF anatomy.'),
  ('Anatomy','\m(pharyngeal arches|pouches|clefts|development|embryology|gametogenesis|fertilization)\M','subject.anatomy.topic.embryology',20,.9700,'Developmental anatomy evidence.'),
  ('Anatomy','\m(perineal|ischiorectal|prostate|urethra|pelvis|pelvic|perineum)\M','subject.anatomy.topic.pelvis-and-perineum',20,.9600,'Pelvic and perineal structures.'),
  ('Anatomy','\m(osteology|arthrology|back region)\M','subject.anatomy.topic.general-anatomy',30,.9000,'General osteology, joints, and back-region foundations.'),
  ('Anatomy','\m(upper limb|forearm|hand|brachial plexus)\M','subject.anatomy.topic.upper-limb',15,.9700,'Explicit upper-limb anatomy.'),
  ('Anatomy','\m(lower limb|femoral|sciatic|leg|foot)\M','subject.anatomy.topic.lower-limb',15,.9700,'Explicit lower-limb anatomy.'),
  ('Anatomy','\m(head|neck|skull|face|pharynx|larynx|salivary)\M','subject.anatomy.topic.head-and-neck',40,.9000,'Head and neck regional anatomy.'),

  ('Biochemistry','\m(protein chemistry|hemoglobin|myoglobin|electrophoresis|chromatography)\M','subject.biochemistry.topic.biomolecules-and-enzymes',20,.9300,'Protein structure and analytical biomolecule methods.'),
  ('Biochemistry','\m(pcr|dna|rna|transcription|translation|molecular)\M','subject.biochemistry.topic.molecular-biology',10,.9800,'Molecular biology technique or process.'),

  ('Community Medicine','\m(systematic review|meta analysis|evidence based|study design|bias|confound|epidemiology|screening)\M','subject.community-medicine.topic.epidemiology',10,.9700,'Epidemiologic methods and evidence synthesis.'),
  ('Community Medicine','\m(descriptive statistics|distribution|dispersion|z scores|errors|sampling|hypothesis)\M','subject.community-medicine.topic.biostatistics',10,.9700,'Statistical methods and distributions.'),
  ('Community Medicine','\m(vaccine|immunization|mumps|measles|rubella|pertussis|chicken pox|small pox|diphtheria|dengue|malaria|rabies|plague|tetanus|hiv|aids|rickettsial|ebola|nipah|zika|entomology|nvbdcp)\M','subject.community-medicine.topic.communicable-disease-control',20,.9500,'Communicable disease, immunization, or vector-control evidence.'),
  ('Community Medicine','\m(ncd|npcd|non communicable)\M','subject.community-medicine.topic.noncommunicable-disease',10,.9600,'Explicit NCD program/content.'),
  ('Community Medicine','\m(preventive medicine in obstetrics|pediatrics|geriatrics|maternal|child health)\M','subject.community-medicine.topic.maternal-and-child-health',20,.9000,'Population prevention across maternal/child age groups.'),
  ('Community Medicine','\m(macronutrient|micronutrient|food adulteration|food fortification|nutrition|water|sanitation|environment)\M','subject.community-medicine.topic.nutrition-and-environment',10,.9600,'Nutrition or environmental health evidence.'),
  ('Community Medicine','\m(nacp|national .*program|health planning|health delivery|international health|polio surveillance)\M','subject.community-medicine.topic.health-systems-and-programs',30,.9300,'Health-program or health-system title.'),
  ('Community Medicine','\m(family planning|contraceptive|demography|occupational|social health)\M','subject.community-medicine.topic.occupational-and-social-health',20,.9500,'Family-planning, demographic, occupational, or social-health evidence.'),

  ('Dermatology','\m(glands|pigment|hair|nail)\M','subject.dermatology.topic.pigment-hair-and-nail-disorders',20,.9300,'Appendageal or pigment disorder.'),
  ('Dermatology','\m(papulosquamous|psoriasis|eczema|dermatitis)\M','subject.dermatology.topic.inflammatory-dermatoses',20,.9700,'Inflammatory dermatosis evidence.'),
  ('Dermatology','\m(immunobullous|vesiculobullous|pemphigus|pemphigoid)\M','subject.dermatology.topic.autoimmune-and-bullous-disease',10,.9800,'Autoimmune/bullous disease evidence.'),
  ('Dermatology','\m(std|sti|syphilitic|leprosy)\M','subject.dermatology.topic.sexually-transmitted-infections-and-leprosy',10,.9700,'STI or leprosy evidence.'),

  ('ENT','\m(cholesteatoma|csom|otosclerosis|middle ear|external ear)\M','subject.ent.topic.external-and-middle-ear',10,.9700,'External/middle-ear disease evidence.'),
  ('ENT','\m(meniere|hearing|cochlea|inner ear|audiometry)\M','subject.ent.topic.inner-ear-and-hearing',20,.9600,'Inner-ear/hearing evidence.'),
  ('ENT','\m(vestibular|vertigo)\M','subject.ent.topic.vestibular-disorders',10,.9700,'Vestibular disease evidence.'),
  ('ENT','\m(adenoid|tonsil|pharynx|oral cavity)\M','subject.ent.topic.oral-cavity-and-pharynx',20,.9500,'Pharyngeal/tonsillar evidence.'),

  ('Forensic Medicine','\m(bns|ipc|section|jurisprudence|law|negligence|consent)\M','subject.forensic-medicine.topic.medical-jurisprudence',20,.9500,'Medico-legal statute or jurisprudence evidence.'),

  ('Medicine','\m(pericard|cardiomyopath|valvular|arrhythmia|ischemic|hypertension|heart|aortic)\M','subject.medicine.topic.cardiology',20,.9600,'Cardiovascular disease evidence.'),
  ('Medicine','\m(endocrine|hormone|sexual development|hypogonadism|obesity|appetite|diabetes|adrenal|thyroid)\M','subject.medicine.topic.endocrinology',20,.9500,'Endocrine/metabolic disease evidence.'),
  ('Medicine','\m(pkd|renal|dialysis|nephro|kidney|acid base|abg)\M','subject.medicine.topic.nephrology',20,.9500,'Renal or acid-base medicine evidence.'),
  ('Medicine','\m(anemia|thalassemia|spherocytosis|hematolog|leukemia|lymphoma|ttp)\M','subject.medicine.topic.clinical-hematology',20,.9600,'Clinical hematology evidence.'),
  ('Medicine','\m(neurolog|coma|neuropathy|syringomelia|conus|myasthenia|parkinson|migraine|cranial nerve|intracranial|brain death|seizure|stroke)\M','subject.medicine.topic.neurology',20,.9500,'Neurologic disease or examination evidence.'),
  ('Medicine','\m(dermatomyositis|arthritis|lupus|vasculitis|rheumat)\M','subject.medicine.topic.rheumatology',20,.9500,'Rheumatologic disease evidence.'),
  ('Medicine','\m(hepatitis|nafld|liver|wilson|hemochromatosis|gastro|pancrea)\M','subject.medicine.topic.gastroenterology',20,.9500,'Gastrointestinal/hepatobiliary evidence.'),
  ('Medicine','\m(puo|dengue|nipah|zika|pneumocystis|aspergillosis|aids|covid|infection|tuberculosis)\M','subject.medicine.topic.infectious-disease',20,.9500,'Infectious disease evidence.'),

  ('Microbiology','\m(scientist|stain|microscope|bacterial anatomy|culture media|diagnostic technique|general microbiology)\M','subject.microbiology.topic.general-microbiology-and-immunology',30,.9200,'General microbiology methods or structure.'),
  ('Microbiology','\m(staphylococcus|streptococcus|corynebacter|mycobacter|coli|shigella|salmonella|klebsiella|proteus|yersinia|vibrio|hemophil|bordatella|brucella|pseudomonas|syphilis|chlamydia|ricketts|neisseria|meningococcus|gonococcus|bacter)\M','subject.microbiology.topic.bacteriology',20,.9700,'Named bacterium/bacteriology evidence.'),
  ('Microbiology','\m(parvovir|poxvir|adenovirus|hepatitis virus|myxovirus|picornavir|rhabdovir|arbovir|virus|hiv)\M','subject.microbiology.topic.virology',20,.9700,'Named virus/virology evidence.'),
  ('Microbiology','\m(flagellate|plasmodium|babesia|parasite|helminth|protozo)\M','subject.microbiology.topic.parasitology',20,.9700,'Named parasite/parasitology evidence.'),

  ('Obstetrics & Gynecology','\m(vulval infection|genital tb|pid|vaginitis)\M','subject.obstetrics-gynecology.topic.benign-gynecology-and-pelvic-floor',20,.9300,'Benign/infectious gynecology evidence.'),
  ('Obstetrics & Gynecology','\m(fibroid|polyp|endometriosis|adenomyosis|aub|adnexal)\M','subject.obstetrics-gynecology.topic.benign-gynecology-and-pelvic-floor',10,.9700,'Benign gynecology evidence.'),
  ('Obstetrics & Gynecology','\m(abortion|ectopic|placenta|amniotic fluid|umbilical cord)\M','subject.obstetrics-gynecology.topic.obstetric-complications',20,.9500,'Obstetric complication evidence.'),
  ('Obstetrics & Gynecology','\m(stage.*labour|instrument|operative|cesarean|postpartum)\M','subject.obstetrics-gynecology.topic.operative-and-emergency-obstetrics',20,.9400,'Labor/operative obstetric evidence.'),
  ('Obstetrics & Gynecology','\m(embryology|sexual differentiation|puberty|infertility)\M','subject.obstetrics-gynecology.topic.infertility-and-reproductive-medicine',30,.9000,'Reproductive-development evidence.'),

  ('Ophthalmology','\m(orbit|lid|lacrimal)\M','subject.ophthalmology.topic.ocular-trauma-and-emergencies',30,.8500,'Periocular/orbital structures; broad within current v1 taxonomy.'),
  ('Ophthalmology','\m(uvea|uveitis|sclera)\M','subject.ophthalmology.topic.uveitis-and-sclera',10,.9800,'Uveal/scleral disease evidence.'),
  ('Ophthalmology','\m(optics|astigmatism|accommodation|presbyopia|refraction)\M','subject.ophthalmology.topic.community-ophthalmology',30,.8500,'Optics/refraction uses the closest stable v1 ophthalmology topic pending taxonomy review.'),

  ('Orthopedics','\m(instrument|orthopedic disorder)\M','subject.orthopedics.topic.fracture-principles',50,.7000,'Broad orthopedic-instrument title; closest general trauma topic with reviewer confirmation advisable.'),

  ('Pathology','\m(genetic|mendelian|lysosomal|immunity|amyloid|transplant)\M','subject.pathology.topic.immune-and-genetic-disease',20,.9400,'Genetic/immune systemic pathology evidence.'),
  ('Pathology','\m(rhd|endocarditis|cardiovascular)\M','subject.pathology.topic.cardiovascular-pathology',20,.9500,'Cardiovascular pathology evidence.'),
  ('Pathology','\m(hematology|cml|cll|wbc|myeloid|leukemia|lymphoma)\M','subject.pathology.topic.white-cell-and-lymphoid-disorders',30,.9300,'White-cell/hematolymphoid evidence.'),

  ('Pediatrics','\m(neonat|newborn|perinatal)\M','subject.pediatrics.topic.newborn-medicine',20,.9700,'Neonatal/newborn medicine evidence.'),
  ('Pediatrics','\m(breastmilk|micronutrient|malnutrition|vitamin|nutrition)\M','subject.pediatrics.topic.pediatric-nutrition',20,.9600,'Pediatric nutrition evidence.'),
  ('Pediatrics','\m(puberty|dsd|growth|development|genetic|lysosomal)\M','subject.pediatrics.topic.growth-and-development',30,.9000,'Growth/development/genetic pediatric evidence.'),
  ('Pediatrics','\m(viral|covid|infection|immunization|vaccine)\M','subject.pediatrics.topic.immunization-and-pediatric-infection',20,.9600,'Pediatric infection/immunization evidence.'),
  ('Pediatrics','\m(git|gastro|renal)\M','subject.pediatrics.topic.pediatric-gastrointestinal-and-renal-disease',20,.9500,'Pediatric GI/renal evidence.'),
  ('Pediatrics','\m(hematological malign|leukemia|lymphoma|anemia)\M','subject.pediatrics.topic.pediatric-hematology-and-oncology',20,.9600,'Pediatric hematology/oncology evidence.'),

  ('Pharmacology','\m(sympathomimetic|sympatholytic|cholinergic|adrenergic|autonomic)\M','subject.pharmacology.topic.autonomic-pharmacology',20,.9700,'Autonomic pharmacology evidence.'),
  ('Pharmacology','\m(parkinson|antiepileptic|antidepressant|antipsychotic|opioid|cns)\M','subject.pharmacology.topic.central-nervous-system-drugs',20,.9500,'CNS pharmacology evidence.'),
  ('Pharmacology','\m(beta lactam|antibiotic|antimicrobial|cephalosporin|carbapenem|glycopeptide|fluoroquinolone|antimetabolite)\M','subject.pharmacology.topic.antimicrobial-chemotherapy',20,.9700,'Antimicrobial chemotherapy evidence.'),
  ('Pharmacology','\m(histamine|serotonin|autacoid|monoclonal|targeted therapy|cancer|nsaid|gout)\M','subject.pharmacology.topic.inflammation-immunity-and-cancer-drugs',20,.9400,'Autacoid, immune, inflammatory, or cancer pharmacology evidence.'),
  ('Pharmacology','\m(platelet|thrombolytic|hematinic|iron|chelator|cardiovascular|renal)\M','subject.pharmacology.topic.cardiovascular-and-renal-drugs',30,.9000,'Hematologic/cardiovascular pharmacology evidence.'),

  ('Physiology','\m(respiratory gas|gas exchange|oxygen|carbon dioxide)\M','subject.physiology.topic.gas-exchange-and-control',20,.9700,'Respiratory gas exchange evidence.'),
  ('Physiology','\m(synapse|spinal cord|basal ganglia|cerebellum|ascending|descending tract)\M','subject.physiology.topic.central-nervous-system-physiology',20,.9600,'Central neurophysiology evidence.'),

  ('Psychiatry','\m(psychopathology|thought|perception|cognition|psychological assessment|basics of psychiatry)\M','subject.psychiatry.topic.psychiatric-assessment',20,.9600,'Psychiatric assessment/psychopathology evidence.'),
  ('Psychiatry','\m(depressive|mania|bipolar|mood)\M','subject.psychiatry.topic.mood-disorders',20,.9700,'Mood disorder evidence.'),
  ('Psychiatry','\m(psychology|personality)\M','subject.psychiatry.topic.personality-eating-and-sexual-disorders',40,.8000,'Broad psychology/personality evidence; review advised.'),

  ('Radiology','\m(nephro|renal|kidney)\M','subject.radiology.topic.abdominal-and-pelvic-imaging',20,.9500,'Renal imaging is abdominal imaging.'),

  ('Surgery','\m(cerebrovascular|cns tumor)\M','subject.surgery.topic.trauma-shock-and-burns',80,.7000,'Neurosurgery is not explicit in v1; closest broad surgical emergency topic pending taxonomy review.'),
  ('Surgery','\m(oral cavity|salivary|neck|facial)\M','subject.surgery.topic.upper-gastrointestinal-surgery',80,.6500,'Head-neck surgery is missing from v1; provisional closest surgical region, review required.'),
  ('Surgery','\m(thorax|lung|mediastinum|pleura)\M','subject.surgery.topic.trauma-shock-and-burns',80,.6500,'Thoracic surgery is missing from v1; provisional broad surgical topic, review required.'),
  ('Surgery','\m(gall bladder|liver|portal|spleen|pancrea)\M','subject.surgery.topic.hepatobiliary-and-pancreatic-surgery',20,.9700,'Hepatobiliary/pancreatic surgical evidence.'),
  ('Surgery','\m(peritoneum|large intestine|ileostomy|colostomy|ibd|appendix|small bowel|rectum|anus)\M','subject.surgery.topic.intestinal-and-colorectal-surgery',20,.9600,'Intestinal/colorectal surgical evidence.'),
  ('Surgery','\m(prostate|seminal|testis|scrotum|urology|urinary|renal stone)\M','subject.surgery.topic.urology',20,.9700,'Urologic surgical evidence.'),
  ('Surgery','\m(oncology)\M','subject.surgery.topic.breast-surgery',90,.6000,'Generic surgical oncology is too broad; provisional only and intentionally low confidence.'),
  ('Surgery','\m(tube|catheter|drain|instrument|perioperative)\M','subject.surgery.topic.perioperative-care',30,.9000,'General perioperative devices/procedures.')
)
insert into public.canonical_source_test_topic_rules(
  taxonomy_version_id,subject_name,title_pattern,topic_stable_code,priority,confidence,rationale
)
select v.id,r.subject_name,r.title_pattern,r.topic_code,r.priority,r.confidence,r.rationale from v cross join rules r
on conflict(taxonomy_version_id,subject_name,title_pattern,topic_stable_code) do update set
  priority=excluded.priority,confidence=excluded.confidence,rationale=excluded.rationale,review_status='reviewed';

-- Apply the highest-priority matching reviewed rule. Generic PYQ titles retain
-- their original name but match against their adjacent evidence_title.
with matched as (
  select p.taxonomy_version_id,p.source_test_id,r.topic_stable_code,r.confidence rule_confidence,r.rationale,
    row_number() over(partition by p.taxonomy_version_id,p.source_test_id order by r.priority,r.confidence desc,r.id) rank
  from public.canonical_source_test_topic_proposals p
  join public.canonical_source_test_topic_rules r on r.taxonomy_version_id=p.taxonomy_version_id
    and r.subject_name=p.existing_subject_name and r.review_status='reviewed'
    and public.qbank_normalize_medical_label(p.evidence_title) ~ r.title_pattern
), chosen as (
  select m.*,topic.id topic_id,
    case when parent.node_type='system' then parent.id end system_id,
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
  generator_version='canonical-medical-v1-source-test-v1.1',generated_at=now(),
  metadata=p.metadata||jsonb_build_object('reviewed_rule',true,'rule_topic_code',c.topic_stable_code)
from chosen c where p.taxonomy_version_id=c.taxonomy_version_id and p.source_test_id=c.source_test_id;

-- A clear lexical leader is confident even when a weak generic token produced
-- a nearby runner-up. True ties remain ambiguous.
update public.canonical_source_test_topic_proposals p set
  classification_status='confident',confidence=least(((p.candidates->0->>'score')::numeric),.9900),
  ambiguity=false,generator_version='canonical-medical-v1-source-test-v1.1',generated_at=now()
where p.classification_status='ambiguous'
  and (p.candidates->0->>'score')::numeric>=.8000
  and (p.candidates->0->>'score')::numeric-coalesce((p.candidates->1->>'score')::numeric,0)>=.0200;

alter table public.canonical_source_test_topic_rules enable row level security;
revoke all on table public.canonical_source_test_topic_rules from public,anon,authenticated;
grant all on table public.canonical_source_test_topic_rules to service_role;
notify pgrst,'reload schema';
