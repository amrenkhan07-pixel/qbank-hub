import {SUBJECTS,validatePreferences} from './smart-recall-model.mjs';
export const remaining=c=>({high:Math.max(0,Number(c?.high_total||0)-Number(c?.high_covered||0)),medium:Math.max(0,Number(c?.medium_total||0)-Number(c?.medium_covered||0))});
export function pinManualSelection(p,coverage){const by=new Map(coverage.map(c=>[c.subject,c]));return {...p,manualEarlyPins:p.early.filter(s=>{const c=by.get(s),r=remaining(c);return c&&r.high+r.medium===0;})};}
export function rotateEarly(p,coverage){
 const next=structuredClone(p),notices=[],by=new Map(coverage.map(c=>[c.subject,c]));
 const useful=c=>{const r=remaining(c);return r.high+r.medium>0;};
 if(p.temporarySubject)return {preferences:next,notices};
 for(let i=0;i<next.early.length;i++){
  const old=next.early[i],c=by.get(old);if(!c||useful(c)||p.manualEarlyPins?.includes(old))continue;
  const choices=coverage.filter(c=>SUBJECTS.includes(c.subject)&&!next.active.includes(c.subject)&&!next.early.includes(c.subject)&&useful(c));
  choices.sort((a,b)=>Number(remaining(b).high>0)-Number(remaining(a).high>0)||
   (Number(a.high_covered)+Number(a.medium_covered))/Math.max(1,Number(a.high_total)+Number(a.medium_total))-(Number(b.high_covered)+Number(b.medium_covered))/Math.max(1,Number(b.high_total)+Number(b.medium_total))||
   (Date.parse(a.last_exposed_at)||0)-(Date.parse(b.last_exposed_at)||0)||remaining(b).high-remaining(a).high||a.subject.localeCompare(b.subject));
  if(choices.length){next.early[i]=choices[0].subject;notices.push(`Early Exposure updated: ${old} HIGH/MEDIUM coverage is complete. Switched to ${choices[0].subject} for new high-yield exposure.`);}
 }
 validatePreferences(next);return {preferences:next,notices};
}
export const effectivePreferences=(p,subject)=>subject?{...p,size:30,focus:'custom',custom:[subject],temporarySubject:subject}:{...p,size:30};
export async function readServerPreferences(db,userId,fallback){
 const r=await db.from('user_srm_settings').select('smart_recall_preferences,smart_recall_revision,smart_recall_notice').eq('user_id',userId).maybeSingle();if(r.error)throw r.error;
 return {preferences:validatePreferences({...r.data?.smart_recall_preferences||fallback,size:30}),revision:r.data?.smart_recall_revision||0,notice:r.data?.smart_recall_notice||[],exists:Boolean(r.data?.smart_recall_preferences)};
}
export async function saveServerPreferences(db,preferences,revision,notice=[]){const r=await db.rpc('smart_recall_save_preferences',{p_preferences:preferences,p_expected_revision:revision,p_notice:notice});if(r.error)throw r.error;return r.data;}
