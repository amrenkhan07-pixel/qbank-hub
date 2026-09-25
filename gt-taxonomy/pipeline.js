/* Local staging only. No network, learner state, or medical classifier. */
(function(root){
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w&&!['of','the','a','an'].includes(w)).sort().join(' ');
function create(data,saved,legacy={}){
 const state=saved?JSON.parse(JSON.stringify(saved)):{registry:[],mappings:{}};
 if(!saved)for(const q of data.questions){const m=legacy[q.id]||q.mapping;if(!m)continue;
  let c=state.registry.find(c=>c.concept_id===m.concept_id);
  if(!c){c={concept_id:m.concept_id,canonical_concept_name:m.concept,subject:m.subject,topic:m.topic,aliases:[],status:'draft'};state.registry.push(c)}
  state.mappings[q.id]={question_id:q.id,subject:m.subject,concept_id:c.concept_id,confidence:null,needs_review:m.status==='review',classification_source:legacy[q.id]?'legacy-local':'preserved-pilot',status:'draft'};
 }
 const rawGet=id=>state.registry.find(c=>c.concept_id===id)||state.registry_archive?.[id];
 const get=id=>rawGet(canonicalId(id));
 function match(subject,name,approved=true){const hits=state.registry.filter(c=>(!approved||c.status==='approved')&&norm(c.subject)===norm(subject)&&[c.canonical_concept_name,...c.aliases].some(n=>norm(n)===norm(name)));return hits.length===1?hits[0]:null}
 function similar(subject,name){const words=new Set(norm(name).split(' '));return state.registry.filter(c=>!subject||norm(c.subject)===norm(subject)).map(c=>({c,score:norm(c.canonical_concept_name).split(' ').filter(w=>words.has(w)).length})).sort((a,b)=>b.score-a.score).slice(0,12).map(x=>x.c)}
 // Suggestions never assert clinical equivalence. Preserve objective words and negation.
 function wording(name){return String(name||'').normalize('NFKC').toLowerCase().replace(/^(identify|recognize|recognise|distinguish|explain|select|recall|assess|interpret|determine|calculate|predict|infer|estimate)\s+/,'').replace(/\b(tumour|tumours)\b/g,'tumor').replace(/\b(paediatric|pediatric)\b/g,'paediatric').replace(/\b(haemorrhagic|hemorrhagic)\b/g,'hemorrhagic').replace(/\b(aetiology|etiology)\b/g,'etiology').replace(/\b(oestrogen|estrogen)\b/g,'estrogen').replace(/\b(ultrasonography|ultrasound)\b/g,'ultrasound').replace(/\b(histological|histologic)\b/g,'histologic').replace(/\b(radiological|radiologic)\b/g,'radiologic').replace(/\b(carcinoma|cancer)\b/g,'cancer').replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w&&!['a','an','the','of','and','in','for','with','to'].includes(w)).sort().join(' ')}
 function relation(a,b){
  if(norm(a.subject)!==norm(b.subject))return null;
  const aa=[a.canonical_concept_name,...(a.aliases||[])],bb=[b.canonical_concept_name,...(b.aliases||[])];
  if(aa.some(x=>bb.some(y=>norm(x)===norm(y))))return {kind:'EXACT_ALIAS',score:1,reason:'Same-subject exact normalized canonical name or recorded alias.'};
  let score=0,equivalent=false;
  for(const x of aa)for(const y of bb){const nx=wording(x),ny=wording(y);if(nx&&nx===ny)equivalent=true;const xs=new Set(nx.split(' ')),ys=new Set(ny.split(' '));const overlap=[...xs].filter(w=>ys.has(w)).length;score=Math.max(score,overlap/(new Set([...xs,...ys]).size||1))}
  const family=s=>s.includes(':')?wording(s.split(':')[0]):'';
  const sameFamily=family(a.canonical_concept_name)&&family(a.canonical_concept_name)===family(b.canonical_concept_name);
  if(equivalent||score>=.8)return {kind:'REUSE_CANDIDATE',score,reason:'Strong wording/synonym overlap; confirm identical tested objective and granularity before merging.'};
  if(sameFamily||score>=.25)return {kind:'KEEP_SEPARATE',score,reason:sameFamily?'Shared named condition, different objective wording; keep separate unless equivalence is established.':'Partial terminology overlap only; insufficient evidence of the same tested idea.'};
  return null;
 }
 function reuseCandidates(subject,name){const proposal={subject,canonical_concept_name:name,aliases:[]};return state.registry.map(c=>({c,relation:relation(proposal,c)})).filter(x=>x.relation).sort((a,b)=>b.relation.score-a.relation.score).map(x=>({concept_id:x.c.concept_id,canonical_concept_name:x.c.canonical_concept_name,...x.relation}))}
 function dedupCandidates(){const out=[];for(let i=0;i<state.registry.length;i++)for(let j=i+1;j<state.registry.length;j++){const a=state.registry[i],b=state.registry[j],r=relation(a,b);if(r)out.push({left_id:a.concept_id,right_id:b.concept_id,left:a.canonical_concept_name,right:b.canonical_concept_name,subject:a.subject,...r})}return out.sort((a,b)=>b.score-a.score)}
 function canonicalId(id){const seen=new Set();while(state.concept_redirects?.[id]){if(seen.has(id))throw Error('Cyclic concept redirect');seen.add(id);id=state.concept_redirects[id]}return id}
 function deduplicateExact(){
  const candidates=dedupCandidates(),merges=[];
  const valid=Object.keys(state.verifications||{}).filter(id=>verification(id));
  for(const pair of candidates.filter(c=>c.kind==='EXACT_ALIAS')){
   let a=get(canonicalId(pair.left_id)),b=get(canonicalId(pair.right_id));if(!a||!b||a===b)continue;
   if(a.status!=='approved'&&b.status==='approved')[a,b]=[b,a];
   const old=JSON.parse(JSON.stringify(b));state.registry_archive||={};state.registry_archive[b.concept_id]=old;
   a.aliases=[...new Set([...(a.aliases||[]),b.canonical_concept_name,...(b.aliases||[])])].filter(n=>n!==a.canonical_concept_name);
   state.concept_redirects||={};state.concept_redirects[b.concept_id]=a.concept_id;
   state.registry=state.registry.filter(c=>c.concept_id!==b.concept_id);
   merges.push({from:b.concept_id,to:a.concept_id,original_name:b.canonical_concept_name,canonical_name:a.canonical_concept_name,reason:pair.reason});
  }
  if(merges.length){const carried=[];for(const id of valid){const v=state.verifications[id];carried.push({question_id:id,revision:v.revision,registry_revision:v.registry_revision});v.revision=revision(id);v.registry_revision=registryRevision()}state.reuse_history||=[];state.reuse_history.push({action:'exact-alias-dedup',merges,verification_revisions:carried})}
  return {merges,unresolved:candidates.filter(c=>c.kind!=='EXACT_ALIAS')};
 }

 function packet(q,options=false){const p={question_id:q.id,stem:q.stem,correct_answer:q.correct_answer??(q.options||[]).filter(o=>o.correct).map(o=>`${o.label}. ${o.text}`).join('\n'),explanation:q.explanation??'',image_dependent:!!(q.image_dependent||(q.images||[]).length)};if(options)p.options=q.options;return p}
 function unresolved(limit=50,questions=data.questions){return questions.filter(q=>!state.mappings[q.id]).slice(0,Math.min(100,Math.max(1,limit))).map(q=>packet(q))}
 function importMappings(input){const rows=Array.isArray(input)?input:input.mappings;if(!Array.isArray(rows)||!rows.length)throw Error('Expected a nonempty mappings array');const next={},seen=new Set(),reuseEvents=[],suggestions={};for(const r of rows){if(!data.questions.some(q=>q.id===r.question_id)||seen.has(r.question_id)||!['subject','primary_concept'].every(k=>typeof r[k]==='string'&&r[k].trim())||typeof r.confidence!=='number'||!Number.isFinite(r.confidence)||r.confidence<0||r.confidence>1||typeof r.needs_review!=='boolean'||(r.subtopic_hint!==undefined&&typeof r.subtopic_hint!=='string'))throw Error('Invalid or duplicate mapping; confidence must be 0–1');if(state.mappings[r.question_id]?.status==='approved')throw Error('Cannot overwrite an approved mapping');seen.add(r.question_id);const c=match(r.subject,r.primary_concept)||match(r.subject,r.primary_concept,false);next[r.question_id]={question_id:r.question_id,primary_concept:r.primary_concept,subject:r.subject,...(c?{concept_id:c.concept_id}:{proposed_concept:r.primary_concept}),confidence:r.confidence,needs_review:r.needs_review,classification_source:c?'import-'+c.status+'-registry':'chatgpt-import',status:'draft',...(r.subtopic_hint?{subtopic_hint:r.subtopic_hint}:{})};if(c)reuseEvents.push({action:'exact-alias-reuse',question_id:r.question_id,original_name:r.primary_concept,concept_id:c.concept_id});else suggestions[r.question_id]=reuseCandidates(r.subject,r.primary_concept)}Object.assign(state.mappings,next);state.reuse_candidates||={};for(const id of Object.keys(next)){delete state.reuse_candidates[id];if(suggestions[id]?.length)state.reuse_candidates[id]=suggestions[id]}if(reuseEvents.length){state.reuse_history||=[];state.reuse_history.push(...reuseEvents)}}
 function review(id,action,subject,name,target){if(!data.questions.some(q=>q.id===id))throw Error('Unknown question');let m=state.mappings[id]||{question_id:id,confidence:null};if(action==='review'){state.mappings[id]={...m,needs_review:true,status:'draft',classification_source:'human-review'};return}
  if(!subject.trim()||!name.trim())throw Error('Subject and concept are required');let c;
  if(action==='merge'){c=get(target);if(!c||norm(c.subject)!==norm(subject))throw Error('Choose a concept in the same subject');const other=match(subject,name,false);if(other&&other.concept_id!==c.concept_id)throw Error('Name belongs to another registry entry; edit the proposal before linking');if(norm(name)!==norm(c.canonical_concept_name)&&!c.aliases.includes(name))c.aliases.push(name)}
  else c=match(subject,name)||match(subject,name,false);
  if(!['approve','edit','merge','create'].includes(action))throw Error('Unknown action');
  if(!c&&action!=='edit'){c={concept_id:'concept-'+crypto.randomUUID(),canonical_concept_name:name.trim(),subject:subject.trim(),aliases:[],status:'draft'};state.registry.push(c)}
  if(c&&['approve','merge'].includes(action))c.status='approved';
  state.mappings[id]={question_id:id,subject:c?.subject||subject.trim(),...(c?{concept_id:c.concept_id}:{proposed_concept:name.trim()}),confidence:m.confidence,needs_review:action==='edit'?!!m.needs_review:false,classification_source:'human-'+action,status:['approve','merge'].includes(action)?'approved':'draft'};
 }
 // Verification is a sidecar: supplied Pass 1 fields and approval are immutable here.
 const hash=value=>{let h=14695981039346656037n;for(const c of JSON.stringify(value)){h^=BigInt(c.codePointAt(0));h=BigInt.asUintN(64,h*1099511628211n)}return h.toString(16)};
 function pass1(id){const m=state.mappings[id];return m?{question_id:id,subject:m.subject,primary_concept:m.primary_concept||m.proposed_concept||rawGet(m.concept_id)?.canonical_concept_name,confidence:m.confidence,needs_review:m.needs_review}:null}
 function revision(id){const q=data.questions.find(q=>q.id===id);return hash([q&&packet(q,true),q?.images,state.mappings[id],taxonomyRecord(rawGet(state.mappings[id]?.concept_id))])}
 const taxonomyRecord=c=>{if(!c)return c;const {concept_family_id,...taxonomy}=c;return taxonomy};
 function registryRevision(){return hash(state.registry.map(taxonomyRecord))}
 function verification(id){const v=state.verifications?.[id];return v&&v.revision===revision(id)&&v.registry_revision===registryRevision()?v:null}
 function exportVerification(limit=50,questions=data.questions){return {version:1,registry_revision:registryRevision(),registry:JSON.parse(JSON.stringify(state.registry)),questions:questions.filter(q=>state.mappings[q.id]&&state.mappings[q.id].classification_source!=='preserved-pilot'&&!verification(q.id)).slice(0,Math.min(100,Math.max(1,limit))).map(q=>({...packet(q,true),images:q.images||[],pass1:pass1(q.id),revision:revision(q.id)}))}}
 function importVerification(input,{dryRun=false}={}){
  if(input?.version!==1||input.registry_revision!==registryRevision()||!Array.isArray(input.results)||!input.results.length)throw Error('Invalid verifier batch or stale registry; export again');
  const next={},seen=new Set();
  for(const r of input.results){
   const m=state.mappings[r.question_id],p=pass1(r.question_id);
   if(!m||seen.has(r.question_id)||r.revision!==revision(r.question_id))throw Error('Unknown, duplicate or stale verifier result');
   seen.add(r.question_id);
   if(!['subject_ok','concept_ok','granularity_ok','registry_checked','source_issue','image_required','image_evidence_sufficient'].every(k=>typeof r[k]==='boolean')||!r.registry_checked||typeof r.confidence!=='number'||!Number.isFinite(r.confidence)||r.confidence<0||r.confidence>1||!['subject','primary_concept','reason'].every(k=>typeof r[k]==='string'&&r[k].trim())||!(r.reuse_concept_id===null||typeof r.reuse_concept_id==='string'))throw Error('Incomplete verifier checks');
   const target=r.reuse_concept_id===null?null:get(r.reuse_concept_id);
   if(r.reuse_concept_id!==null&&(!target||norm(target.subject)!==norm(r.subject)))throw Error('Invalid canonical reuse target');
   const sameConcept=norm(r.primary_concept)===norm(p.primary_concept)||!!target;
   const accepted=r.subject_ok&&r.concept_ok&&r.granularity_ok&&norm(r.subject)===norm(p.subject)&&sameConcept&&typeof p.confidence==='number'&&p.confidence>=.9&&r.confidence>=.9&&(!r.image_required||r.image_evidence_sufficient);
   next[r.question_id]={...JSON.parse(JSON.stringify(r)),registry_revision:input.registry_revision,classification:accepted?'AUTO_ACCEPT':'CLASSIFICATION_REVIEW',source_flags:r.source_issue?['SOURCE_ISSUE']:[],route:accepted?(r.source_issue?'SOURCE_ISSUE':'AUTO_ACCEPT'):'CLASSIFICATION_REVIEW',canonical_concept_id:accepted?(target?.concept_id||m.concept_id||null):null};
  }
  if(!dryRun){state.verifications||={};Object.assign(state.verifications,next)}
  return {counts:Object.values(next).reduce((a,v)=>(a[v.route]++,a),{AUTO_ACCEPT:0,SOURCE_ISSUE:0,CLASSIFICATION_REVIEW:0}),results:next,reuse_candidates:Object.values(next).filter(v=>v.classification==='AUTO_ACCEPT'&&v.reuse_concept_id&&v.reuse_concept_id!==state.mappings[v.question_id].concept_id).map(v=>({question_id:v.question_id,concept_id:v.reuse_concept_id}))};
 }
 function classificationBatch(limit=50,questions=data.questions){return {version:1,registry:JSON.parse(JSON.stringify(state.registry)),questions:unresolved(limit,questions).map(r=>packet(data.questions.find(q=>q.id===r.question_id),true))}}

 function view(q){const m=state.mappings[q.id];if(!m)return null;const v=verification(q.id),c=get(v?.canonical_concept_id||m.concept_id);return {...m,concept_id:canonicalId(v?.canonical_concept_id||m.concept_id),verification:v,concept:c?.canonical_concept_name||m.proposed_concept||'',topic:state.concept_families?.find(f=>f.concept_family_id===c?.concept_family_id)?.canonical_family_name||c?.topic||'',concept_family_id:c?.concept_family_id||null,system:state.concept_families?.find(f=>f.concept_family_id===c?.concept_family_id)?.system||null,status:v?(v.classification==='CLASSIFICATION_REVIEW'?'review':v.route):(m.needs_review?'review':m.status)}}

 function normalizeSubjectAliases(){
  const valid=Object.keys(state.verifications||{}).filter(id=>verification(id)),changes=[];
  for(const c of state.registry)if(c.subject==='ENT'){changes.push({concept_id:c.concept_id,from:'ENT',to:'Otorhinolaryngology'});c.subject='Otorhinolaryngology'}
  for(const m of Object.values(state.mappings))if(m.subject==='ENT'){changes.push({question_id:m.question_id,from:'ENT',to:'Otorhinolaryngology'});m.subject='Otorhinolaryngology'}
  if(changes.length){state.normalization_history||=[];state.normalization_history.push({action:'canonical-subject-alias',changes});for(const id of valid){const v=state.verifications[id];if(v.subject==='ENT')v.subject='Otorhinolaryngology';v.revision=revision(id);v.registry_revision=registryRevision()}}
 }
 function familyPacket(){return state.registry.map(c=>({concept_id:c.concept_id,canonical_concept_name:c.canonical_concept_name,subject:c.subject,...(c.aliases?.length?{aliases:[...c.aliases]}:{})}))}
 function importFamilies(packet){
 const a={state,get,registryRevision};const clone=x=>JSON.parse(JSON.stringify(x)),subject=s=>s==='ENT'?'Otorhinolaryngology':s,need=(ok,message)=>{if(!ok)throw Error(message)};

 need(packet.version===1&&packet.registry_revision===a.registryRevision(),'Stale or invalid family packet');
 need(Array.isArray(packet.families)&&Array.isArray(packet.assignments),'Expected families and assignments');
 const families=clone(packet.families),ids=new Set(),names=new Set();
 for(const f of families){need(typeof f.concept_family_id==='string'&&f.concept_family_id.trim()&&!ids.has(f.concept_family_id),'Duplicate or missing family ID');ids.add(f.concept_family_id);
  need(typeof f.canonical_family_name==='string'&&f.canonical_family_name.trim()&&typeof f.subject==='string'&&f.subject.trim(),'Family name and subject required');f.subject=subject(f.subject);
  need((f.system===undefined||f.system===null||typeof f.system==='string')&&Array.isArray(f.aliases)&&f.aliases.every(x=>typeof x==='string'&&x.trim())&&f.status==='draft','Families require aliases, optional system, and draft status');
  const key=norm(f.subject)+'|'+norm(f.system)+'|'+norm(f.canonical_family_name);need(!names.has(key),'Duplicate normalized family');names.add(key);
 }
 const links=new Map();for(const r of packet.assignments){const c=a.get(r.concept_id),f=families.find(x=>x.concept_family_id===r.concept_family_id);need(c&&f&&!links.has(r.concept_id),'Unknown or duplicate concept assignment');need(subject(c.subject)===f.subject,'Cross-subject family assignment');if('confidence' in r || 'needs_review' in r){need(r.subject===c.subject&&r.system===f.system&&r.concept_family===f.canonical_family_name,'Family classification metadata mismatch');need(Number.isFinite(r.confidence)&&r.confidence>=0&&r.confidence<=1&&typeof r.needs_review==='boolean','Invalid family confidence/review flag');}links.set(r.concept_id,r.concept_family_id);}
 need(links.size===a.state.registry.length&&a.state.registry.every(c=>links.has(c.concept_id)),'Assign every canonical concept exactly once');
 // Validate first; no question mappings or canonical identities change.
 a.state.family_history??=[];a.state.family_history.push({previous_families:clone(a.state.concept_families),previous_assignments:a.state.registry.map(c=>({concept_id:c.concept_id,concept_family_id:c.concept_family_id})),supplied:clone(packet)});
 a.state.family_assignments=Object.fromEntries(packet.assignments.map(r=>[r.concept_id,clone(r)]));
 a.state.concept_families=families;for(const c of a.state.registry)c.concept_family_id=links.get(c.concept_id);
 return {families:families.length,assigned:links.size};

 }
 normalizeSubjectAliases();
 state.concept_families||=[];
 return {familyPacket,importFamilies,normalizeSubjectAliases,state,get,match,similar,packet,unresolved,importMappings,review,view,pass1,revision,registryRevision,verification,exportVerification,importVerification,classificationBatch,reuseCandidates,dedupCandidates,deduplicateExact,canonicalId};
}
root.AtlasPipeline={create,norm};if(typeof module!=='undefined')module.exports=root.AtlasPipeline;
})(globalThis);
