// One shared clock governs both question and total timing. Values are milliseconds.
export function readClock(clock, now=Date.now(), limit=Infinity) {
 const delta=clock.paused?0:Math.min(Math.max(0,50000-clock.questionUsedMs),Math.max(0,now-clock.startedAt),Math.max(0,limit-clock.totalUsedMs));
 return {...clock,questionUsedMs:clock.questionUsedMs+delta,totalUsedMs:clock.totalUsedMs+delta};
}
export function freezeClock(clock,now=Date.now(),limit=Infinity,manual=clock.manualPaused||false){return {...readClock(clock,now,limit),paused:true,manualPaused:manual,startedAt:now,savedAt:now};}
export function runClock(clock,now=Date.now()){return {...clock,paused:false,manualPaused:false,startedAt:now,savedAt:now};}
export function checkpointClock(clock,now=Date.now(),limit=Infinity){const next=readClock(clock,now,limit);return {...next,paused:clock.paused||next.questionUsedMs>=50000||next.totalUsedMs>=limit,startedAt:now,savedAt:now};}
export function initialClock(position=0,now=Date.now()){return {version:1,position,totalUsedMs:0,questionUsedMs:0,startedAt:now,savedAt:now,paused:false,manualPaused:false};}
