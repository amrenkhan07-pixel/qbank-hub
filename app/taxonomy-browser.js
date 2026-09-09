import { db, initError, requireUser } from './supabase.js';

const els = Object.fromEntries(['version-line','auth-message','error-message','summary','taxonomy-tree','tree-search','expand-all','collapse-all','sample-size','metrics','issues','sample-subject','sample-status','sample-rows','table-note'].map((id)=>[id,document.getElementById(id)]));
let taxonomyNodes=[];
let sample=[];

function showError(message){els['error-message'].textContent=message;els['error-message'].hidden=false;}
function metric(value,label){const card=document.createElement('div');card.className='metric';const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;card.append(strong,span);return card;}
function pct(value,total){return total?`${Math.round(value*1000/total)/10}%`:'0%';}

function renderTree(query=''){
  const root=els['taxonomy-tree'];root.replaceChildren();
  const normalized=query.trim().toLowerCase();
  const byParent=new Map();
  taxonomyNodes.forEach((node)=>{const key=node.parent_id||'root';if(!byParent.has(key))byParent.set(key,[]);byParent.get(key).push(node);});
  const matches=(node)=>!normalized||node.path.toLowerCase().includes(normalized);
  const descendantsMatch=(node)=>matches(node)||(byParent.get(node.id)||[]).some(descendantsMatch);
  const build=(node)=>{
    const children=(byParent.get(node.id)||[]).filter(descendantsMatch).sort((a,b)=>a.sort_order-b.sort_order||a.name.localeCompare(b.name));
    if(!children.length){const leaf=document.createElement('div');leaf.className='leaf';leaf.append(label(node));return leaf;}
    const details=document.createElement('details');details.open=Boolean(normalized)||node.type==='subject';const summary=document.createElement('summary');summary.append(label(node));details.append(summary,...children.map(build));return details;
  };
  function label(node){const frag=document.createDocumentFragment();const type=document.createElement('span');type.className='node-type';type.textContent=node.type;const name=document.createElement('span');name.className='node-name';name.textContent=node.name;const path=document.createElement('span');path.className='node-path';path.title=node.path;path.textContent=node.path;frag.append(type,name,path);return frag;}
  const roots=(byParent.get('root')||[]).filter(descendantsMatch).sort((a,b)=>a.sort_order-b.sort_order||a.name.localeCompare(b.name));
  if(!roots.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No node or path matches this search.';root.append(empty);return;}
  root.append(...roots.map(build));
}

function classifyStatus(row){if(Number(row.classifier_confidence)===0)return'unclassifiable';if(row.ambiguity||row.cross_subject_ambiguity)return'ambiguous';if(Number(row.classifier_confidence)>=.8)return'high';return'review';}
function renderSample(){
  const subject=els['sample-subject'].value,status=els['sample-status'].value;
  const shown=sample.filter((row)=>(!subject||row.existing_subject===subject)&&(!status||classifyStatus(row)===status));
  const body=els['sample-rows'];body.replaceChildren();
  for(const row of shown){
    const tr=document.createElement('tr');
    const questionId=document.createElement('td');questionId.textContent=row.question_id;
    const source=document.createElement('td');source.textContent=`${row.platform}${row.source_test?` · ${row.source_test}`:''}${row.is_pyq?' · PYQ':''}`;
    const existing=document.createElement('td');existing.textContent=row.existing_subject;
    const system=document.createElement('td');system.textContent=row.proposed_system||'—';
    const topic=document.createElement('td');topic.textContent=row.proposed_topic||'—';
    const subtopic=document.createElement('td');subtopic.textContent=row.proposed_subtopic||'—';
    const path=document.createElement('td');path.className='path';path.textContent=row.proposed_path||'Unclassifiable in draft';
    const confidence=document.createElement('td');confidence.className='confidence';confidence.textContent=pct(Number(row.classifier_confidence),1);
    const flags=document.createElement('td');const state=classifyStatus(row);
    if(state==='high'){const f=document.createElement('span');f.className='flag high';f.textContent='High confidence';flags.append(f);}
    if(row.ambiguity){const f=document.createElement('span');f.className='flag';f.textContent='Ambiguous';flags.append(f);}
    if(row.cross_subject_ambiguity){const f=document.createElement('span');f.className='flag cross';f.textContent='Cross-subject';flags.append(f);}
    if(row.secondary_concept){const secondary=document.createElement('div');secondary.textContent=`Secondary: ${row.secondary_concept}`;flags.append(secondary);}
    const evidence=document.createElement('td');evidence.textContent=row.reason;
    tr.append(questionId,source,existing,system,topic,subtopic,path,confidence,flags,evidence);body.append(tr);
  }
  if(!shown.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=10;td.className='muted';td.textContent='No sample rows match these review filters.';tr.append(td);body.append(tr);}
  els['table-note'].textContent=`Showing ${shown.length} of ${sample.length} deterministic sample questions. Question stems are intentionally not downloaded by this browser.`;
}

function renderMetrics(){
  const total=sample.length,high=sample.filter((r)=>classifyStatus(r)==='high').length,ambiguous=sample.filter((r)=>r.ambiguity).length,unclassifiable=sample.filter((r)=>Number(r.classifier_confidence)===0).length,cross=sample.filter((r)=>r.cross_subject_ambiguity).length;
  els.metrics.replaceChildren(metric(pct(high,total),'High confidence'),metric(pct(ambiguous,total),'Ambiguous'),metric(pct(unclassifiable,total),'Unclassifiable'),metric(pct(cross,total),'Cross-subject ambiguity'));
  const bySubject=new Map();sample.forEach((r)=>{const value=bySubject.get(r.existing_subject)||{total:0,unclassified:0};value.total++;if(Number(r.classifier_confidence)===0)value.unclassified++;bySubject.set(r.existing_subject,value);});
  const gaps=[...bySubject].filter(([,v])=>v.unclassified/v.total>=.35).sort((a,b)=>b[1].unclassified/b[1].total-a[1].unclassified/a[1].total).slice(0,6);
  els.issues.replaceChildren();const h=document.createElement('h3');h.textContent='Draft review signals';const ul=document.createElement('ul');
  const messages=gaps.length?gaps.map(([name,v])=>`${name}: ${pct(v.unclassified,v.total)} unclassifiable; review missing branches or phrase evidence.`):['No subject crossed the 35% unclassifiable review threshold.'];
  messages.push('Subtopic proposals remain intentionally blank when only topic-level evidence is present.');
  messages.forEach((text)=>{const li=document.createElement('li');li.textContent=text;ul.append(li);});els.issues.append(h,ul);
}

async function init(){
  if(initError||!db){showError(initError||'Supabase client is unavailable.');return;}
  const user=await requireUser();
  if(!user){els['auth-message'].hidden=false;els['auth-message'].textContent='Sign in to QBank Hub first, then return to this internal review page.';return;}
  const [{data:review,error:reviewError},{data:rows,error:sampleError}]=await Promise.all([
    db.rpc('qbank_taxonomy_review',{p_version_key:'canonical-medical-v1'}),
    db.rpc('qbank_taxonomy_classification_dry_run',{p_version_key:'canonical-medical-v1',p_limit:380}),
  ]);
  if(reviewError||sampleError){showError(reviewError?.message||sampleError?.message||'Review data could not be loaded.');return;}
  taxonomyNodes=review?.nodes||[];sample=rows||[];
  els['version-line'].replaceChildren();const version=document.createElement('span');version.textContent=review.version.name;const badge=document.createElement('span');badge.className='status';badge.textContent=review.version.status;els['version-line'].append(version,badge);
  const labels=[['subject','Subjects'],['system','Systems'],['topic','Topics'],['subtopic','Subtopics']];els.summary.replaceChildren(...labels.map(([key,label])=>metric(review.counts[key]||0,label)));
  renderTree();
  els['sample-size'].textContent=`${sample.length} questions`;
  const subjects=[...new Set(sample.map((r)=>r.existing_subject))].sort();for(const name of subjects){const option=document.createElement('option');option.value=name;option.textContent=name;els['sample-subject'].append(option);}
  renderMetrics();renderSample();
}

els['tree-search'].addEventListener('input',(event)=>renderTree(event.target.value));
els['expand-all'].addEventListener('click',()=>els['taxonomy-tree'].querySelectorAll('details').forEach((el)=>{el.open=true;}));
els['collapse-all'].addEventListener('click',()=>els['taxonomy-tree'].querySelectorAll('details').forEach((el)=>{el.open=false;}));
els['sample-subject'].addEventListener('change',renderSample);els['sample-status'].addEventListener('change',renderSample);
init().catch((error)=>showError(error.message||String(error)));
