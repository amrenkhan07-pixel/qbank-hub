-- Exam focus selects PYQ concepts; ordinary QBank matches need not carry PYQ exam tags.
create or replace function public.gi_similar_questions_v1(p_subject text,p_concept_id text,p_source text default 'QBank',p_status text default 'All',p_exam text default 'All',p_limit integer default 30)
returns table(question_id uuid,platform text,subject text,source_test text,stem text,options jsonb,answer text,explanation text,topic text,subtopic text,bookmarked boolean,incorrect boolean,attempts integer,last_attempted_at timestamptz,rank_score real,shared_key_terms integer,source_kind text)
language sql stable security invoker set search_path=public,pg_catalog as $$
 with concept as (select primary_concept from public.pyq_concept_importance where subject=p_subject and concept_id=p_concept_id),
 terms as (select distinct token from concept,regexp_split_to_table(lower(primary_concept),'[^a-z0-9]+') token where length(token)>2 and token not in ('the','and','with','from','for','identification','recognition','diagnosis','management','clinical','features','treatment','disease','most','common','associated','causes','cause') limit 18),
 query as (select to_tsquery('simple',string_agg(quote_literal(token),' | ')) as tsq from terms),
 candidates as materialized (
 select q.*,ts_rank_cd(public.gi_search_document(q.question_text,q.options,q.explanation_html),query.tsq) as relevance,
 (select count(*)::integer from terms where public.gi_search_document(q.question_text,q.options,q.explanation_html) @@ plainto_tsquery('simple',token)) as shared,
 (coalesce(q.is_pyq,false) or q.source_type='PYQ' or exists(select 1 from public.qbank_source_occurrences o where o.question_id=q.id and o.is_current and o.is_pyq)) as pyq
 from public.questions q cross join query where q.is_usable and not coalesce(q.is_grand_test,false) and public.gi_search_document(q.question_text,q.options,q.explanation_html) @@ query.tsq
 ), scored as (
 select q.id,pl.name as platform,s.name as subject,q.source_test_label,q.question_text,q.options,q.correct_answer,q.explanation_html,t.name as topic,q.source_subtopic_label,
 coalesce(u.bookmarked,false) as bookmarked,coalesce(u.wrong or u.last_is_correct=false,false) as incorrect,coalesce(u.attempts,0) as attempts,u.last_attempted_at,q.shared,q.pyq,
 ((case when s.name=p_subject or (s.name='ENT' and p_subject='Otorhinolaryngology') or (s.name='Anaesthesiology' and p_subject='Anaesthesia') or (s.name='Orthopaedics' and p_subject='Orthopedics') then 40 else 0 end)+q.relevance*10+q.shared*3+case when pl.id is not null then 1 else 0 end+case when u.last_attempted_at is null then 5 when u.last_attempted_at<now()-interval '7 days' then 3 else -3 end+case when u.wrong or u.last_is_correct=false then 4 else 0 end+case when u.bookmarked then 2 else 0 end)::real as score
 from candidates q join public.platforms pl on pl.id=q.platform_id join public.subjects s on s.id=q.subject_id left join public.topics t on t.id=q.topic_id left join public.user_question_state u on u.question_id=q.id and u.user_id=(select auth.uid())
 where (p_source='Mixed' or (p_source='PYQ' and q.pyq) or (p_source='QBank' and not q.pyq))
 and (p_status='All' or (p_status='New' and coalesce(u.attempts,0)=0) or (p_status='Attempted' and u.attempts>0) or (p_status='Incorrect' and (u.wrong or u.last_is_correct=false)) or (p_status='Bookmarked' and u.bookmarked))
 and (not q.pyq or p_exam='All' or p_exam=any(q.exam_tags) or exists(select 1 from public.qbank_source_occurrences o where o.question_id=q.id and o.is_current and p_exam=any(o.exam_tags)))
 ) select id,platform,subject,source_test_label,question_text,options,correct_answer,explanation_html,topic,source_subtopic_label,bookmarked,incorrect,attempts,last_attempted_at,score,shared,case when pyq then 'PYQ' else 'QBank' end from scored order by score desc,id limit least(100,greatest(1,p_limit));
$$;
