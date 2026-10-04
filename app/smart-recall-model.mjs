export const SUBJECTS = ['Medicine','Surgery','Obstetrics & Gynecology','Pediatrics','Pathology','Pharmacology','Microbiology','Community Medicine','Anatomy','Physiology','Biochemistry','Forensic Medicine','Ophthalmology','Otorhinolaryngology','Orthopedics','Dermatology','Psychiatry','Radiology','Anaesthesia'];
export const EXCLUDED_PYQ = '4c7dc09f-5a20-5bf5-a4f6-febc9ef48842';
export const BUCKETS = ['importance','mistakes','bookmarks','due'];
export const LABELS = {importance:'Global Importance',mistakes:'Mistakes',bookmarks:'Bookmarked/Review',due:'Due revision / past'};
export const DEFAULTS = {version:1,size:30,focus:'prep',active:['Medicine','Pathology','Pharmacology','Microbiology'],early:['Dermatology','Psychiatry','Anaesthesia','Biochemistry','Radiology','Otorhinolaryngology','Ophthalmology'],custom:[],activePercent:60,weights:{importance:40,mistakes:30,bookmarks:15,due:15}};
export const freshPreferences = () => structuredClone(DEFAULTS);
export function normalizeSubject(name='') {
 const key=name.toLowerCase().replace(/[^a-z]/g,'');
 if(['obstetricsgynecology','obstetricsgynaecology','obstetricsandgynaecology','obstetricsandgynecology','obgyn'].includes(key))return 'Obstetrics & Gynecology';
 if(key==='ent')return 'Otorhinolaryngology';
 if(key==='anesthesia')return 'Anaesthesia';
 if(key==='orthopaedics')return 'Orthopedics';
 return SUBJECTS.find(s=>s.toLowerCase().replace(/[^a-z]/g,'')===key)||name;
}
export function validatePreferences(p) {
 if(![10,20,30,50].includes(p.size))throw new Error('Choose 10, 20, 30 or 50 questions.');
 if(!['prep','all','active','early','custom'].includes(p.focus))throw new Error('Choose a Global Importance focus.');
 for(const field of ['active','early','custom'])if(!Array.isArray(p[field])||p[field].some(s=>!SUBJECTS.includes(s))||new Set(p[field]).size!==p[field].length)throw new Error('Choose valid subjects.');
 if(!Number.isInteger(p.activePercent)||p.activePercent<0||p.activePercent>100)throw new Error('Active subject percentage must be between 0 and 100.');
 if(BUCKETS.some(b=>!Number.isInteger(p.weights?.[b])||p.weights[b]<0||p.weights[b]>100)||BUCKETS.reduce((n,b)=>n+p.weights[b],0)!==100)throw new Error('Recall mix percentages must add up to 100.');
 if(p.active.some(s=>p.early.includes(s)))throw new Error('Active and early exposure subjects must not overlap.');
 if((p.focus==='active'||p.focus==='prep'&&p.activePercent>0)&&!p.active.length)throw new Error('Select at least one active subject.');
 if((p.focus==='early'||p.focus==='prep'&&p.activePercent<100)&&!p.early.length)throw new Error('Select at least one early exposure subject.');
 if(p.focus==='custom'&&!p.custom.length)throw new Error('Select at least one custom subject.');
 return p;
}
export function readPreferences(storage,userId) {
 try{const saved=JSON.parse(storage.getItem(`qbank-smart-recall-v1:${userId}`));if(saved?.version===1)return validatePreferences(saved);}catch{}
 return freshPreferences();
}
export function allocate(size,weights,keys=BUCKETS) {
 const raw=keys.map((key,index)=>({key,index,value:size*weights[key]/100}));const counts=Object.fromEntries(raw.map(r=>[r.key,Math.floor(r.value)]));
 const remaining=size-Object.values(counts).reduce((a,b)=>a+b,0);
 raw.sort((a,b)=>(b.value%1)-(a.value%1)||a.index-b.index).slice(0,remaining).forEach(r=>counts[r.key]++);
 return counts;
}
export function selectedSubjects(p) {return p.focus==='all'?SUBJECTS:p.focus==='prep'?[...p.active,...p.early]:p[p.focus];}
export const importanceOrder=(a,b)=>b.global_importance_score-a.global_importance_score||(b.latest_exam_year||0)-(a.latest_exam_year||0)||b.total_pyq_occurrences-a.total_pyq_occurrences||a.primary_concept.localeCompare(b.primary_concept)||a.concept_id.localeCompare(b.concept_id);
export function expandConcepts(concepts,preserveOrder=false) {
 const used=new Set();return (preserveOrder?[...concepts]:[...concepts].sort(importanceOrder)).flatMap(c=>(c.question_ids||[]).filter(id=>id!==EXCLUDED_PYQ&&!used.has(id)&&used.add(id)).map(question_id=>({question_id,subject:c.subject,primary_concept:c.primary_concept,tier:c.global_importance_tier,concept_id:c.concept_id})));
}
export function buildPlan(p,pools,mode='mixed') {
 validatePreferences(p);
 const targets=mode==='importance'?{importance:p.size,mistakes:0,bookmarks:0,due:0}:mode==='mistakes'?{importance:0,mistakes:p.size,bookmarks:0,due:0}:allocate(p.size,p.weights);
 const groups=Object.fromEntries(BUCKETS.map(b=>[b,[]])),used=new Set(),usedConcepts=new Set();
 const add=(items,n,bucket,fallback=false)=>{let taken=0;for(const q of items){if(taken>=n)break;if(!q?.question_id||q.question_id===EXCLUDED_PYQ||used.has(q.question_id))continue;const concept=q.concept_id?`${q.subject}:${q.concept_id}`:null;if(bucket==='importance'&&concept&&usedConcepts.has(concept))continue;if(concept)usedConcepts.add(concept);used.add(q.question_id);groups[bucket].push({...q,bucket,fallback,reason:q.reason||`${q.tier||'PYQ'} Global Importance${p.active.includes(q.subject)?' from active subject':p.early.includes(q.subject)?' + early exposure subject':''}`});taken++;}return taken;};
 // Reserve personal buckets before selecting overlapping PYQs, so one question is never counted twice.
 for(const bucket of ['mistakes','bookmarks','due'])add(pools[bucket]||[],targets[bucket],bucket);
 const importance=pools.importance||[];
 if(p.focus==='prep'){
  const split=allocate(targets.importance,{active:p.activePercent,early:100-p.activePercent},['active','early']);
  add(importance.filter(q=>p.active.includes(q.subject)),split.active,'importance');add(importance.filter(q=>p.early.includes(q.subject)),split.early,'importance');
 }else add(importance,targets.importance,'importance');
 let remaining=p.size-used.size;
 const fallbacks=mode==='mistakes'?[['mistakes',pools.mistakes]]:mode==='importance'?[['importance',importance],['importance',pools.allImportance]]:[['importance',importance],['mistakes',pools.mistakes],['bookmarks',pools.bookmarks],['importance',pools.allImportance]];
 for(const [bucket,items]of fallbacks){remaining-=add(items||[],remaining,bucket,true);if(!remaining)break;}
 // Interleave buckets without changing their priority order.
 const selected=[];for(let i=0;selected.length<used.size;i++)for(const bucket of BUCKETS)if(groups[bucket][i])selected.push(groups[bucket][i]);
 return {version:1,requested:p.size,mode,targets,counts:Object.fromEntries(BUCKETS.map(b=>[b,groups[b].length])),selected,shortfall:p.size-selected.length,activeImportance:groups.importance.filter(q=>p.active.includes(q.subject)).length,earlyImportance:groups.importance.filter(q=>p.early.includes(q.subject)).length,fallbackCount:selected.filter(q=>q.fallback).length};
}

export const recallQuestionLimit=(preset,filters)=>preset==='smart-recall'&&[10,20,30,50].includes(filters?.smart_recall?.size)?filters.smart_recall.size:20;
