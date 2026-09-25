// Targeted synthetic Recall benchmark. No account credentials or production writes.
// Use before with BASELINE_DIR containing app.js and session-timers.js from the baseline.
const fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const repo=process.cwd(),variant=process.argv[2]||'before';
const mock=`
window.calls=[];window.failNext=null;
const ids=Array.from({length:40},(_,i)=>'q'+i);
const questions=ids.map(id=>({id,question_text:'Recall fixture '+id,subject_id:'s1',platform_id:'p1',is_usable:true,correct_answer:'A',explanation_html:'<p>'+('Explanation detail. '.repeat(600))+'</p>'}));
const queue=ids.map((question_id,i)=>({question_id,srm_state:'learning',reason:'due',is_pyq:false,overdue_seconds:4000-i,priority:i,srm_due_at:'2026-01-01',due_at:'2026-01-01'}));
async function result(name,data,request){const bytes=new TextEncoder().encode(JSON.stringify(data)).length;window.calls.push({name,bytes,requestBytes:new TextEncoder().encode(JSON.stringify(request ?? null)).length,request:name==='test_session_questions:insert'?{snapshotCount:request.length}:request});await new Promise(r=>setTimeout(r,60+bytes/2000));if(window.failNext===name){window.failNext=null;return {data:null,error:{message:'Fixture save failure'}};}return {data,error:null};}
class Query {
 constructor(table){this.table=table;this.operation='select';this.ids=null;}
 select(){return this;}order(){return this;}eq(){return this;}lte(){return this;}not(){return this;}range(){return this;}limit(){return this;}
 in(k,ids){this.ids=ids;return this;}insert(v){this.operation='insert';this.value=v;return this;}upsert(v){this.operation='upsert';this.value=v;return this;}update(v){this.operation='update';this.value=v;return this;}
 maybeSingle(){return this;}single(){return this;}
 then(resolve,reject){let data=[];const t=this.table;
 if(t==='subjects')data=[{id:'s1',name:'Medicine'}];
 if(t==='platforms')data=[{id:'p1',name:'Fixture platform'}];
 if(t==='questions')data=questions.filter(q=>!this.ids||this.ids.includes(q.id));
 if(t==='question_options')data=(this.ids||[]).flatMap(question_id=>['A','B','C','D'].map(option_key=>({question_id,option_key,option_text:'Option '+option_key,is_correct:option_key==='A'})));
 if(t==='user_srm_settings')data={new_daily_limit:20,review_daily_limit:40,timezone_name:'Asia/Kolkata'};
 if(t==='test_sessions'&&this.operation==='insert')data={...this.value,id:'fixture-session'};
 return result(t+':'+this.operation,data,this.value).then(resolve,reject);
 }
}
export const db={from:t=>new Query(t),rpc:(n,p)=>result(n,n==='qbank_srm_summary'?{due_now:40}:n==='qbank_srm_queue'?queue.slice(0,p.p_limit):n==='qbank_resolve_population'?{count:(p.p_filters.question_ids||ids).length,question_ids:p.p_filters.question_ids||ids}:n==='qbank_record_attempt_v2'?{active:true,state:'learning',interval_minutes:10}: {subjects:['s1']},p),auth:{onAuthStateChange(){}},storage:{from(){return {download:async()=>{window.downloads=(window.downloads||0)+1;await new Promise(r=>setTimeout(r,60));return {data:new Blob([window.payloadBytes]),error:null};}}}}};
export const initError=null;export const isMissingTable=()=>false;export const requireUser=async()=>({id:'fixture-user'});export const withAuthTimeout=x=>x;
`;
const server=http.createServer((req,res)=>{let pathname=new URL(req.url,'http://localhost').pathname;
 res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'text/javascript');
 if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end('<link rel="stylesheet" href="/app/styles.css"><div id="app"></div><div id="toast-region"></div><script type="module" src="/app/app.js"></script>');}
 if(pathname==='/app/supabase.js')return res.end(mock);
 let filename=path.join(repo,pathname);
 if(variant==='before'&&['/app/app.js','/app/session-timers.js'].includes(pathname))filename=path.join(process.env.BASELINE_DIR || '/tmp/qbank-recall-baseline',path.basename(pathname));
 try{let src=fs.readFileSync(filename,'utf8');if(pathname==='/app/app.js')src=src.replace(/bootstrap\(\);\s*$/,'window.testApi={state,loadMeta,recall,prepareQuestionSet,readyScreen,startPendingSession,navigateActive,renderActive,stopActiveTimer,updateActiveTimerDisplay,selectAnswer,toggleBookmark,toggleMark,render,resolveFacets,decodePayloadObject,persistTimer,startActiveTimers,saveActiveAnswer,loadQuestionsByIds};');res.end(src);}catch(e){res.statusCode=404;res.end('');}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
 try{const page=await browser.newPage();page.on('pageerror',e=>console.error('PAGE ERROR',e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.testApi);
 const results=await page.evaluate(async()=>{const a=testApi;a.state.user={id:'fixture-user'};a.state.route='recall';const measure=async(fn)=>{calls=[];let start=performance.now();await fn();return {elapsedMs:Math.round(performance.now()-start),queries:calls.length,responseBytes:calls.reduce((n,c)=>n+c.bytes,0),calls:structuredClone(calls)};};
 const initial=await measure(async()=>{await a.loadMeta();await a.recall();const set=await a.prepareQuestionSet({mode:'recall',preset:'recall',filters:{},questionIds:a.state.recallQueue.map(r=>r.question_id)});a.readyScreen(set);await a.startPendingSession();});
 let visibleMs;const visibleStart=performance.now();const observer=new MutationObserver(()=>{if(document.querySelector('.question-topline')?.textContent.includes('Question 2 of')){visibleMs=Math.round(performance.now()-visibleStart);observer.disconnect();}});observer.observe(document.querySelector('#app'),{childList:true,subtree:true});
 const next=await measure(()=>a.navigateActive(1));next.visibleMs=visibleMs;a.stopActiveTimer();
 return {initial,next,questions:a.state.active.questions.length};});
 if(variant!=='before') {
 const assert=require('assert/strict');
 assert.equal(results.questions,20);assert.equal(results.initial.queries,11);assert.equal(results.next.queries,2);
 assert.equal(await page.locator('#question-timer').textContent(),'00:50');
 await page.selectOption('[data-recall-timer]','55');
 assert.equal(await page.locator('#question-timer').textContent(),'00:55');
 await page.evaluate(()=>{testApi.state.active.timer_state.startedAt-=56000;testApi.persistTimer(testApi.state.active,false);testApi.updateActiveTimerDisplay();});
 assert.equal(await page.locator('#question-timer').textContent(),'00:00');
 assert.match(await page.locator('#recall-timeout').textContent(),/Time’s up/);
 assert.equal(await page.evaluate(()=>testApi.state.active.index),1);
 assert.equal(await page.locator('[data-action="next"]').isEnabled(),true);
 await page.evaluate(()=>testApi.navigateActive(2));
 assert.equal(await page.locator('#question-timer').textContent(),'00:55');
 await page.selectOption('[data-recall-timer]','0');assert.equal(await page.locator('#question-timer').count(),0);
 await page.evaluate(()=>{testApi.state.active.timer_state.startedAt-=70000;});
 await page.evaluate(()=>testApi.selectAnswer('B'));
 assert.equal(await page.evaluate(()=>testApi.state.active.answers.q2.time_spent_seconds),70);
 assert.equal(await page.evaluate(()=>testApi.state.active.answers.q2.attemptRecorded),true);
 assert.equal(await page.locator('.rich-content').filter({hasText:'Explanation detail'}).count(),0);
 await page.click('[data-action="toggle-explanation"]');assert.equal(await page.locator('.rich-content').filter({hasText:'Explanation detail'}).count(),1);
 await page.evaluate(()=>testApi.toggleBookmark());assert.equal(await page.evaluate(()=>testApi.state.active.bookmarks.has('q2')),true);
 await page.evaluate(()=>testApi.toggleMark());assert.equal(await page.evaluate(()=>testApi.state.active.marked.has('q2')),true);
 const repeat=await page.evaluate(async()=>{calls=[];await testApi.saveActiveAnswer('q2');await testApi.saveActiveAnswer('q2');return calls.length;});assert.equal(repeat,0);
 await page.evaluate(()=>testApi.navigateActive(3));
 await page.selectOption('[data-recall-timer]','50');
 await page.evaluate(()=>testApi.selectAnswer('A'));
 await page.evaluate(()=>{calls=[];return testApi.navigateActive(4);});
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='qbank_record_attempt_v2').length),1);
 assert.equal(await page.evaluate(()=>testApi.state.active.answers.q3.confidence),'unsure');
 // Failed answer saves stay retryable, keep the current question, and release the navigation lock.
 await page.evaluate(async()=>{failNext='test_answers:upsert';try{await testApi.navigateActive(5);}catch{};});
 assert.equal(await page.evaluate(()=>testApi.state.active.index),4);
 assert.equal(await page.evaluate(()=>testApi.state.active.navigationBusy),false);
 await page.evaluate(()=>testApi.navigateActive(5));
 assert.equal(await page.evaluate(()=>testApi.state.active.index),5);
 const facets=await page.evaluate(async()=>{calls=[];await Promise.all([testApi.resolveFacets({platforms:['p1']}),testApi.resolveFacets({platforms:['p1']})]);await testApi.resolveFacets({platforms:['p1']});return calls.length;});assert.equal(facets,1);
 const downloads=await page.evaluate(async()=>{payloadBytes=new TextEncoder().encode(JSON.stringify({schema_version:1,questions:[]}));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payloadBytes)),x=>x.toString(16).padStart(2,'0')).join('');const object={object_path:'fixture',sha256:hash};await Promise.all([testApi.decodePayloadObject(object),testApi.decodePayloadObject(object)]);return window.downloads;});assert.equal(downloads,1);
 // Exiting while a save is in flight must not restore the solving DOM.
 await page.evaluate(()=>{window.navigationPromise=testApi.navigateActive(6);});
 await page.click('[data-action="exit-recall"]');
 await page.evaluate(()=>window.navigationPromise);
 await page.waitForSelector('#recall-filter-form');assert.equal(await page.locator('.question-layout').count(),0);
 assert.equal(await page.evaluate(()=>testApi.state.timer),null);
 assert.equal(await page.locator('[data-recall-timer]').inputValue(),'50');
 results.checks=['20-question server bound','50-second default','55-second expiry with no auto-submit or skip','per-question reset','Off keeps elapsed-time analytics','deferred explanation DOM','bookmark and mark correctness','deduplicated answer saves','one attempt event and confidence on Next','failed-save retry','facet and payload in-flight deduplication','exit during navigation stays exited','preference persistence'];
 await page.screenshot({path:'/tmp/qbank-recall-after.png'});
 }
 fs.writeFileSync('/tmp/qbank-'+variant+'-metrics.json',JSON.stringify(results,null,2));console.log(JSON.stringify({variant,...results,initial:{...results.initial,calls:results.initial.calls.map(c=>({name:c.name,bytes:c.bytes}))},next:{...results.next,calls:results.next.calls.map(c=>({name:c.name,bytes:c.bytes}))}},null,2));
 }finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
