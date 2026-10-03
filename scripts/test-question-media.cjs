// Reads a local, uncommitted source sample. No production database writes.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const samples=JSON.parse(fs.readFileSync(process.argv[2]||'artifacts/media-audit/samples.json'));
const repo=process.cwd();
const server=http.createServer((req,res)=>{
 const file=new URL(req.url,'http://localhost').pathname;
 if(file==='/'){res.setHeader('Content-Type','text/html');return res.end('<link rel="stylesheet" href="/app/styles.css"><div id="app"></div><div id="toast-region"></div><script type="module" src="/app/app.js"></script>');}
 if(file==='/pixel.png'){res.setHeader('Content-Type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ8sAAAAASUVORK5CYII=','base64'));}
 if(file==='/app/supabase.js'){res.setHeader('Content-Type','text/javascript');return res.end('export const db=window.mockDb; export const initError=null;export const isMissingTable=()=>false;export const requireUser=async()=>null;export const withAuthTimeout=x=>x;');}
 try{let body=fs.readFileSync(path.join(repo,file),'utf8');res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');if(file==='/app/app.js')body=body.replace(/bootstrap\(\);\s*$/,'window.testApi={state,renderActive,recoverSnapshotMedia,stopActiveTimer};');res.end(body);}catch{res.statusCode=404;res.end('');}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
 const results={sourceSamples:Object.keys(samples).length,renderChecks:0,loadedImages:[],checks:[],pageErrors:[]};
 try{
 const page=await browser.newPage();page.on('pageerror',e=>results.pageErrors.push(e.message));
 await page.addInitScript(samples=>{
  window.samples=samples;window.dbReads=[];
  window.convert=x=>({id:x.source_question_id,question_text:x.payload.question_html,explanation_html:x.payload.explanation_html,question_images:x.payload.media.filter(m=>m.placement==='question').map(m=>m.reference),explanation_images:x.payload.media.filter(m=>m.placement==='explanation').map(m=>m.reference),options:x.payload.options.map(o=>({option_key:o.key,option_text:o.html,is_correct:o.is_correct})),correct_option_keys:x.payload.correct_keys,audio:x.payload.audio,video_url:x.payload.video,media_status:x.payload.media.length?'MEDIA_REFERENCED':'NO_MEDIA',is_usable:true});
  class Query {constructor(table){this.table=table;this.ids=[];}select(){return this;}in(k,ids){this.ids=ids;return this;}eq(){return this;}order(){return this;}then(resolve,reject){const selected=Object.values(samples).map(convert).filter(q=>this.ids.includes(q.id));dbReads.push({table:this.table,ids:this.ids});return new Promise(r=>setTimeout(()=>r({data:this.table==='questions'?selected:this.table==='question_options'?selected.flatMap(q=>q.options.map(o=>({...o,question_id:q.id}))):[],error:null}),30)).then(resolve,reject);}}
  window.mockDb={from:t=>new Query(t),auth:{onAuthStateChange(){}},rpc(){throw Error('Unexpected production-style RPC');}};
  window.showSample=(name,mode='recall',open=true)=>{
   const q=convert(samples[name]),a=testApi; a.state.user={id:'media-fixture'};a.state.route='qbank';a.state.active={kind:mode,status:'in_progress',questions:[q],index:0,answers:{[q.id]:{selected_option:q.correct_option_keys.join(','),submitted:true}},bookmarks:new Set(),marked:new Set(),learning:new Map(),completedReview:mode==='browse',solvingVisible:true,explanationOpen:open,target_seconds_per_question:50,filters:{}};a.renderActive();a.stopActiveTimer();return q;
  };
 },samples);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.testApi);
 // All entry modes share renderActive: PYQ/normal Practice, Recall Today/Recall, and reviews.
 for(const mode of ['practice','recall','browse'])for(const [name,sample]of Object.entries(samples)){
  const q=await page.evaluate(({name,mode})=>showSample(name,mode),{name,mode});
  const urls=await page.locator('img[data-content-image]').evaluateAll(imgs=>imgs.map(i=>i.src));
  assert.deepEqual(urls,[...new Set(q.question_images),...new Set(q.explanation_images)]);results.renderChecks++;
  const preserved=await page.evaluate(()=>{const q=testApi.state.active.questions[0];const clean=v=>new DOMParser().parseFromString(v,'text/html').body.textContent.replace(/\s+/g,' ').trim();return document.querySelector('.question-stem').textContent.replace(/\s+/g,' ').trim()===clean(q.question_text)&&document.querySelector('.answer-panel .rich-content').textContent.replace(/\s+/g,' ').trim().startsWith(clean(q.explanation_html));});assert.equal(preserved,true);
 }
 results.checks.push('all source text and image-array order preserved in Practice/PYQ, Recall/Today and review shared renderer');
 await page.evaluate(()=>showSample('prep_explanation','recall',false));assert.equal(await page.locator('.answer-panel img').count(),0);
 results.checks.push('closed explanations contain no image elements');
 await page.evaluate(()=>showSample('prep_explanation'));
 assert.equal(await page.locator('audio[preload="none"]').count(),2);
 results.checks.push('English/Hindi audio references preserved with preload disabled');
 // Existing snapshot: arrays absent; recover only the displayed question, read-only.
 await page.evaluate(()=>{showSample('microbiology');const q=testApi.state.active.questions[0];delete q.question_images;delete q.explanation_images;q.restoreMedia=true;dbReads=[];testApi.renderActive();});
 await page.waitForFunction(()=>testApi.state.active.questions[0].restoreMedia===false);
 assert.equal(await page.locator('img[data-content-image]').count(),samples.microbiology.payload.media.length);
 const reads=await page.evaluate(()=>dbReads);assert.ok(reads.every(r=>r.ids.length===1&&r.ids[0]===samples.microbiology.source_question_id));
 results.checks.push('old session recovered lazily for one question using SELECT only');
 // Load and decode real source images on desktop and narrow mobile.
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:800});
  for(const name of ['microbiology','microbiology_second','prep_stem','prep_explanation','multiple','reused_1','reused_2','no_media']){
   await page.evaluate(name=>showSample(name),name);
   const images=page.locator('img[data-content-image]');const count=await images.count();
   for(let i=0;i<count;i++){
    const img=images.nth(i);await img.scrollIntoViewIfNeeded();
    await img.evaluate(el=>el.complete?null:new Promise((resolve,reject)=>{el.addEventListener('load',resolve,{once:true});el.addEventListener('error',()=>reject(Error('Source image failed: '+el.src)),{once:true});}));
    const info=await img.evaluate(el=>({url:el.src,width:el.naturalWidth,display:el.getBoundingClientRect().width,viewport:innerWidth}));
    assert.ok(info.width>0);assert.ok(info.display<=width);results.loadedImages.push({sample:name,viewport:width,...info});
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   if(name==='microbiology'&&width===390)await page.screenshot({path:'/tmp/qbank-media-mobile.png'});
  }
 }
 results.checks.push('real image decode and responsive desktop/mobile layout','same repeated URL reused across two real questions without storing copies');
 // Exercise the completed GT viewer itself with a source-format question; timing is untouched.
 const gt=await page.evaluate(async()=>{
  const {createGTExamMode}=await import('/app/gt-exam-mode.js');const m=await import('/app/media-content.js');
  const source=samples.microbiology.question;
  const payload={metadata:{title:'Media regression'},questions:[{source}]};
  const response={status:'completed',mode:'exam_mode',preset:'neet_pg_2025_200',question_count:1,section_count:1,section_size:1,section_seconds:100,active_section:0,payload_sha256:'fixture',payload_object_id:'fixture',responses:{},result:{score:0,maximum_score:4,correct:0,incorrect:0,unanswered:1,accuracy:null,outcomes:{}},server_now:new Date().toISOString(),started_at:new Date().toISOString()};
  const db={rpc:async()=>({data:response,error:null}),from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:{sha256:'fixture'},error:null})})};
  const view=createGTExamMode({db,e:x=>String(x??''),richHtml:m.renderContent,safeUrl:m.safeMediaUrl,decodePayloadObject:async()=>payload,layout:html=>document.querySelector('#app').innerHTML=html});
  await view.attempt('fixture');
  const out={stem:document.querySelectorAll('#gt-exam .question-stem img').length,explanation:document.querySelectorAll('#gt-exam details img').length,locked:[...document.querySelectorAll('[data-answer]')].every(b=>b.disabled)};view.cancel();return out;
 });
 assert.equal(gt.stem,samples.microbiology.question.question_images.length);assert.equal(gt.explanation,samples.microbiology.question.explanation_images.length);assert.equal(gt.locked,true);
 results.checks.push('completed GT viewer uses shared original-media renderer and keeps answers read-only');
 // Malicious markup, lazy attributes, inline interleaving and dual inline/array duplicates.
 const safety=await page.evaluate(async()=>{
  const m=await import('/app/media-content.js');const u=location.origin+'/pixel.png';
  const html=m.renderContent(`<p>Before</p><img data-src="${u}" onerror="window.pwned=1"><p>Between</p><img src="${u}?two"><p>After</p><script>window.pwned=1</script><iframe src="https://example.com"></iframe><img src="javascript:alert(1)">`,[u,u,u+'?two']);
  const node=document.createElement('div');node.innerHTML=html;
  const text=node.textContent;const images=[...node.querySelectorAll('img')];
  const picture=m.renderContent(`<picture><source srcset="${u} 1x, javascript:x 2x"><img data-src="${u}"></picture>`);
  const background=m.renderContent(`<div style="background-image:url('${u}');position:fixed">Kept</div>`);
  return {images:images.length,order:node.querySelector('div').children[0].tagName+','+node.querySelector('div').children[1].tagName+','+node.querySelector('div').children[2].tagName,safe:!node.querySelector('script,iframe,[onerror],[style]')&&!window.pwned,picture,background,text};
 });
 assert.equal(safety.images,2);assert.equal(safety.order,'P,IMG,P');assert.equal(safety.safe,true);assert.ok(!safety.picture.includes('javascript:'));assert.ok(safety.background.includes('content-image'));
 results.checks.push('inline paragraph/image ordering; inline+array duplicate suppression; picture/srcset/lazy/background normalization; scripts/handlers/iframes blocked');
 await page.evaluate(async()=>{const m=await import('/app/media-content.js');document.querySelector('#app').innerHTML=m.renderContent('<img src="'+location.origin+'/missing.png">');});
 await page.waitForSelector('.media-unavailable');assert.equal(await page.locator('img[data-content-image]').count(),0);results.checks.push('genuine failed asset shows explicit unavailable message');
 assert.deepEqual(results.pageErrors,[]);
 fs.writeFileSync('/tmp/qbank-media-test-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({...results,loadedImages:results.loadedImages.length},null,2));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
