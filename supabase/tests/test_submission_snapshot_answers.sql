begin;
select set_config('request.jwt.claim.sub',(select user_id::text from test_sessions limit 1),true);
set local role authenticated;
do $test$
declare sid uuid:=gen_random_uuid(); ids uuid[]; result public.test_sessions; again public.test_sessions;
begin
 select array_agg(id) into ids from (select id from public.questions where is_usable order by id limit 4) q;
 insert into public.test_sessions(id,user_id,title,mode,status,total_questions) values(sid,auth.uid(),'Rollback-only snapshot scoring','test','in_progress',4);
 insert into public.test_session_questions(session_id,question_id,position,question_snapshot) values
 (sid,ids[1],0,'{"correct_option_keys":["A","C"],"correct_answer":"A,C"}'),
 (sid,ids[2],1,'{"correct_option_keys":["A","C"],"correct_answer":"A,C"}'),
 (sid,ids[3],2,'{"correct_answer":"D. Legacy option"}'),
 (sid,ids[4],3,'{"correct_answer":"B"}');
 insert into public.test_answers(session_id,question_id,selected_option) values(sid,ids[1],'C,A'),(sid,ids[2],'A'),(sid,ids[3],'D');
 result:=public.submit_test_session(sid,false);
 if result.total_correct<>2 or result.incorrect_count<>1 or result.unanswered_count<>1 then raise exception 'score mismatch: %',row_to_json(result); end if;
 again:=public.submit_test_session(sid,false);
 if to_jsonb(again)<>to_jsonb(result) then raise exception 'completed score changed'; end if;
end $test$;
select 'PASS: reordered multi-answer correct; partial rejected; legacy answer correct; unanswered counted; resubmission immutable; fixtures rolled back' result;
rollback;
