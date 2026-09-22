import assert from 'node:assert/strict';
import {createGTExamMode} from '../app/gt-exam-mode.js';
// Regression: a slow, obsolete load must not install a timer after a newer load.
const timers=new Map();let next=0,host,decodeCount=0,releaseOld;
globalThis.setInterval=fn=>{timers.set(++next,fn);return next;};
globalThis.clearInterval=id=>timers.delete(id);
const control=()=>({disabled:false,textContent:'',options:[]});
globalThis.document={querySelector:()=>host,createElement:()=>({set innerHTML(v){this.value=v;},value:''})};
const layout=()=>{if(host)host.isConnected=false;host={isConnected:true,innerHTML:'',querySelector:control,querySelectorAll:()=>[]};};
const now=new Date().toISOString(),a={id:'test',preset:'ini_cet_200',server_now:now,started_at:now,expires_at:new Date(Date.now()+10800000).toISOString(),status:'in_progress',active_section:0,section_size:50,section_seconds:2700,section_count:4,question_count:200,responses:{},payload_sha256:'test'};
const payload={metadata:{title:'Timer race fixture'},questions:Array.from({length:200},()=>({source:{raw_text:'Question',options:[]}}))};
const db={rpc:async()=>({data:structuredClone(a)}),from(){return {select(){return this},eq(){return this},single:async()=>({data:{sha256:'test'}})}}};
const mode=createGTExamMode({db,e:String,richHtml:String,safeUrl:String,layout,decodePayloadObject:()=>++decodeCount===1?new Promise(resolve=>{releaseOld=resolve}):Promise.resolve(payload)});
const old=mode.attempt('test');while(!releaseOld)await Promise.resolve();
await mode.attempt('test');assert.equal(timers.size,1);const current=[...timers.keys()][0];
releaseOld(payload);await old;assert.equal(next,1,'obsolete load installed another interval');assert.ok(timers.has(current));
timers.get(current)();assert.ok(timers.has(current),'active timer was cleared');
mode.cancel();assert.equal(timers.size,0);console.log('GT overlapping-load timer regression passed');
