// Grand Test catalog, source browser and separate attempt analytics.
export function createGrandTests({ db, e, richHtml, safeUrl, decodePayloadObject, layout, startGT }) {
  const timeUsed = a => { const end=a.completed_at?Date.parse(a.completed_at):Date.now(); const minutes=Math.max(0,Math.floor((end-Date.parse(a.started_at))/60000)); return `${minutes} min elapsed`; };
  let catalogPromise;
  let generation = 0;
  const cancel = () => { generation++; };
  async function catalog() {
    if (!catalogPromise) catalogPromise = db.rpc('qbank_grand_test_catalog').then(({data,error}) => {
      if (error) { catalogPromise = null; throw error; }
      return data || [];
    });
    return catalogPromise;
  }
  const notice = (host, error) => { if (host.isConnected) host.innerHTML = `<div class="notice">Grand Tests could not load. ${e(error.message || 'Please try again.')}</div>`; };
  async function showCatalog(host) {
    const request = ++generation;
    host.innerHTML = '<div class="empty">Loading Grand Tests…</div>';
    try {
      const rows = await catalog(); if (!host.isConnected || request !== generation) return;
      const platforms = [...new Set(['Core BTR','Marrow','DAMS','PrepLadder',...rows.map(r=>r.platform)])];
      host.innerHTML = `<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">GRAND TESTS</span><h2>Choose a platform</h2></div><a class="button secondary" href="#/grand-test-analytics">Grand Test Analytics</a></div><div class="preset-grid">${platforms.map(p=>{const n=rows.filter(r=>r.platform===p).length;return `<button class="card preset-card" data-gt-platform="${e(p)}" ${n?'':'disabled'}><b>${e(p)}</b><span>${n?`${n} tests`:'Not available yet'}</span></button>`;}).join('')}</div><div data-gt-list></div></section>`;
      host.querySelectorAll('[data-gt-platform]').forEach(button=>button.addEventListener('click',()=>{
        const selected=rows.filter(r=>r.platform===button.dataset.gtPlatform);
        host.querySelector('[data-gt-list]').innerHTML=`<h3>${e(button.dataset.gtPlatform)}</h3><p class="subtle">Choose an exam-specific timed attempt, or browse questions and explanations.</p><ul class="list">${selected.map(t=>`<li><div><b>${e(t.title)}</b><div class="subtle">${Number(t.question_count)} questions</div></div><div class="row"><button class="button" data-gt-start="${e(t.test_id)}">GT mode</button><button class="button secondary" data-gt-open="${e(t.test_id)}">Browse</button></div></li>`).join('')}</ul>`;
        host.querySelectorAll('[data-gt-start]').forEach(b=>b.addEventListener('click',()=>{cancel();startGT(host,selected.find(t=>t.test_id===b.dataset.gtStart));}));
        host.querySelectorAll('[data-gt-open]').forEach(b=>b.addEventListener('click',()=>browse(host,selected.find(t=>t.test_id===b.dataset.gtOpen))));
      }));
    } catch(error) { if (request === generation) notice(host,error); }
  }
  function cleanText(value) {
    let text=String(value ?? '').replace(/[\u200b-\u200f\ufeff]/g,'');
    for(let i=0;i<3;i++) { const el=document.createElement('textarea');el.innerHTML=text;text=el.value; }
    return text;
  }
  async function browse(host,test) {
    const request = ++generation;
    host.innerHTML='<div class="empty">Loading selected Grand Test…</div>';
    try {
      const result=await db.from('qbank_payload_objects').select('object_path,sha256,compression,question_count').eq('source_test_id',test.test_id).eq('status','committed').limit(2);
      if(result.error) throw result.error;
      if(result.data?.length!==1) throw new Error('Unexpected Grand Test payload count.');
      const payload=await decodePayloadObject(result.data[0]);
      if(payload.source_test_id!==test.source_test_id || payload.platform!==test.platform || payload.questions.length!==Number(test.question_count)) throw new Error('Grand Test payload identity mismatch.');
      if(!host.isConnected || request !== generation) return;
      let index=0;
      const images=(items,alt)=>(items||[]).map(src=>{const url=safeUrl(src,true);return url?`<img class="question-image" src="${e(url)}" alt="${e(alt)}" loading="lazy" />`:'';}).join('');
      const media=(value,label)=>{const url=value&&safeUrl(value);return url?`<a class="button secondary compact" href="${e(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`:'';};
      function draw() {
        const occurrence=payload.questions[index],q=occurrence.source;
        host.innerHTML=`<section class="card builder-card"><div class="section-heading"><div><span class="eyebrow">${e(test.platform)} · GRAND TEST</span><h2>${e(test.title)}</h2></div><button class="button secondary" data-gt-back>Back to platforms</button></div><p class="subtle">Question ${index+1} of ${payload.questions.length} · Browse only</p><div class="question-stem">${e(q.raw_text || cleanText(q.text)).replaceAll('\n','<br>')}</div>${images(q.question_images,'Question illustration')}<div class="options">${q.options.map(o=>`<div class="option"><b>${e(o.label)}.</b><span>${e(cleanText(o.text))}</span></div>`).join('')}</div><details><summary>Show answer and explanation</summary><p><b>Correct answer:</b> ${e(q.correct_answer)}</p><div class="rich-content">${richHtml(cleanText(q.explanation))}</div>${images(q.explanation_images,'Explanation illustration')}<div class="row">${media(q.video,'Open video')}${media(q.audio,'Open audio')}</div></details><div class="question-actions gt-browse-actions"><button class="button secondary" data-gt-prev ${index?'':'disabled'}>Previous</button><label>Question <select data-gt-position aria-label="Question number">${payload.questions.map((_,i)=>`<option value="${i}" ${i===index?'selected':''}>${i+1}</option>`).join('')}</select></label><button class="button" data-gt-next ${index===payload.questions.length-1?'disabled':''}>Next</button></div></section>`;
        host.querySelector('[data-gt-prev]').onclick=()=>{if(index>0){index--;draw();}};
        host.querySelector('[data-gt-next]').onclick=()=>{if(index<payload.questions.length-1){index++;draw();}};
        host.querySelector('[data-gt-position]').onchange=event=>{index=Number(event.target.value);draw();};
        host.querySelector('[data-gt-back]').onclick=()=>showCatalog(host);
      }
      draw();
    } catch(error) {if (request === generation) notice(host,error);}
  }
  async function analytics() {
    const request = ++generation;
    layout('<div class="page-heading"><span class="eyebrow">GRAND TESTS</span><h1>Grand Test Analytics</h1><p>Your Grand Test attempts, separate from QBank practice.</p></div><section id="gt-analytics" class="card builder-card"><div class="empty">Loading…</div></section>');
    const host=document.querySelector('#gt-analytics');
    try {
      const rows=await catalog();if(!host.isConnected || request !== generation)return;
      host.innerHTML=`<div class="row"><label>Platform <select data-gt-filter-platform><option value="">All available platforms</option>${[...new Set(rows.map(r=>r.platform))].map(p=>`<option>${e(p)}</option>`).join('')}</select></label><label>Test <select data-gt-filter-test></select></label></div><div data-gt-history></div><a href="#/tests">Back to tests</a>`;
      const platform=host.querySelector('[data-gt-filter-platform]'),test=host.querySelector('[data-gt-filter-test]'),content=host.querySelector('[data-gt-history]');
      let page=0,historyRequest=0;
      async function history(){const query=++historyRequest;content.innerHTML='<p>Loading attempts…</p>';const {data,error}=await db.rpc('qbank_gt_history',{p_platform:platform.value||null,p_test:test.value||null,p_offset:page*50});if(!host.isConnected||request!==generation||query!==historyRequest)return;if(error){content.innerHTML=`<div class="notice">${e(error.message)}</div>`;return;}const attempts=data.items||[];content.innerHTML=attempts.length?`<p class="subtle">Attempt history · page ${page+1}. Accuracy uses correct ÷ (correct + incorrect). Compare scores within the same exam preset.</p><ul class="list">${attempts.map(a=>`<li><div><b>${e(a.title)}</b><small>${e(a.platform)} · ${e(a.preset.replaceAll('_',' '))} · ${e(new Date(a.started_at).toLocaleString())} · ${e(timeUsed(a))}</small>${a.result?`<p>${Number(a.result.score).toFixed(2)} / ${a.result.maximum_score} · ${a.result.correct} correct · ${a.result.incorrect} incorrect · ${a.result.unanswered} unanswered/unscored · accuracy ${a.result.accuracy==null?'—':a.result.accuracy+'%'}</p><details><summary>Section results</summary>${a.result.sections.map(s=>`<p>Section ${s.section+1}: ${s.correct} correct, ${s.incorrect} incorrect, ${s.unanswered} unanswered/unscored</p>`).join('')}</details>`:'<p>In progress — timer continues</p>'}</div><a class="button secondary" href="#/grand-test-attempt?id=${e(a.id)}">${a.result?'Review':'Resume'}</a></li>`).join('')}</ul>`:'<div class="empty"><h2>No Grand Test attempts yet</h2><p>Completed attempts will show scores, accuracy and section results here. QBank practice remains separate.</p></div>';content.innerHTML+=`<div class="row"><button class="button secondary" data-history-prev ${page?'':'disabled'}>Previous page</button><button class="button secondary" data-history-next ${data.has_more?'':'disabled'}>Next page</button></div>`;content.querySelector('[data-history-prev]').onclick=()=>{page--;history();};content.querySelector('[data-history-next]').onclick=()=>{page++;history();};}
      function refresh(){test.innerHTML='<option value="">All tests</option>'+rows.filter(r=>!platform.value||r.platform===platform.value).map(r=>`<option value="${e(r.test_id)}">${e(r.title)}</option>`).join('');page=0;history();}
      platform.onchange=refresh;test.onchange=()=>{page=0;history();};refresh();
    }catch(error){if (request === generation) notice(host,error);}
  }
  return {showCatalog,analytics,cancel};
}
