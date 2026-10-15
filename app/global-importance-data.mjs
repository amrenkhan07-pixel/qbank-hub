// Static summaries are account-keyed and short-lived. Personal concept state is
// always refreshed on entry; filters/page changes reuse only that screen's rows.
export const CONCEPT_FIELDS='subject,concept_id,system_topic,concept_family,primary_concept,total_pyq_occurrences,neet_pg_occurrences,ini_cet_occurrences,aiims_occurrences,latest_exam_year,global_importance_score,global_importance_tier,question_ids,concept_bookmarked,question_bookmarked,attempts,incorrect,last_reviewed_at,due_at,personal_weakness_score,memory_urgency_score,recall_priority_score';
export const SUMMARY_FIELDS='subject,primary_concept_count,total_pyq_occurrences,neet_pg_occurrences,ini_cet_occurrences,aiims_occurrences,high_concept_count,medium_concept_count,low_concept_count';
export function createImportanceData(db,now=Date.now){
 let cached=null;
 const check=r=>{if(r.error)throw r.error;return r.data||[];};
 return {
  async summaries(userId){
   if(cached?.userId===userId&&now()-cached.at<300000)return cached.promise;
   const entry={userId,at:now()};
   entry.promise=Promise.resolve(db.from('subject_importance_summary').select(SUMMARY_FIELDS).order('subject')).then(check).then(rows=>rows.map(s=>({...s,HIGH:s.high_concept_count,MEDIUM:s.medium_concept_count,LOW:s.low_concept_count})).sort((a,b)=>b.total_pyq_occurrences-a.total_pyq_occurrences||a.subject.localeCompare(b.subject))).catch(error=>{if(cached===entry)cached=null;throw error;});
   cached=entry;return entry.promise;
  },
  async concepts(subject,current=()=>true){
   const rows=[];
   for(let from=0;current();from+=500){
    let query=db.from('pyq_concept_recall_v1').select(CONCEPT_FIELDS);
    if(subject)query=query.eq('subject',subject);
    const batch=check(await query.order('subject').order('concept_id').range(from,from+499));
    if(!current())return [];
    rows.push(...batch);if(batch.length<500)break;
   }
   return rows;
  }
 };
}

