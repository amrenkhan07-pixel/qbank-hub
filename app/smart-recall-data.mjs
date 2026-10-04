import {selectedSubjects,expandConcepts,normalizeSubject} from './smart-recall-model.mjs';
const check=r=>{if(r.error)throw r.error;return r.data||[];};
export async function loadRecallPools(db,userId,p,subjectRows,now=Date.now()) {
 const [all,personal]=await Promise.all([
  db.rpc('smart_recall_importance_pool',{p_subjects:p.temporarySubject?[p.temporarySubject]:null,p_exam_focus:p.examFocus||'All',p_limit_per_subject:50}).then(check),
  db.rpc('smart_recall_personal_candidates',{p_subject:p.temporarySubject||null,p_limit:90}).then(check),
 ]);
 const selected=selectedSubjects(p),allImportance=expandConcepts(all,true);
 const decorate=q=>({...q,subject:normalizeSubject(q.subject),reasons:[
  q.tier?`${q.tier} Global Importance`:null,
  q.repeated>1?`Repeated mistake ×${q.repeated}`:q.incorrect?'Incorrect before':null,
  q.bookmarked?'Bookmarked':null,q.marked_for_review?'Marked for review':null,
  q.due_at&&Date.parse(q.due_at)<=now?'Due for revision':null,
  q.last_attempted_at?`Last attempted ${Math.max(0,Math.floor((now-Date.parse(q.last_attempted_at))/86400000))} days ago`:null,
 ].filter(Boolean)});
 return {importance:allImportance.filter(q=>selected.includes(q.subject)),allImportance,
 mistakes:(personal.mistakes||[]).map(q=>({...decorate(q),reason:q.repeated>1?`Repeated mistake ×${q.repeated}`:'Incorrect before'})),
 bookmarks:(personal.bookmarks||[]).map(q=>({...decorate(q),reason:q.bookmarked?'Bookmarked':'Marked for review'})),
 due:(personal.due||[]).map(q=>({...decorate(q),reason:q.due_at&&Date.parse(q.due_at)<=now?'Due revision':'Past question · not revised recently'}))};
}
