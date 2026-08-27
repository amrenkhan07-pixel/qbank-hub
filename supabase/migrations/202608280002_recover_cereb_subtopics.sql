-- Recover CEREB Anatomy/Anesthesia test labels as subtopic metadata only.
-- Source: CEREB_Anatomy Shimperd.html and CEREB_Anesthesia Shimperd.html.
-- No question or option row may be inserted, deleted, or structurally changed.

select pg_advisory_xact_lock(hashtextextended('qbank:202608280002:cereb-subtopics', 0));

create temp table _qbank_before on commit drop as
select q.id, q.source_test_label, q.source_subtopic_label from public.questions q;

create temp table _qbank_counts_before on commit drop as
select (select count(*) from public.questions) questions,
       (select count(*) from public.question_options) options,
       (select count(distinct id) from public.questions) distinct_question_ids;

create function pg_temp.guard_question_rows() returns trigger language plpgsql as $$
begin
  if tg_op <> 'UPDATE' then raise exception 'CEREB metadata repair forbids question %', tg_op; end if;
  if new.id is distinct from old.id or new.platform_id is distinct from old.platform_id
     or new.subject_id is distinct from old.subject_id or new.topic_id is distinct from old.topic_id
     or new.source_question_id is distinct from old.source_question_id
     or new.question_text is distinct from old.question_text or new.options is distinct from old.options
     or new.correct_answer is distinct from old.correct_answer
     or new.explanation_html is distinct from old.explanation_html
     or new.question_images is distinct from old.question_images
     or new.explanation_images is distinct from old.explanation_images then
    raise exception 'CEREB metadata repair attempted a structural question change for %', old.id;
  end if;
  return new;
end $$;

create function pg_temp.guard_option_rows() returns trigger language plpgsql as $$
begin raise exception 'CEREB metadata repair forbids option %', tg_op; end $$;

create trigger _qbank_guard_questions before insert or update or delete on public.questions
for each row execute function pg_temp.guard_question_rows();
create trigger _qbank_guard_options before insert or update or delete on public.question_options
for each row execute function pg_temp.guard_option_rows();

create temp table _cereb_source_labels (
  subject_name text not null, test_no integer not null, label text not null,
  source_question_count integer not null, primary key (subject_name, test_no)
) on commit drop;

insert into _cereb_source_labels values
  ('Anesthesia',1,'Anesthetic Implication of Concurrent Diseases',19),
  ('Anesthesia',2,'Cardiopulmonary Resuscitation',21),
  ('Anesthesia',3,'Day Care Anesthesia',7),
  ('Anesthesia',4,'Inhalational Anesthetic Agents',25),
  ('Anesthesia',5,'Instruments in Anesthesia',56),
  ('Anesthesia',6,'Intravenous Anesthetic Agents',51),
  ('Anesthesia',7,'Introduction of Anesthesia',12),
  ('Anesthesia',8,'Local Anesthetics',30),
  ('Anesthesia',9,'Miscellaneous',51),
  ('Anesthesia',10,'Monitoring in Anesthesia',22),
  ('Anesthesia',11,'Neuromuscular Blocking Drugs',25),
  ('Anesthesia',12,'Pediatric and Obstetric Anesthesia',19),
  ('Anesthesia',13,'Pre-Anesthesia Evaluation',28),
  ('Anesthesia',14,'Regional Anesthesia',50),
  ('Anatomy',1,'Abdomen & Pelvis',147),
  ('Anatomy',2,'Basic Concept, Tricks and Magic of Anatomy',2),
  ('Anatomy',3,'Brain',65),
  ('Anatomy',4,'Embryology',72),
  ('Anatomy',5,'General Anatomy',26),
  ('Anatomy',6,'Head, Neck and Face',230),
  ('Anatomy',7,'Histology',75),
  ('Anatomy',8,'Lower Limb',72),
  ('Anatomy',9,'Thorax',50),
  ('Anatomy',10,'Upper Limb',43);

create temp table _cereb_resolved on commit drop as
with parsed as (
  select q.id question_id, s.name subject_name,
    case
      when s.name='Anesthesia' and q.source_question_id ~ '^cerebellum-anesthesia-[0-9]+-[0-9]+$'
        then split_part(q.source_question_id,'-',3)::integer
      when s.name='Anatomy' and q.source_question_id ~ '^cereb_anatomy_[0-9]+$' then case
        when split_part(q.source_question_id,'_',3)::integer <=147 then 1
        when split_part(q.source_question_id,'_',3)::integer <=149 then 2
        when split_part(q.source_question_id,'_',3)::integer <=214 then 3
        when split_part(q.source_question_id,'_',3)::integer <=286 then 4
        when split_part(q.source_question_id,'_',3)::integer <=312 then 5
        when split_part(q.source_question_id,'_',3)::integer <=542 then 6
        when split_part(q.source_question_id,'_',3)::integer <=617 then 7
        when split_part(q.source_question_id,'_',3)::integer <=689 then 8
        when split_part(q.source_question_id,'_',3)::integer <=739 then 9
        when split_part(q.source_question_id,'_',3)::integer <=782 then 10 end
    end test_no
  from public.questions q join public.subjects s on s.id=q.subject_id
  where s.name in ('Anatomy','Anesthesia')
)
select p.question_id,p.subject_name,l.test_no,l.label
from parsed p join _cereb_source_labels l using(subject_name,test_no);

