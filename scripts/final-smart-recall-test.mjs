import assert from 'node:assert/strict';
import {freshPreferences,buildPlan,balancedImportance} from '../app/smart-recall-model.mjs';
import {rotateEarly,pinManualSelection,effectivePreferences,readServerPreferences,saveServerPreferences} from '../app/smart-recall-preferences.mjs';
const c=(subject,h=5,m=5,hc=0,mc=0)=>({subject,high_total:h,medium_total:m,high_covered:hc,medium_covered:mc});
const p={...freshPreferences(),active:['Physiology','Medicine','Pharmacology'],early:['Ophthalmology','Dermatology','Radiology']};
const coverage=[c('Ophthalmology',5,5,5,5),c('Dermatology'),c('Radiology'),c('Anatomy'),c('Microbiology',0,5),c('Medicine',5,5,5,5)];
const rotation=rotateEarly(p,coverage);assert.deepEqual(rotation.preferences.active,p.active);assert.deepEqual(rotation.preferences.early,['Anatomy','Dermatology','Radiology']);assert.match(rotation.notices[0],/Ophthalmology.*Anatomy/);
const manual=pinManualSelection(p,coverage);assert.deepEqual(rotateEarly(manual,coverage).preferences.early,p.early);
const temporary=effectivePreferences(p,'Microbiology');assert.deepEqual(rotateEarly(temporary,coverage).preferences.early,p.early);assert.deepEqual(temporary.active,p.active);
const q=(id,subject='Medicine',extra={})=>({question_id:id,subject,tier:'HIGH',concept_id:id,...extra});
const pools={importance:Array.from({length:100},(_,i)=>q('g'+i)),mistakes:Array.from({length:4},(_,i)=>q('m'+i)),bookmarks:Array.from({length:100},(_,i)=>q('b'+i)),due:Array.from({length:106},(_,i)=>q('d'+i)),allImportance:[]};
const plan=buildPlan(p,pools);assert.equal(plan.selected.length,30);assert.equal(plan.counts.mistakes,4);assert.equal(new Set(plan.selected.map(q=>q.question_id)).size,30);
const shared=q('shared','Microbiology',{reasons:['HIGH Global Importance','Repeated mistake ×3','Bookmarked','Marked for review','Due for revision']});const dedup=buildPlan(p,{importance:[shared],mistakes:[shared],bookmarks:[shared],due:[shared]});assert.equal(dedup.selected.length,1);assert.equal(dedup.selected[0].reasons.length,5);
const tp=buildPlan(temporary,{...pools,importance:[q('micro','Microbiology')],due:[q('micro-due','Microbiology')],allImportance:pools.importance});assert(tp.selected.every(q=>q.subject==='Microbiology'));assert.equal(tp.selected.length,2);
const breadth=balancedImportance([...Array.from({length:100},(_,i)=>q('med'+i)),...Array.from({length:10},(_,i)=>q('derm'+i,'Dermatology'))]);assert.equal(breadth.slice(0,10).filter(q=>q.subject==='Medicine').length,5);
// A manually pinned completed subject is retained; an active subject is never auto-replaced.
assert(rotateEarly(p,coverage).preferences.active.includes('Medicine'));
// Server settings outrank another device's local defaults; save conflicts surface instead of overwriting.
let row={smart_recall_preferences:p,smart_recall_revision:4,smart_recall_notice:rotation.notices};
const db={from(){return{select(){return this},eq(){return this},maybeSingle:async()=>({data:structuredClone(row)})}},rpc:async(name,args)=>{if(args.p_expected_revision!==row.smart_recall_revision)return{error:Error('conflict')};row={smart_recall_preferences:args.p_preferences,smart_recall_revision:row.smart_recall_revision+1,smart_recall_notice:args.p_notice};return{data:{preferences:row.smart_recall_preferences,revision:row.smart_recall_revision,notice:row.smart_recall_notice}}}};
assert.deepEqual((await readServerPreferences(db,'same-account',freshPreferences())).preferences.active,p.active);await saveServerPreferences(db,rotation.preferences,4,rotation.notices);assert.deepEqual((await readServerPreferences(db,'same-account',freshPreferences())).preferences.early,rotation.preferences.early);await assert.rejects(saveServerPreferences(db,p,4),/conflict/);
console.log('PASS: A/E persistence; active immutable; early high-first breadth rotation and notice; manual override; temporary strict scope; 30 cap; shortages redistributed; combined reasons; canonical dedup; subject balance; cross-device save conflict.');
