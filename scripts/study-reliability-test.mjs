import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app/app.js',import.meta.url),'utf8');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
let calls=[],status='in_progress',renderCount=0,results=0;
const state={user:{id:'owner'},features:{sessions:true},route:'tests',active:null};
const context={state,TARGET_SECONDS:50,crypto:{randomUUID:()=> 'event'},Date,Map,Set,Promise,Math,console,location:{hash:'#/tests'},confirm:()=>true,toast(){},optional:async q=>await q,
 isAnswerCorrect:(q,a)=>a?.selected_option===q.correct_answer,activeQuestion:()=>state.active.questions[state.active.index],
 persistTimer:async()=>{},pauseTotalTimer(){},stopActiveTimer(){},sharedClock:()=>({}),pauseAttemptTimers(){},elapsedOnQuestion:()=>2,
 questionTimeRemaining:()=>48,answeredQuestionTimeRemaining:()=>48,resumeTotalTimer(){},totalTimeUsed:()=>2000,
 renderActive(){renderCount++},resultScreen(){results++},invalidateLearnerCaches(){},isMissingTable:()=>false,
 db:{rpc:async(name,args)=>{calls.push({name,args});if(name==='submit_test_session'){status='completed';return {data:{status,total_correct:1,total_questions:3}};}return {data:{}};},from(table){let value;const q={upsert(v){value=v;return q},update(v){value=v;return q},eq(){return q},then(ok,bad){calls.push({table,value});return Promise.resolve(table==='test_answers'&&status!=='in_progress'?{error:new Error('RLS completed-session write')}:{data:null}).then(ok,bad)}};return q;}}};
vm.createContext(context);
vm.runInContext(extract('async function recordAttempt(','async function selectAnswer(')+extract('async function navigateActive(','async function toggleBookmark(')+extract('async function submitActive(','function resultScreen()'),context);
const fresh=()=>{status='in_progress';calls=[];vm.runInContext('answerWrites.clear()',context);state.active={id:'session',status,kind:'test',index:0,questions:[{id:'a',correct_answer:'A'},{id:'b',correct_answer:'B'},{id:'c',correct_answer:'C'}],answers:{a:{selected_option:'A'},b:{selected_option:'A'}},marked:new Set(),learning:new Map(),questionStartedAt:Date.now(),timer_state:{},solvingVisible:true};};
fresh();await context.saveActiveAnswer('a');await context.saveActiveAnswer('a');assert.equal(calls.filter(c=>c.table==='test_answers').length,1,'identical answer write deduplicated');
state.active.answers.a.selected_option='B';await context.saveActiveAnswer('a');assert.equal(calls.filter(c=>c.table==='test_answers').length,2,'changed answer persists');
fresh();await context.navigateActive(1);assert.equal(state.active.index,1);assert(!calls.some(c=>c.name==='qbank_record_attempt_v2'),'timed-test navigation must not commit provisional attempt');
fresh();await Promise.all([context.submitActive(),context.submitActive()]);assert.equal(calls.filter(c=>c.name==='submit_test_session').length,1);assert.equal(status,'completed');assert.equal(calls.filter(c=>c.name==='qbank_record_attempt_v2').length,2);assert.equal(results,1);
const submitted=calls.findIndex(c=>c.name==='submit_test_session');assert(!calls.slice(submitted+1).some(c=>c.table==='test_answers'),'no answer writes after submit');
const original=JSON.stringify(state.active.answers),questions=state.active.questions;calls=[];context.startCompletedReview('incorrect');assert.equal(state.active.index,1);assert.strictEqual(state.active.questions,questions);await context.navigateActive(2);await context.saveActiveAnswer('b');await context.ensureAttemptRecorded(questions[1],state.active.answers.b);assert.equal(calls.length,0,'review has no persistence or attempt side effects');assert.equal(JSON.stringify(state.active.answers),original);
context.startCompletedReview('unattempted');assert.equal(state.active.index,2);context.startCompletedReview('correct');assert.equal(state.active.index,0);context.startCompletedReview('all');assert.equal(state.active.questions.length,3);
console.log('PASS: deduplicated/changed answer writes, timed-test navigation, single submission, no post-submit RLS write, immutable filtered review, no review attempts');
// Personal bookmarks and review marks remain available without changing completed answers.
context.activeQuestion=()=>state.active.questions[state.active.index];context.renderActive=()=>{};
state.active.bookmarks=new Set();state.active.marked=new Set();state.active.learning=new Map();state.active.completedReview=true;calls=[];
vm.runInContext(extract('async function toggleBookmark(','async function updateAnswerMetadata('),context);
await context.toggleBookmark();await context.toggleMark();assert(state.active.bookmarks.has('a'));assert(state.active.marked.has('a'));assert(calls.some(c=>c.name==='qbank_set_bookmark'));assert(calls.some(c=>c.table==='user_question_state'));assert(!calls.some(c=>c.table==='test_answers'));
console.log('PASS: completed-review bookmark/mark updates personal state only');
