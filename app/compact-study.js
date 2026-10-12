import {studyIcon,subjectIcon} from './study-icons.js';
// Presentation adapter over existing form controls and study actions. No data queries.
export function compactStudy(form,{meta,e,practice,resume}) {
 if (!form || !['practice-form','test-form'].includes(form.id)) return;
 form.classList.add('compact-study');
 const fields=form.querySelector('.filters');
 const advanced=document.createElement('details');advanced.className='study-advanced';advanced.innerHTML='<summary>More filters</summary><div class="filters"></div>';
 const optional=advanced.querySelector('.filters');
 for(const child of [...fields.children])if(!['platforms','subjects','source_tests'].includes(child.dataset.multiField)&&!child.classList.contains('status-field'))optional.append(child);
 fields.after(advanced);
 for(const name of ['platforms','subjects']){const field=form.querySelector(`[data-multi-field="${name}"]`);if(!field)continue;field.classList.add('study-tiles');const details=field.querySelector('details');details.open=true;details.querySelector('summary').hidden=true;field.querySelector('.multi-menu').classList.add('study-tile-grid');for(const row of field.querySelectorAll('.check-row')){const label=row.querySelector('span');if(label)label.insertAdjacentHTML('afterbegin',name==='subjects'?subjectIcon(label.textContent):studyIcon('book'));}}
 const marrow=meta.platforms?.find(p=>p.name.toLowerCase()==='marrow');
 if(marrow){
  form.dataset.marrowPlatform=marrow.id;
  const input=[...form.querySelectorAll('[name="platforms"]')].find(i=>i.value===marrow.id);
  const row=input?.closest('.check-row');
  if(row){row.querySelector('span').innerHTML=studyIcon('book')+'Marrow QBank';row.insertAdjacentHTML('afterend',`<a class="study-source-link" href="#/marrow-pyqs">${studyIcon('retry')}<span>Marrow PYQs</span></a>`);row.parentElement.prepend(row,row.nextElementSibling);}
 }
 const source=form.querySelector('[data-multi-field="source_tests"]');
 let page=0,sessions=[];const size=12;
 const host=document.createElement('section');host.className='study-modules';host.setAttribute('aria-label','Study modules');if(source){source.hidden=true;fields.after(host);}
 const selected=name=>[...form.querySelectorAll(`input[name="${name}"]:checked`)].map(x=>x.value);
 function paint(){
  const platforms=selected('platforms'),subjects=selected('subjects');const marrowSelected=marrow&&platforms.includes(marrow.id);const pyq=form.querySelector('[name=pyq]');if(pyq){pyq.closest('.field').hidden=!!marrowSelected;if(marrowSelected)pyq.value='no';else if(form.dataset.marrowWasSelected==='true')pyq.value='';}form.dataset.marrowWasSelected=String(!!marrowSelected);const subjectField=form.querySelector('[data-multi-field="subjects"]');if(subjectField)subjectField.hidden=!platforms.length;
  for(const name of ['systems','topics','subtopics']){const field=form.querySelector(`[data-multi-field="${name}"]`);if(field)field.hidden=!subjects.length||![...field.querySelectorAll('.check-row')].some(row=>!row.hidden);}
  if(!source)return;
  host.hidden=!subjects.length;if(host.hidden)return;
  const inputs=new Map([...source.querySelectorAll('input')].map(i=>[i.value,i]));
  const modules=meta.sourceTests.filter(t=>!(marrowSelected&&t.is_pyq)&&platforms.includes(String(t.platform_id))&&subjects.includes(String(t.subject_id))&&inputs.has(String(t.id))&&!inputs.get(String(t.id)).closest('.check-row').hidden);
  page=Math.min(page,Math.max(0,Math.ceil(modules.length/size)-1));
  host.innerHTML=`<div class="section-heading"><div><h2>Modules</h2><small>${modules.length} modules · Select several or practice one</small></div><span>${selected('source_tests').length} selected</span></div><div class="study-module-list">${modules.slice(page*size,page*size+size).map(t=>{
   const session=sessions.find(s=>s.filters?.source_tests?.length===1&&s.filters.source_tests[0]===t.id);const inProgress=session?.status==='in_progress';const total=t.declared_question_count==null?NaN:Number(t.declared_question_count);const score=session&&!inProgress&&Number(session.total_questions)>0?Math.round(Number(session.total_correct||0)/Number(session.total_questions)*100):null;
   return `<article class="study-module"><button type="button" class="module-select" data-module-select="${e(t.id)}" aria-pressed="${inputs.get(String(t.id)).checked}"><span class="module-selection" aria-hidden="true">${inputs.get(String(t.id)).checked?'✓':'+'}</span><span><b>${e(t.title)}</b><small>${e(meta.subjects.find(s=>s.id===t.subject_id)?.name||'')} · ${t.is_pyq?'PYQ':'QBank'}${Number.isFinite(total)?` · ${total} questions`:''}</small></span></button>${session?`<p class="module-performance">${inProgress?`In progress · Question ${Number(session.current_position||0)+1}/${session.total_questions}`:score!==null?`Last session: ${score}% correct · ${session.total_correct||0}/${session.total_questions}`:''}</p>`:''}<div class="module-actions">${inProgress?`<button type="button" class="button compact" data-module-resume="${e(session.id)}">${studyIcon('play')}Continue</button>`:''}${[['all','All'],['new','Unattempted'],['incorrect','Incorrect']].map(([key,label])=>`<button type="button" class="button secondary compact" data-module-action="${key}" data-module-id="${e(t.id)}">${studyIcon(key==='incorrect'?'retry':key==='new'?'star':'book')}${label}</button>`).join('')}</div></article>`;
  }).join('')||'<p class="empty">No modules match. Try a different question status or selection.</p>'}</div>${modules.length>size?`<div class="row study-pagination"><button type="button" class="button secondary" data-module-page="-1" ${page===0?'disabled':''}>Previous</button><span>${page+1} / ${Math.ceil(modules.length/size)}</span><button type="button" class="button secondary" data-module-page="1" ${(page+1)*size>=modules.length?'disabled':''}>Next</button></div>`:''}`;
 }
 host.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.moduleSelect){const input=[...source.querySelectorAll('input')].find(i=>i.value===button.dataset.moduleSelect);input.checked=!input.checked;input.dispatchEvent(new Event('change',{bubbles:true}));paint();return;}
  if(button.dataset.modulePage){page+=Number(button.dataset.modulePage);paint();return;}
  if(host.dataset.busy)return;host.dataset.busy='true';const label=button.textContent;button.disabled=true;button.textContent='Preparing…';
  try{if(button.dataset.moduleResume)await resume(button.dataset.moduleResume);else if(button.dataset.moduleAction)await practice(meta.sourceTests.find(t=>t.id===button.dataset.moduleId),button.dataset.moduleAction);}finally{delete host.dataset.busy;if(button.isConnected){button.disabled=false;button.textContent=label;}}
 });
 form.addEventListener('change',event=>{if(['platforms','subjects','statuses','pyq'].includes(event.target.name))page=0;paint();});
 form.addEventListener('study-facets-ready',paint);form.studySetSessions=rows=>{sessions=rows||[];paint();};paint();
}
