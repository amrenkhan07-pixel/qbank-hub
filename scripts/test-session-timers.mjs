import assert from 'node:assert/strict';
import {readClock,freezeClock,runClock,checkpointClock,initialClock} from '../app/session-timers.js';
let c={...initialClock(3,0),totalUsedMs:161000};
c=freezeClock(c,27000,1000000,true);
assert.equal(50000-c.questionUsedMs,23000);assert.equal(1000000-c.totalUsedMs,812000);
assert.deepEqual(readClock(c,327000,1000000),c);
c=JSON.parse(JSON.stringify(c));c=runClock(c,327000);
assert.equal(readClock(c,328000,1000000).questionUsedMs,28000);
assert.equal(readClock(c,328000,1000000).totalUsedMs,189000);
for(let n=0;n<100;n++){const at=328000+n*10001;c=freezeClock(c,at,1000000,true);c=runClock(c,at+10000);}
assert.equal(readClock(c,c.startedAt,1000000).questionUsedMs,28099);
const end=checkpointClock(c,c.startedAt+30000,1000000);assert.equal(end.questionUsedMs,50000);assert.equal(end.paused,true);
assert.equal(readClock(end,end.startedAt+300000,1000000).totalUsedMs,end.totalUsedMs);
console.log('Shared timer: exact example, five-minute pause, serialized resume, 100 cycles, expiry cap passed');
