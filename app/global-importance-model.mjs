export const conceptKey = c => JSON.stringify([c.subject, c.concept_id]);
export const tierOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export const importanceOrder = (a,b) => (tierOrder[a.global_importance_tier] ?? 3)-(tierOrder[b.global_importance_tier] ?? 3) || b.global_importance_score-a.global_importance_score || (b.latest_exam_year || 0)-(a.latest_exam_year || 0) || b.total_pyq_occurrences-a.total_pyq_occurrences || a.primary_concept.localeCompare(b.primary_concept);
export function matches(c,f) {
 const exam = {'NEET-PG':'neet_pg_occurrences','INI-CET':'ini_cet_occurrences','AIIMS':'aiims_occurrences'}[f.exam];
 return (!f.subject || c.subject===f.subject) && (!exam || c[exam]>0) && (!f.tier || c.global_importance_tier===f.tier) && (!f.family || (f.family==='Unassigned' ? !c.concept_family : c.concept_family===f.family)) && (f.status==='All' || !f.status || (f.status==='New' && !c.attempts) || (f.status==='Attempted' && c.attempts>0) || (f.status==='Incorrect' && c.incorrect) || (f.status==='Bookmarked' && (c.concept_bookmarked || c.question_bookmarked))) && (!f.search || c.primary_concept.toLowerCase().includes(f.search.toLowerCase()));
}
export function recallReason(c, now=Date.now()) {
 const parts=[`${c.global_importance_tier} PYQ importance`];
 if(c.incorrect) parts.push('incorrect before');
 if(c.concept_bookmarked || c.question_bookmarked) parts.push('bookmarked');
 if(!c.attempts) parts.push('not practiced yet');
 else if(c.due_at && Date.parse(c.due_at)<=now) parts.push('review overdue');
 else if(c.last_reviewed_at && now-Date.parse(c.last_reviewed_at)>=7*86400000) parts.push('not revised recently');
 return parts.join(' + ');
}
export function recallScore(importance,weakness,urgency) { return Math.round((importance*.45+weakness*.35+urgency*.20)*100)/100; }
export function summary(rows) {
 const grouped=new Map();
 for(const c of rows){const s=grouped.get(c.subject)||{subject:c.subject,total_pyq_occurrences:0,neet_pg_occurrences:0,ini_cet_occurrences:0,aiims_occurrences:0,HIGH:0,MEDIUM:0,LOW:0};for(const k of ['total_pyq_occurrences','neet_pg_occurrences','ini_cet_occurrences','aiims_occurrences'])s[k]+=Number(c[k]);s[c.global_importance_tier]++;grouped.set(c.subject,s);}
 return [...grouped.values()].sort((a,b)=>b.total_pyq_occurrences-a.total_pyq_occurrences || a.subject.localeCompare(b.subject));
}
export function pyqIds(c, occurrences, exam='All') { return [...new Set(exam==='All' ? c.question_ids : occurrences.filter(o=>o.exam_tags.includes(exam)).map(o=>o.question_id))]; }