do $$ declare v_problem text; begin
  if exists(select 1 from _cereb_resolved group by question_id having count(*)<>1) then
    raise exception 'CEREB metadata repair found a non-deterministic source identifier';
  end if;
  if (select count(*) from _cereb_resolved)<>418 then
    raise exception 'CEREB metadata repair expected 418 existing identifier matches, found %',(select count(*) from _cereb_resolved);
  end if;
  select string_agg(format('%s test %s has %s rows but source has %s',r.subject_name,r.test_no,r.mapped,l.source_question_count),'; ')
  into v_problem from (select subject_name,test_no,count(*) mapped from _cereb_resolved group by subject_name,test_no) r
  join _cereb_source_labels l using(subject_name,test_no) where r.mapped>l.source_question_count;
  if v_problem is not null then raise exception 'CEREB metadata repair invalid source cardinality: %',v_problem; end if;
end $$;

update public.questions q set source_test_label=r.label,source_subtopic_label=r.label,updated_at=now()
from _cereb_resolved r where q.id=r.question_id
and (q.source_test_label is distinct from r.label or q.source_subtopic_label is distinct from r.label);

create temp table _cereb_topics on commit drop as
select r.question_id,r.subject_name,r.test_no,r.label,
  (array_agg(t.id order by t.created_at,t.id))[1] topic_id
from _cereb_resolved r join public.questions q on q.id=r.question_id
join public.platform_subjects ps on ps.subject_id=q.subject_id and ps.platform_id=q.platform_id
join public.topics t on t.platform_subject_id=ps.id
 and lower(regexp_replace(t.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(r.label,'[^[:alnum:]]','','g'))
group by r.question_id,r.subject_name,r.test_no,r.label;

do $$ begin
  if (select count(*) from _cereb_topics)<>(select count(*) from _cereb_resolved) then
    raise exception 'CEREB metadata repair could not resolve one parent topic for every matched question';
  end if;
end $$;

create temp table _cereb_label_topics on commit drop as
select l.subject_name,l.test_no,l.label,t.id topic_id
from _cereb_source_labels l join public.subjects s on s.name=l.subject_name
join public.platform_subjects ps on ps.subject_id=s.id
join public.topics t on t.platform_subject_id=ps.id
and lower(regexp_replace(t.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(l.label,'[^[:alnum:]]','','g'));

do $$ begin
  if (select count(*) from _cereb_label_topics)<>24
     or exists(select 1 from _cereb_label_topics group by subject_name,test_no having count(*)<>1) then
    raise exception 'CEREB metadata repair could not resolve all 24 extracted labels to unique parent topics';
  end if;
end $$;

insert into public.question_topics(question_id,topic_id)
select question_id,topic_id from _cereb_topics on conflict(question_id,topic_id) do nothing;

update public.subtopics st set name=labels.label
from _cereb_label_topics labels
where st.topic_id=labels.topic_id
and lower(regexp_replace(st.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(labels.label,'[^[:alnum:]]','','g'))
and st.name is distinct from labels.label;

insert into public.subtopics(topic_id,name)
select lt.topic_id,lt.label from _cereb_label_topics lt where not exists(
  select 1 from public.subtopics st where st.topic_id=lt.topic_id
  and lower(regexp_replace(st.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(lt.label,'[^[:alnum:]]','','g'))
) on conflict(topic_id,name) do nothing;

insert into public.question_subtopics(question_id,subtopic_id)
select ct.question_id,st.id from _cereb_topics ct join public.subtopics st on st.topic_id=ct.topic_id
and lower(regexp_replace(st.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(ct.label,'[^[:alnum:]]','','g'))
on conflict(question_id,subtopic_id) do nothing;

do $$ declare before_counts _qbank_counts_before%rowtype; begin
  select * into before_counts from _qbank_counts_before;
  if (select count(*) from public.questions)<>before_counts.questions
     or (select count(distinct id) from public.questions)<>before_counts.distinct_question_ids then
    raise exception 'CEREB metadata repair changed question counts or identifiers';
  end if;
  if (select count(*) from public.question_options)<>before_counts.options then
    raise exception 'CEREB metadata repair changed option count';
  end if;
  if exists(select 1 from _qbank_before b join public.questions q using(id)
    where not exists(select 1 from _cereb_resolved r where r.question_id=b.id)
    and (q.source_test_label is distinct from b.source_test_label or q.source_subtopic_label is distinct from b.source_subtopic_label)) then
    raise exception 'CEREB metadata repair touched an unmatched question';
  end if;
  if exists(select 1 from _cereb_topics ct where
    not exists(select 1 from public.question_topics qt where qt.question_id=ct.question_id and qt.topic_id=ct.topic_id)
    or not exists(select 1 from public.question_subtopics qs join public.subtopics st on st.id=qs.subtopic_id
      where qs.question_id=ct.question_id and st.topic_id=ct.topic_id
      and lower(regexp_replace(st.name,'[^[:alnum:]]','','g'))=lower(regexp_replace(ct.label,'[^[:alnum:]]','','g')))) then
    raise exception 'CEREB metadata repair left an invalid topic/subtopic relationship';
  end if;
end $$;

drop trigger _qbank_guard_options on public.question_options;
drop trigger _qbank_guard_questions on public.questions;
