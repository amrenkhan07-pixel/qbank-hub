begin;
-- Transactional synthetic learner. All writes, schema and fixtures are rolled back.
insert into auth.users(id) values ('00000000-0000-4000-8000-000000009901');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009901',true);
create temp table checks(name text,passed boolean);
create temp table chosen as select * from public.smart_recall_importance_candidates(array['Medicine'],'All',100);
insert into checks select 'initial HIGH frontier',count(*)>0 and bool_and(global_importance_tier='HIGH') from chosen;
insert into public.test_sessions(id,user_id,mode,status,preset,filters,total_questions,current_position)
values ('00000000-0000-4000-8000-000000009902','00000000-0000-4000-8000-000000009901','recall','in_progress','smart-recall','{"smart_recall":{"exam_focus":"All"}}',3,0);
insert into public.test_session_questions(session_id,question_id,position,question_snapshot)
select '00000000-0000-4000-8000-000000009902',question_ids[1],row_number() over()-1,'{}' from (select * from chosen limit 3) c;
insert into public.test_answers(session_id,question_id,selected_option,is_correct,answered_at,client_event_id)
select session_id,question_id,'A',true,now(),gen_random_uuid() from public.test_session_questions where session_id='00000000-0000-4000-8000-000000009902';
insert into checks select 'successful completion creates coverage',count(*)=3 and bool_and(covered_at is not null) from public.smart_recall_concept_coverage where user_id=auth.uid();
insert into checks select 'D/E before completed A/B/C',not exists(select 1 from public.smart_recall_importance_candidates(array['Medicine'],'All',100) c join public.smart_recall_concept_coverage v using(subject,concept_id) where v.user_id=auth.uid() and v.covered_at is not null);
-- Cover remaining HIGH concepts only.
insert into public.smart_recall_concept_coverage(user_id,subject,concept_id,covered_at)
select auth.uid(),subject,concept_id,now() from public.pyq_concept_importance where subject='Medicine' and global_importance_tier='HIGH' on conflict do nothing;
insert into checks select 'MEDIUM follows covered HIGH',count(*)>0 and bool_and(global_importance_tier='MEDIUM') from public.smart_recall_importance_candidates(array['Medicine'],'All',100);
insert into public.smart_recall_concept_coverage(user_id,subject,concept_id,covered_at)
select auth.uid(),subject,concept_id,now() from public.pyq_concept_importance where subject='Medicine' and global_importance_tier='MEDIUM' on conflict do nothing;
insert into checks select 'LOW follows covered HIGH+MEDIUM',count(*)>0 and bool_and(global_importance_tier='LOW') from public.smart_recall_importance_candidates(array['Medicine'],'All',100);
insert into public.smart_recall_concept_coverage(user_id,subject,concept_id,covered_at)
select auth.uid(),subject,concept_id,now() from public.pyq_concept_importance where subject='Medicine' and global_importance_tier='LOW' on conflict do nothing;
insert into checks select 'full coverage cycles again',count(*)>0 from public.smart_recall_importance_candidates(array['Medicine'],'All',100);
insert into checks select 'exam scope isolated',count(*)>0 and bool_and(global_importance_tier='HIGH') from public.smart_recall_importance_candidates(array['Medicine'],'NEET-PG',100);
-- Explicit source sequence, completed module, and partial-module safety.
create temp table module_fixture as
select t.* from public.qbank_source_tests t join public.platforms p on p.id=t.platform_id join public.subjects sub on sub.id=t.subject_id
where p.name='PrepLadder' and sub.name='Pharmacology' and not coalesce(t.is_pyq,false)
and exists(select 1 from public.qbank_source_tests n where n.platform_id=t.platform_id and n.subject_id=t.subject_id and n.source_path=t.source_path and n.sequence>t.sequence)
order by t.sequence limit 1;
insert into public.test_sessions(id,user_id,mode,status,preset,filters,total_questions,current_position,updated_at)
select '00000000-0000-4000-8000-000000009904',auth.uid(),'practice','completed','qbank',jsonb_build_object('source_tests',jsonb_build_array(id)),declared_question_count,22,now() from module_fixture;
insert into checks select 'partial module never advances',public.qbank_continue_learning() is null;
insert into public.test_answers(session_id,question_id,selected_option,is_correct,answered_at)
select distinct '00000000-0000-4000-8000-000000009904'::uuid,o.question_id,'A',true,now() from public.qbank_source_occurrences o join module_fixture m on m.id=o.source_test_id join public.questions q on q.id=o.question_id where o.is_current and q.is_usable;
insert into checks select 'next module follows source sequence',
(public.qbank_continue_learning()->>'source_test_id')::uuid=(select n.id from module_fixture m join public.qbank_source_tests n on n.platform_id=m.platform_id and n.subject_id=m.subject_id and n.source_path=m.source_path and n.sequence>m.sequence and not coalesce(n.is_pyq,false) order by n.sequence limit 1);
insert into checks select 'saved exact question position',current_position=22 from public.test_sessions where id='00000000-0000-4000-8000-000000009904';
-- RLS: a second learner cannot see the first learner's state.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009903',true);
grant select,insert on checks to authenticated;
set local role authenticated;
insert into checks select 'coverage account isolation',count(*)=0 from public.smart_recall_concept_coverage;
reset role;
select jsonb_agg(to_jsonb(checks)) from checks;

rollback;
