-- Additive primary-concept recall. Existing source and learner records are unchanged.
create table public.pyq_concept_bookmarks (
 user_id uuid not null references auth.users(id) on delete cascade,
 subject text not null, concept_id text not null, created_at timestamptz not null default now(),
 primary key(user_id,subject,concept_id),
 foreign key(subject,concept_id) references public.pyq_concept_importance(subject,concept_id)
);
alter table public.pyq_concept_bookmarks enable row level security;
create policy concept_bookmark_owner on public.pyq_concept_bookmarks for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert,delete on public.pyq_concept_bookmarks to authenticated;
create table public.pyq_concept_practice_links (
 user_id uuid not null references auth.users(id) on delete cascade,
 subject text not null, concept_id text not null, question_id uuid not null references public.questions(id),
 created_at timestamptz not null default now(), primary key(user_id,subject,concept_id,question_id),
 foreign key(subject,concept_id) references public.pyq_concept_importance(subject,concept_id)
);
alter table public.pyq_concept_practice_links enable row level security;
create policy concept_link_owner on public.pyq_concept_practice_links for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert on public.pyq_concept_practice_links to authenticated;
create or replace function public.gi_search_document(p_stem text,p_options jsonb,p_explanation text)
returns tsvector language sql immutable parallel safe set search_path=pg_catalog as $$
 select setweight(to_tsvector('simple',regexp_replace(coalesce(p_stem,''),'<[^>]*>',' ','g')),'A') ||
 setweight(to_tsvector('simple',regexp_replace(coalesce(p_options::text,''),'<[^>]*>',' ','g')),'B') ||
 setweight(to_tsvector('simple',regexp_replace(coalesce(p_explanation,''),'<[^>]*>',' ','g')),'C')
$$;
create index questions_gi_search_v1_idx on public.questions using gin(public.gi_search_document(question_text,options,explanation_html)) where is_usable and not coalesce(is_grand_test,false);
create view public.pyq_concept_recall_v1 with(security_invoker=true) as
with enriched as (
 select c.subject,c.concept_id,c.system_topic,c.concept_family_id,c.concept_family,c.primary_concept,
 c.total_pyq_occurrences,c.neet_pg_occurrences,c.ini_cet_occurrences,c.aiims_occurrences,c.latest_exam_year,
 c.global_importance_score,c.global_importance_tier,c.question_ids,c.occurrences,
 exists(select 1 from public.pyq_concept_bookmarks b where b.user_id=(select auth.uid()) and b.subject=c.subject and b.concept_id=c.concept_id) as concept_bookmarked,
 coalesce(p.attempts,0) as attempts,coalesce(p.incorrect,false) as incorrect,coalesce(p.question_bookmarked,false) as question_bookmarked,
 p.last_reviewed_at,p.due_at,
 case when coalesce(p.attempts,0)=0 then 0 else least(100,greatest(0,100.0*(p.attempts-p.correct_attempts)/p.attempts)+case when p.incorrect then 20 else 0 end) end as personal_weakness_score,
 case when coalesce(p.attempts,0)=0 then 0 when p.due_at<=now() then least(100,50+extract(epoch from(now()-p.due_at))/86400*5) else least(100,greatest(0,extract(epoch from(now()-p.last_reviewed_at))/86400/30*100)) end as memory_urgency_score
 from public.pyq_concept_importance c
 left join lateral (
  select sum(u.attempts) as attempts,sum(u.correct_attempts) as correct_attempts,bool_or(u.wrong or u.last_is_correct=false) as incorrect,bool_or(u.bookmarked) as question_bookmarked,
  max(coalesce(u.srm_last_reviewed_at,u.last_attempted_at)) as last_reviewed_at,
  min(coalesce(u.srm_due_at,u.recall_due_at)) as due_at
  from public.user_question_state u where u.user_id=(select auth.uid()) and u.question_id in (
   select unnest(c.question_ids) union select l.question_id from public.pyq_concept_practice_links l where l.user_id=(select auth.uid()) and l.subject=c.subject and l.concept_id=c.concept_id
  )
 ) p on true
)
select *,round((global_importance_score*0.45+personal_weakness_score*0.35+coalesce(memory_urgency_score,0)*0.20)::numeric,2) as recall_priority_score from enriched;
grant select on public.pyq_concept_recall_v1 to authenticated;
create function public.gi_similar_questions_v1(p_subject text,p_concept_id text,p_source text default 'QBank',p_status text default 'All',p_exam text default 'All',p_limit integer default 30)
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
 and (p_exam='All' or p_exam=any(q.exam_tags) or exists(select 1 from public.qbank_source_occurrences o where o.question_id=q.id and o.is_current and p_exam=any(o.exam_tags)))
 ) select id,platform,subject,source_test_label,question_text,options,correct_answer,explanation_html,topic,source_subtopic_label,bookmarked,incorrect,attempts,last_attempted_at,score,shared,case when pyq then 'PYQ' else 'QBank' end from scored order by score desc,id limit least(100,greatest(1,p_limit));
$$;
revoke all on function public.gi_similar_questions_v1(text,text,text,text,text,integer) from public,anon;
grant execute on function public.gi_similar_questions_v1(text,text,text,text,text,integer) to authenticated;
comment on function public.gi_similar_questions_v1(text,text,text,text,text,integer) is 'Indexed lexical similarity, not semantic classification. Database-resident stems/options/explanations only; hybrid full content remains loaded on demand through the existing practice adapter. Learner boosts are auth.uid scoped.';
