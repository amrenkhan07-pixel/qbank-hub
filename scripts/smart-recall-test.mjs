import assert from 'node:assert/strict';
import {freshPreferences,allocate,buildPlan,validatePreferences,expandConcepts,EXCLUDED_PYQ,readPreferences,recallQuestionLimit} from '../app/smart-recall-model.mjs';
const p=freshPreferences();assert.deepEqual(allocate(30,p.weights),{importance:12,mistakes:9,bookmarks:5,due:4});
for(const size of [10,20,30,50])assert.equal(Object.values(allocate(size,p.weights)).reduce((a,b)=>a+b),size);
const qs=(prefix,n,subject='Medicine',reason)=>Array.from({length:n},(_,i)=>({question_id:prefix+i,subject,tier:'HIGH',reason}));
const pools={importance:[...qs('a',100),...qs('e',100,'Dermatology')],allImportance:qs('all',100,'Surgery'),mistakes:qs('m',100,'Pathology','Incorrect before'),bookmarks:qs('b',100,'Radiology','Bookmarked'),due:qs('d',100,'Microbiology','Due revision')};
for(const size of [10,20,30,50]){const plan=buildPlan({...p,size},pools);assert.equal(plan.selected.length,size);assert.equal(new Set(plan.selected.map(q=>q.question_id)).size,size);assert.deepEqual(plan.counts,allocate(size,p.weights));assert.equal(recallQuestionLimit('smart-recall',{smart_recall:{size}}),size);}
const plan=buildPlan(p,pools);assert.equal(plan.activeImportance,7);assert.equal(plan.earlyImportance,5);assert(plan.selected.some(q=>q.reason.includes('early exposure')));
assert.equal(recallQuestionLimit('qbank',{smart_recall:{size:50}}),20);assert.equal(recallQuestionLimit('smart-recall',{smart_recall:{size:500}}),20);
const overlap={...pools,mistakes:[...pools.importance.slice(0,9),...pools.mistakes]};assert.equal(new Set(buildPlan(p,overlap).selected.map(q=>q.question_id)).size,30);
const fallback=buildPlan(p,{importance:[],mistakes:qs('m',3),bookmarks:qs('b',2),due:[],allImportance:qs('x',50)});assert.equal(fallback.selected.length,30);assert.equal(fallback.counts.mistakes,3);assert.equal(fallback.counts.bookmarks,2);assert.equal(fallback.fallbackCount,25);
assert.equal(buildPlan(p,{importance:[],allImportance:[],mistakes:[],bookmarks:[],due:[]}).shortfall,30);
assert(buildPlan(p,pools,'importance').selected.every(q=>q.bucket==='importance'));assert(buildPlan(p,pools,'mistakes').selected.every(q=>q.bucket==='mistakes'));
const concept={subject:'Medicine',concept_id:'x',primary_concept:'Concept',question_ids:[EXCLUDED_PYQ,'ok','ok'],global_importance_score:12,latest_exam_year:2025,total_pyq_occurrences:2,global_importance_tier:'HIGH',concept_family:null};assert.deepEqual(expandConcepts([concept,concept]).map(q=>q.question_id),['ok']);
for(const subject of ['Dermatology','Psychiatry','Anaesthesia','Biochemistry'])assert(buildPlan({...p,focus:'custom',custom:[subject]},{...pools,importance:qs('s',50,subject)},'importance').selected.every(q=>q.subject===subject));
assert.throws(()=>validatePreferences({...p,weights:{...p.weights,importance:41}}));assert.throws(()=>validatePreferences({...p,focus:'custom',custom:[]}));assert.throws(()=>validatePreferences({...p,early:['Medicine']}));
const memory=new Map();const storage={getItem:k=>memory.get(k)};memory.set('qbank-smart-recall-v1:one',JSON.stringify({...p,size:50}));assert.equal(readPreferences(storage,'one').size,50);assert.equal(readPreferences(storage,'two').size,30);
console.log('PASS: exact mix allocation, 7/5 distribution, 10/20/30/50 sizes, deduplication, fallback, scarcity, only modes, early subjects, unresolved exclusion, optional families, input validation, per-account preferences, legacy 20-question limit.');
