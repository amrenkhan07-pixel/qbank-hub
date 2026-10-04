import {selectedSubjects,expandConcepts,normalizeSubject,EXCLUDED_PYQ} from './smart-recall-model.mjs';
const check=r=>{if(r.error)throw r.error;return r.data||[];};
async function paged(factory){const rows=[];for(let from=0;;from+=500){const batch=check(await factory().range(from,from+499));rows.push(...batch);if(batch.length<500)return rows;}}
function concepts(db,subjects,p){return db.rpc('smart_recall_importance_candidates',{p_subjects:subjects?.length?subjects:null,p_exam_focus:p.examFocus||'All',p_limit_per_subject:50});}
export async function loadRecallPools(db,userId,p,subjectRows,now=Date.now()) {
 const selected=selectedSubjects(p);
 const [all,learning,bookmarks]=await Promise.all([
  concepts(db,null,p).then(check),
  paged(()=>db.from('user_question_state').select('question_id,attempts,wrong,last_is_correct,bookmarked,marked_for_review,revision,srm_consecutive_incorrect,srm_due_at,recall_due_at,last_attempted_at,srm_last_reviewed_at').eq('user_id',userId).order('question_id')),
  paged(()=>db.from('bookmarks').select('question_id').eq('user_id',userId).order('question_id')),
 ]);
 const importance=expandConcepts(all.filter(c=>selected.includes(c.subject)),true),allImportance=expandConcepts(all,true);
 const states=new Map(learning.map(s=>[s.question_id,s]));for(const b of bookmarks)states.set(b.question_id,{...states.get(b.question_id),question_id:b.question_id,bookmarked:true});
 const ids=[...new Set([...importance,...allImportance,...states.values()].map(q=>q.question_id))].filter(id=>id!==EXCLUDED_PYQ);
 const eligible=new Map(),subjects=new Map(subjectRows.map(s=>[s.id,normalizeSubject(s.name)]));
 for(let i=0;i<ids.length;i+=200){const rows=check(await db.from('questions').select('id,subject_id').in('id',ids.slice(i,i+200)).eq('is_usable',true).or('is_grand_test.is.null,is_grand_test.eq.false'));for(const q of rows)eligible.set(q.id,{question_id:q.id,subject:subjects.get(q.subject_id)||''});}
 const conceptForQuestion=new Map([...importance,...allImportance].map(q=>[q.question_id,q]));
 const personal=[...states.values()].filter(s=>eligible.has(s.question_id)).map(s=>({...conceptForQuestion.get(s.question_id),...s,...eligible.get(s.question_id)}));
 const mistakes=personal.filter(s=>s.wrong||s.last_is_correct===false||s.srm_consecutive_incorrect>0).sort((a,b)=>Number(p.active.includes(b.subject))-Number(p.active.includes(a.subject))||Number(b.srm_consecutive_incorrect||0)-Number(a.srm_consecutive_incorrect||0)||(Date.parse(b.last_attempted_at||'')||0)-(Date.parse(a.last_attempted_at||'')||0)).map(s=>({...s,reason:s.srm_consecutive_incorrect>1?'Repeated mistakes':'Incorrect before'}));
 const marked=personal.filter(s=>s.bookmarked||s.marked_for_review||s.revision).map(s=>({...s,reason:s.bookmarked?'Bookmarked':'Marked for review'}));
 const dueTime=s=>Date.parse(s.srm_due_at||s.recall_due_at||'')||Infinity;
 const lastTime=s=>Date.parse(s.srm_last_reviewed_at||s.last_attempted_at||'')||0;
 const due=personal.filter(s=>s.attempts>0||dueTime(s)<=now).sort((a,b)=>Number(dueTime(b)<=now)-Number(dueTime(a)<=now)||Math.min(dueTime(a),lastTime(a))-Math.min(dueTime(b),lastTime(b))).map(s=>({...s,reason:dueTime(s)<=now?'Due revision':'Past question · not revised recently'}));
 return {importance:importance.filter(q=>eligible.has(q.question_id)),allImportance:allImportance.filter(q=>eligible.has(q.question_id)),mistakes,bookmarks:marked,due};
}
