// Classification labels are revealed only after submission, never in the question header.
export function safeRecallMetadata(item={}) {
 const tier=['HIGH','MEDIUM','LOW'].includes(item.tier)?item.tier: /\b(HIGH|MEDIUM|LOW)\b/.exec(item.reason||'')?.[1];
 const importance=tier?`${{HIGH:'★★★',MEDIUM:'★★',LOW:'★'}[tier]} ${tier} Global Importance`:'';
 const scope= (/early exposure/i.test(item.reason||'')?'Early exposure subject':/active subject/i.test(item.reason||'')?'Active subject':'');
 return [item.subject,importance,scope || ({mistakes:'Mistakes',due:'Due revision',bookmarks:'Saved for review'}[item.bucket])].filter(Boolean).join(' · ') || 'Recall practice';
}
export function recallConcept(active,questionId) {
 return active?.filters?.smart_recall?.questions?.find(q=>q.question_id===questionId) || active?.filters?.importance_concept || null;
}
export function isRecallSelection(set) {return set?.mode==='recall'||set?.kind==='recall'||Boolean(set?.filters?.importance_concept);}
export function studyContext(session,meta) {
 const f=session.filters||{};
 const names=(key,collection)=>(f[key]||[]).map(id=>meta[collection]?.find(x=>x.id===id)?.name).filter(Boolean);
 const module=meta.sourceTests?.find(t=>t.id===f.source_tests?.[0]);
 return [...names('platforms','platforms'),...names('subjects','subjects'),...names('systems','systems'),...names('topics','topics'),...names('subtopics','subtopics'),module?.name||module?.title].filter(Boolean).join(' · ') || session.title || 'QBank session';
}
