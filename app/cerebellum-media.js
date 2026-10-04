// Opt-in rendering for the full Cerebellum export. Existing platform rendering is unchanged.
export const isCerebellum = q => Boolean(q?.cerebellum_full_v1);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mediaUrl(value) { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch { return ''; } }
export function cerebellumMedia(q,placement) {
 if(!isCerebellum(q))return '';
 return (q.source_media||[]).filter(m=>m.placement===placement).map(m=>{
  const url=mediaUrl(m.reference),label=m.type==='image'?`${placement==='question'?'Question':'Explanation'} image ${m.position}`:m.type==='video'?'Open video explanation':'Open linked media';
  const link=url?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)} · original source</a>`:`<span>${escape(label)}: reference unavailable</span>`;
  if(m.type!=='image')return `<p class="cerebellum-media-link">${link}</p>`;
  return `<figure class="cerebellum-media" data-cerebellum-placement="${escape(placement)}">${url?`<img class="question-image" src="${escape(url)}" alt="${escape(label)}" data-cerebellum-image="${escape(placement)}" ${placement==='explanation'?'loading="lazy"':''}>`:''}<figcaption>${link}<span data-media-status role="status">${m.media_status==='inaccessible'?' · Previously inaccessible; retrying source.':' · External image; availability may change.'}</span></figcaption></figure>`;
 }).join('');
}
export function cerebellumNotice(q){
 if(!isCerebellum(q))return '';
 const reasons={option_text_blank:'The source has blank answer options.',needs_media_review:'The source may be missing an essential image.',suspicious_media_reference:'Some media URLs need review.',inaccessible_media:'Some media failed the import accessibility check.'};
 const warnings=(q.import_warnings||[]).map(w=>reasons[w]||w);
 return warnings.length?`<div class="notice">${warnings.map(escape).join(' ')} Source content has been preserved.</div>`:'';
}
export function essentialMediaReady(q,root=document){
 if(!isCerebellum(q))return true;
 if(q.option_text_blank||q.needs_media_review)return false;
 const expected=(q.source_media||[]).filter(m=>m.type==='image'&&m.placement==='question');
 const images=[...root.querySelectorAll('[data-cerebellum-image="question"]')];
 return images.length===expected.length&&images.every(img=>img.complete&&img.naturalWidth>0);
}
export function bindCerebellumMedia(q,root,canAnswer){
 if(!isCerebellum(q))return;
 const refresh=()=>{const ready=essentialMediaReady(q,root);root.querySelectorAll('[data-action="answer"],[data-action="submit-multi-answer"]').forEach(b=>b.disabled=!ready||!canAnswer());};
 for(const img of root.querySelectorAll('[data-cerebellum-image]')){
  const update=()=>{const failed=img.complete&&!img.naturalWidth;const status=img.closest('figure').querySelector('[data-media-status]');status.textContent=failed?' · Image could not load. Open the original source or retry later.':img.complete?' · Image loaded.':' · Loading image…';if(failed)img.hidden=true;refresh();};
  img.addEventListener('load',update,{once:true});img.addEventListener('error',update,{once:true});update();
 }
 refresh();
}
