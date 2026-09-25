const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const base=path.resolve(__dirname,'..'),bridge=require('../gt-taxonomy/bridge.cjs');
const data=JSON.parse(fs.readFileSync(base+'/gt-taxonomy/data.json')),before=JSON.parse(fs.readFileSync(base+'/gt-taxonomy/atlas-state.json'));
before.concept_families=[];for(const c of before.registry)c.concept_family_id=null;
(async()=>{
 const a=bridge.open(data,before),packet=bridge.familyPacket(a);
 assert.equal(packet.length,1297);assert.equal(new Set(packet.map(c=>c.concept_id)).size,1297);assert.equal(Object.keys(a.state.mappings).length,1400);
 for(const [id,m]of Object.entries(before.mappings))assert.deepEqual(a.state.mappings[id],{...m,subject:m.subject==='ENT'?'Otorhinolaryngology':m.subject});
 assert(!packet.some(c=>c.subject==='ENT'||'stem'in c||'explanation'in c));
 const oldRevision=a.registryRevision(),oldValid=Object.keys(a.state.verifications).filter(id=>a.verification(id));
 const subjects=[...new Set(packet.map(c=>c.subject))];const familyInput={version:1,registry_revision:oldRevision,families:subjects.map((s,i)=>({concept_family_id:'fixture-'+i,canonical_family_name:'Synthetic test family '+i,subject:s,aliases:[],status:'draft'})),assignments:packet.map(c=>({concept_id:c.concept_id,concept_family_id:'fixture-'+subjects.indexOf(c.subject)}))};
 const saved=JSON.stringify(a.state);const bad=structuredClone(familyInput);bad.assignments[0].concept_family_id='unknown';assert.throws(()=>bridge.importFamilies(a,bad));assert.equal(JSON.stringify(a.state),saved);
 const cross=structuredClone(familyInput);cross.families[0].subject='Not matching';assert.throws(()=>bridge.importFamilies(a,cross));
 assert.throws(()=>bridge.importFamilies(a,{...familyInput,registry_revision:'stale'}));
 bridge.importFamilies(a,familyInput);assert.equal(a.registryRevision(),oldRevision);assert(oldValid.every(id=>a.verification(id)));assert.equal(a.state.registry.length,1297);
 // A separate synthetic future dataset proves imports are atomic and reuse before inventing.
 const d=bridge.dataset({version:1,dataset_id:'fixture',questions:[1,2].map(i=>({question_id:'fixture:'+i,stem:'Synthetic stem',correct_answer:'A',explanation:'Synthetic evidence',image_dependent:false}))});
 const b=bridge.open(d,{registry:[],mappings:{}}),rows=d.questions.map(q=>({question_id:q.id,subject:'Medicine',primary_concept:'Synthetic objective',confidence:.97,needs_review:false}));
 const vp=bridge.importClassified(b,d,rows);assert.equal(b.state.registry.length,1);assert.equal(vp.questions.length,2);assert(!b.verification('fixture:1'));assert.throws(()=>bridge.importClassified(b,d,rows));
 const result={version:1,registry_revision:vp.registry_revision,results:vp.questions.map((q,i)=>({question_id:q.question_id,revision:q.revision,subject:'Medicine',primary_concept:'Synthetic objective',subject_ok:true,concept_ok:true,granularity_ok:true,registry_checked:true,reuse_concept_id:null,source_issue:i===0,image_required:i===1,image_evidence_sufficient:i!==1,confidence:.97,reason:'Synthetic routing evidence'}))};
 assert.deepEqual(b.importVerification(result).counts,{AUTO_ACCEPT:0,SOURCE_ISSUE:1,CLASSIFICATION_REVIEW:1});
 const bindings={version:1,tests:[...new Set(data.questions.map(q=>q.test_id))].map((id,i)=>({source_test_id:id,source_test_uuid:`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,payload_sha256:String(i+1).repeat(64),question_ids:data.questions.filter(q=>q.test_id===id).sort((x,y)=>x.position-y.position).map(q=>q.source_question_id)}))};
 assert.throws(()=>bridge.publish(bridge.open(data,before),data,bindings));
 const snap=bridge.publish(a,data,bindings);assert.equal(snap.tests.reduce((n,t)=>n+t.questions.length,0),1400);const broken=structuredClone(bindings);broken.tests[0].question_ids.reverse();assert.throws(()=>bridge.publish(a,data,broken));
 const {aggregateTaxonomy,loadCompletedTaxonomy}=await import(pathToFileURL(base+'/app/gt-taxonomy-analytics.js'));
 const t=snap.tests[0],attempt={id:'attempt',status:'completed',source_test_id:t.source_test_uuid,payload_sha256:t.payload_sha256,question_count:t.questions.length,result:{outcomes:Object.fromEntries(t.questions.map(q=>[q.position,'unanswered']))},responses:{'1':{selected:['A'],marked:true},'2':{selected:['A']}}};attempt.result.outcomes['2']='correct';attempt.result.outcomes['3']='incorrect';
 const stats=aggregateTaxonomy(snap,attempt);assert.equal(stats.metrics.unscored,1);assert.equal(stats.metrics.unattempted,197);assert.equal(stats.metrics.accuracy,50);assert.equal(stats.metrics.average_time_ms,null);
 assert.throws(()=>aggregateTaxonomy(snap,{...attempt,status:'in_progress'}));assert.throws(()=>aggregateTaxonomy(snap,{...attempt,payload_sha256:'0'.repeat(64)}));
 let touched=false;await assert.rejects(loadCompletedTaxonomy({rpc(){touched=true}},{status:'in_progress'},()=>{touched=true}));assert.equal(touched,false);
 const outcomesMissing=structuredClone(attempt);delete outcomesMissing.result.outcomes['10'];assert.throws(()=>aggregateTaxonomy(snap,outcomesMissing));
 // Fixture families remain in memory; tests never overwrite working Atlas state.
 const final=bridge.open(data,before);
 let template=fs.readFileSync(base+'/gt-taxonomy/template.html','utf8').replace(/const IMPORTED_DRAFT_STATE=.*;\n/,()=>`const IMPORTED_DRAFT_STATE=${JSON.stringify(final.state).replace(/</g,'\\u003c')};\n`);
 const html=template.replace('/*PIPELINE*/',()=>fs.readFileSync(base+'/gt-taxonomy/pipeline.js','utf8')).replace('/*DATA*/',()=>JSON.stringify(data).replace(/</g,'\\u003c'));new(require('node:vm').Script)(html.match(/<script>([\s\S]*)<\/script>/)[1]);
 console.log(JSON.stringify({passed:true,mappings:1400,concepts:1297,families_assigned:0,alias_normalizations:final.state.normalization_history.at(-1).changes.length,retained_valid_verifications:oldValid.length,checks:'preservation, family atomicity, cross-subject rejection, stale revisions, exact reuse, verifier routes, complete payload binding, completed-only analytics, scoring, unavailable timing, inline script syntax'}));
})().catch(e=>{console.error(e);process.exitCode=1});
