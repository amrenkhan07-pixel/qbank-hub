/* Engineering-only bridge: no model, semantic inference, network, or approvals. */
const {create,norm}=require('./pipeline.js');
const crypto=require('node:crypto');globalThis.crypto??=crypto.webcrypto;
const clone=x=>JSON.parse(JSON.stringify(x));
const subject=s=>s==='ENT'?'Otorhinolaryngology':s;
const need=(ok,message)=>{if(!ok)throw Error(message)};
function open(data,saved){
 const a=create(data,saved);const valid=Object.keys(a.state.verifications||{}).filter(id=>a.verification(id));
 const changes=[];
 for(const c of a.state.registry){if(c.subject==='ENT'){changes.push({concept_id:c.concept_id,from:'ENT',to:'Otorhinolaryngology'});c.subject=subject(c.subject)}c.concept_family_id??=null;}
 for(const m of Object.values(a.state.mappings))if(m.subject==='ENT'){changes.push({question_id:m.question_id,from:'ENT',to:'Otorhinolaryngology'});m.subject=subject(m.subject)}
 a.state.concept_families??=[];
 if(changes.length){a.state.normalization_history??=[];a.state.normalization_history.push({action:'canonical-subject-alias',changes});for(const id of valid){let v=a.state.verifications[id];v.subject=subject(v.subject);v.revision=a.revision(id);v.registry_revision=a.registryRevision();}}
 return a;
}
function familyPacket(a){return a.state.registry.map(c=>({concept_id:c.concept_id,canonical_concept_name:c.canonical_concept_name,subject:subject(c.subject),...(c.aliases?.length?{aliases:[...c.aliases]}:{})}));}
function importFamilies(a,packet){return a.importFamilies(packet)}

function verificationPacket(a,data,ids){const selected=new Set(ids);need(selected.size===ids.length,'Duplicate batch IDs');return {version:1,registry_revision:a.registryRevision(),registry:clone(a.state.registry),questions:ids.map(id=>{const q=data.questions.find(q=>q.id===id);need(q&&a.state.mappings[id],'Unknown mapped question');return {...a.packet(q,true),images:q.images||[],pass1:a.pass1(id),revision:a.revision(id)}})};}
function importClassified(a,data,packet){
 const rows=clone(Array.isArray(packet)?packet:packet.mappings);need(Array.isArray(rows)&&rows.length,'Expected classified records');for(const r of rows){need(!a.state.mappings[r.question_id],'Existing mappings cannot be overwritten');r.subject=subject(r.subject);}
 // Work on a copy, so any failure is atomic.
 const next=open(data,a.state),valid=Object.keys(next.state.verifications||{}).filter(id=>next.verification(id));next.importMappings(rows);
 for(const r of rows){const m=next.state.mappings[r.question_id];let c=next.match(r.subject,r.primary_concept)||next.match(r.subject,r.primary_concept,false);
  if(!c){next.review(r.question_id,'create',r.subject,r.primary_concept);c=next.get(next.state.mappings[r.question_id].concept_id);c.concept_family_id=null;}
  next.state.mappings[r.question_id]={...m,concept_id:c.concept_id};delete next.state.mappings[r.question_id].proposed_concept;
 }
 for(const id of valid)next.state.verifications[id].registry_revision=next.registryRevision();
 next.state.import_history??=[];next.state.import_history.push({action:'external-draft-import',supplied_records:clone(Array.isArray(packet)?packet:packet.mappings)});
 Object.keys(a.state).forEach(k=>delete a.state[k]);Object.assign(a.state,next.state);
 return verificationPacket(a,data,rows.map(r=>r.question_id));
}
function dataset(packet){
 need(packet.version===1&&typeof packet.dataset_id==='string'&&/^[a-z0-9-]+$/.test(packet.dataset_id)&&Array.isArray(packet.questions)&&packet.questions.length,'Invalid dataset');
 const seen=new Set();const questions=packet.questions.map(q=>{need(typeof q.question_id==='string'&&q.question_id.startsWith(packet.dataset_id+':')&&!seen.has(q.question_id),'Use unique dataset-prefixed question IDs');seen.add(q.question_id);need(['stem','correct_answer','explanation'].every(k=>typeof q[k]==='string')&&typeof q.image_dependent==='boolean','Missing classifier fields');return {...q,id:q.question_id,options:q.options||[],images:q.images||[]};});
 return {version:1,dataset_id:packet.dataset_id,platform:packet.platform||packet.dataset_id,questions};
}
function publish(a,data,bindings){
 need(bindings.version===1&&Array.isArray(bindings.tests),'Payload bindings required');
 need(a.state.registry.every(c=>c.concept_family_id&&a.state.concept_families.some(f=>f.concept_family_id===c.concept_family_id)),'Family assignments incomplete');
 const tests=[],seen=new Set(),uuids=new Set();for(const b of bindings.tests){need(!seen.has(b.source_test_id),'Duplicate test binding');seen.add(b.source_test_id);const qs=data.questions.filter(q=>q.test_id===b.source_test_id).sort((x,y)=>x.position-y.position);
  need(qs.length&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.source_test_uuid)&&!uuids.has(b.source_test_uuid)&&/^[0-9a-f]{64}$/.test(b.payload_sha256)&&Array.isArray(b.question_ids)&&qs.length===b.question_ids.length,'Invalid test binding');
  need(qs.every((q,i)=>q.position===i+1&&q.source_question_id===b.question_ids[i]),'Payload question identity/order mismatch');
  uuids.add(b.source_test_uuid);tests.push({source_test_id:b.source_test_id,source_test_uuid:b.source_test_uuid,payload_sha256:b.payload_sha256,title:qs[0].test,questions:qs.map(q=>{let m=a.state.mappings[q.id],v=a.view(q);need(m&&v?.concept_id,'Missing mapping');return {question_id:q.id,source_question_id:q.source_question_id,position:q.position,subject:subject(m.subject),concept_id:v.concept_id,route:a.verification(q.id)?.route||'PENDING_VERIFICATION'};})});
 }
 need(tests.reduce((n,t)=>n+t.questions.length,0)===data.questions.length,'Bind every GT exactly once');
 return {version:1,platform:data.platform,registry_revision:a.registryRevision(),status:'draft',families:a.state.concept_families.map(({concept_family_id,canonical_family_name,subject,system,status})=>({concept_family_id,canonical_family_name,subject,system,status})),concepts:a.state.registry.map(c=>({concept_id:c.concept_id,canonical_concept_name:c.canonical_concept_name,subject:c.subject,concept_family_id:c.concept_family_id,status:c.status,...(a.state.family_assignments?.[c.concept_id]?.confidence!==undefined?{family_confidence:a.state.family_assignments[c.concept_id].confidence,family_needs_review:a.state.family_assignments[c.concept_id].needs_review}:{})})),tests};
}
module.exports={open,familyPacket,importFamilies,verificationPacket,importClassified,dataset,publish};
