const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),read=n=>JSON.parse(fs.readFileSync(root+'/gt-taxonomy/'+n));
(async()=>{
 const rows=read('core-btr-gt-1297-family-assignments.json'),state=read('atlas-state.json'),bundle=read('live-taxonomy.json'),bindings=read('gt-payload-bindings.json');
 assert.equal(rows.length,1297);assert.equal(bundle.concepts.length,1297);assert.equal(bundle.families.length,1026);assert.equal(bundle.tests.length,7);
 assert.equal(bundle.concepts.filter(c=>c.family_needs_review).length,12);assert.equal(new Set(bundle.families.map(f=>f.system)).size,52);
 const fields=new Set(['stem','text','raw_text','options','explanation','payload','images','correct_answer','source']);
 function check(x){if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){assert(!fields.has(k),'Forbidden snapshot field '+k);check(v);}}check(bundle);
 for(const row of rows){const c=bundle.concepts.find(c=>c.concept_id===row.concept_id),f=bundle.families.find(f=>f.concept_family_id===c.concept_family_id);assert.equal(c.subject,row.subject);assert.equal(f.subject,row.subject);assert.equal(f.system,row.system);assert.equal(f.canonical_family_name,row.concept_family);assert.equal(c.family_confidence,row.confidence);assert.equal(c.family_needs_review,row.needs_review);}
 const {aggregateTaxonomy,renderTaxonomy,loadCompletedTaxonomy}=await import(pathToFileURL(root+'/app/gt-taxonomy-analytics.js'));
 let first;
 for(const t of bundle.tests){
  const b=bindings.tests.find(b=>b.source_test_uuid===t.source_test_uuid);assert.deepEqual(t.questions.map(q=>q.source_question_id),b.question_ids);assert.equal(t.payload_sha256,b.payload_sha256);
  const attempt={id:'fixture',status:'completed',source_test_id:t.source_test_uuid,payload_sha256:t.payload_sha256,question_count:200,section_size:50,result:{outcomes:Object.fromEntries(t.questions.map(q=>[q.position,q.position%4===1?'correct':q.position%4===2?'incorrect':'unanswered']))},responses:Object.fromEntries(t.questions.filter(q=>q.position%4===3).map(q=>[q.position,{selected:['A'],saved_at:'2026-01-01'}]))};
  first||=attempt;const tree=aggregateTaxonomy(bundle,attempt);assert.equal(tree.metrics.total,200);assert.equal(tree.metrics.correct,50);assert.equal(tree.metrics.incorrect,50);assert.equal(tree.metrics.unattempted,50);assert.equal(tree.metrics.unscored,50);assert.equal(tree.metrics.accuracy,50);assert.equal(tree.metrics.average_time_ms,null);assert.equal(tree.sections.length,4);assert(tree.sections.every(s=>s.metrics.total===50));
  assert.equal(tree.subjects.reduce((n,s)=>n+s.metrics.total,0),200);
  for(const s of tree.subjects){assert.equal(s.systems.reduce((n,y)=>n+y.metrics.total,0),s.metrics.total);for(const y of s.systems){assert.equal(y.families.reduce((n,f)=>n+f.metrics.total,0),y.metrics.total);for(const f of y.families){assert.equal(f.concepts.reduce((n,c)=>n+c.metrics.total,0),f.metrics.total);const ids=new Set(bundle.concepts.filter(c=>c.concept_family_id===f.concept_family_id).map(c=>c.concept_id));const qs=bundle.tests.flatMap(t=>t.questions).filter(q=>ids.has(q.concept_id));assert.equal(f.recurrence.questions,qs.length);assert.equal(f.recurrence.primary_concepts,new Set(qs.map(q=>q.concept_id)).size);}}}
  const html=renderTaxonomy(tree,x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'));assert(html.includes('Section performance')&&html.includes('distinct primary concepts'));assert(!html.includes('NaN'));
 }
 // Explicit different-primary-concept recurrence regression, with no concept merging.
 const multi=bundle.families.find(f=>new Set(bundle.concepts.filter(c=>c.concept_family_id===f.concept_family_id).map(c=>c.concept_id)).size>1);assert(multi);
 const attempt=structuredClone(first);attempt.status='in_progress';assert.throws(()=>aggregateTaxonomy(bundle,attempt));let touched=false;await assert.rejects(loadCompletedTaxonomy({rpc(){touched=true}},attempt,()=>{touched=true}));assert.equal(touched,false);
 assert.throws(()=>aggregateTaxonomy(bundle,{...first,payload_sha256:'bad'}));
 const bad=structuredClone(first);delete bad.result.outcomes['1'];assert.throws(()=>aggregateTaxonomy(bundle,bad));
 const failed=structuredClone(bundle);failed.tests[0].questions[0].concept_id='unknown';assert.throws(()=>aggregateTaxonomy(failed,first));
 await assert.rejects(loadCompletedTaxonomy({rpc:async()=>({data:{...first,id:'wrong'}})},first,async()=>({ok:true,json:async()=>bundle})));
 const ok=await loadCompletedTaxonomy({rpc:async(name,args)=>{assert.equal(name,'qbank_gt_state');assert.equal(args.p_attempt,first.id);return {data:first};}},first,async()=>({ok:true,json:async()=>bundle}));assert.equal(ok.metrics.total,200);
 const gt=fs.readFileSync(root+'/app/grand-tests.js','utf8');assert(gt.includes('loadCompletedTaxonomy'));const original=fs.readFileSync(root+'/app/gt-exam-mode.js','utf8');assert(!original.includes('gt-taxonomy'));
 console.log('PASS: exact preservation; 7 payload bindings; 1,400 joins; systems/families/concepts/sections; multi-concept recurrence; 12 review flags; no question content or fabricated timing; incomplete/active/mismatched attempts rejected.');
})().catch(e=>{console.error(e);process.exitCode=1});
