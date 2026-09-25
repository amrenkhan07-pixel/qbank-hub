// Deterministic format conversion/import only. No medical reinterpretation or network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const bridge=require('../gt-taxonomy/bridge.cjs');
const root=path.resolve(__dirname,'../gt-taxonomy'),read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const write=(n,x)=>fs.writeFileSync(path.join(root,n),JSON.stringify(x));
const data=read('data.json'),before=read('atlas-state.json'),rows=read('core-btr-gt-1297-family-assignments.json'),bindings=read('gt-payload-bindings.json');
const a=bridge.open(data,before),revision=a.registryRevision();
assert.equal(rows.length,1297);assert.equal(new Set(rows.map(r=>r.concept_id)).size,1297);assert.equal(rows.filter(r=>r.needs_review).length,12);
assert.deepEqual(new Set(rows.map(r=>r.concept_id)),new Set(a.state.registry.map(c=>c.concept_id)));
assert.deepEqual(a.state.mappings,before.mappings);
const familyMap=new Map();
const assignments=rows.map(r=>{
 assert.equal(a.get(r.concept_id).subject,r.subject);
 const key=JSON.stringify([r.subject,r.system,r.concept_family]);
 if(!familyMap.has(key))familyMap.set(key,{concept_family_id:'family-'+crypto.createHash('sha256').update(key).digest('hex').slice(0,24),canonical_family_name:r.concept_family,subject:r.subject,system:r.system,aliases:[],status:'draft'});
 return {...r,concept_family_id:familyMap.get(key).concept_family_id};
});
const packet={version:1,registry_revision:revision,families:[...familyMap.values()],assignments};
bridge.importFamilies(a,packet);
assert.equal(a.registryRevision(),revision);assert.deepEqual(a.state.mappings,before.mappings);assert.deepEqual(a.state.verifications,before.verifications);
for(const c of a.state.registry){const old=before.registry.find(x=>x.concept_id===c.concept_id);assert.deepEqual({...c,concept_family_id:old.concept_family_id},old);}
for(const row of rows){const {concept_family_id,...preserved}=a.state.family_assignments[row.concept_id];assert.deepEqual(preserved,row);}
const snapshot=bridge.publish(a,data,bindings);assert.equal(snapshot.tests.length,7);assert.equal(snapshot.tests.reduce((n,t)=>n+t.questions.length,0),1400);
const concepts=new Map(snapshot.concepts.map(c=>[c.concept_id,c])),families=new Map(snapshot.families.map(f=>[f.concept_family_id,f]));
const corpus=new Map(),scoped=new Map();
for(const t of snapshot.tests)for(const q of t.questions){
 const c=concepts.get(q.concept_id),f=families.get(c.concept_family_id);assert(c&&f&&c.subject===q.subject&&f.subject===q.subject&&f.system);
 for(const [map,key]of [[corpus,JSON.stringify([f.system,f.canonical_family_name])],[scoped,f.concept_family_id]]){
  if(!map.has(key))map.set(key,{concept_family:f.canonical_family_name,system:f.system,subjects:new Set(),total_gt_questions:0,primary_concepts:new Set()});
  const group=map.get(key);group.total_gt_questions++;group.primary_concepts.add(c.concept_id);group.subjects.add(q.subject);
 }
}
const list=map=>[...map.values()].map(x=>({...x,subjects:[...x.subjects].sort(),distinct_primary_concepts:x.primary_concepts.size,primary_concepts:undefined})).sort((x,y)=>y.total_gt_questions-x.total_gt_questions||y.distinct_primary_concepts-x.distinct_primary_concepts||x.concept_family.localeCompare(y.concept_family));
const report={assignments:rows.length,mappings:Object.keys(a.state.mappings).length,systems:new Set(rows.map(r=>r.system)).size,concept_families:familyMap.size,distinct_family_labels:new Set(rows.map(r=>r.concept_family)).size,needs_review:rows.filter(r=>r.needs_review).map(r=>r.concept_id),live_tests:7,unresolved_mappings:0,snapshot_bytes:Buffer.byteLength(JSON.stringify(snapshot)),top20_corpus_families:list(corpus).slice(0,20),top20_subject_scoped_families:list(scoped).slice(0,20)};
// Commit files only after all conversion and publication preconditions pass.
write('atlas-family-import.json',packet);write('atlas-state.json',a.state);write('live-taxonomy.json',snapshot);write('integration-report.json',report);
console.log(JSON.stringify(report,null,2));
