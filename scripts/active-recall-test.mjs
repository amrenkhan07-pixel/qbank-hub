import assert from 'node:assert/strict';
import {nextRetrieval, selectRecallUnits, selectVariant, enqueueRelearning} from '../app/active-recall-model.mjs';
let t=Date.UTC(2026,0,1), state={};
for(let i=0;i<6;i++){state=nextRetrieval(state,{correct:true,strength:'strong',now:t});t+=Math.max(state.interval_minutes*60000,86400000);if(i===2)assert.equal(state.mastery,'STABLE');}
assert.equal(state.mastery,'MASTERED');assert.equal(state.interval_minutes,86400);
const partial=nextRetrieval(state,{correct:true,strength:'partial',now:t});assert.ok(partial.interval_minutes<state.interval_minutes);assert.notEqual(partial.mastery,'MASTERED');
state=nextRetrieval(state,{correct:false,strength:'strong',now:t});assert.equal(state.mastery,'LEARNING');assert.equal(state.interval_minutes,15);
state=nextRetrieval(state,{correct:false,strength:'failed',now:t+60000});assert.equal(state.mastery,'WEAK');
const same=nextRetrieval(state,{correct:true,strength:'strong',now:t+120000});assert.equal(same.interval_minutes,1440);assert.equal(same.spaced_successes,0);
assert.equal(selectRecallUnits([{unit_key:'c:1'},{unit_key:'c:1'},{unit_key:'q:2'}],'all').length,2);
assert.equal(selectVariant(['a','b'],'a'),'b');assert.equal(selectVariant(['a'],'a'),'a');
const queue=Array.from({length:8},(_,i)=>({unit_key:String(i)})),repeats=new Set();
const retry=enqueueRelearning(queue,0,queue[0],repeats);assert.equal(retry[4].unit_key,'0');assert.equal(enqueueRelearning(retry,4,retry[4],repeats).length,9);
console.log('Active Recall deterministic model checks passed');
