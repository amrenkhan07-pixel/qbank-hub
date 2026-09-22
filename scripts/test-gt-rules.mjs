import assert from 'node:assert/strict';
import {GT_PRESETS,activeSection,canAnswer,scoreResponse} from '../app/gt-exam-rules.js';
for(const [name,p] of Object.entries(GT_PRESETS)){
 assert.equal(p.count,p.sections*p.sectionSize);
 assert.equal(activeSection(0,p.sectionSeconds*1000-1,p),0);
 assert.equal(activeSection(0,p.sectionSeconds*1000,p),1);
 assert.equal(canAnswer(1,1,p),false);
 assert.equal(canAnswer(p.sectionSize,1,p),false);
 assert.equal(canAnswer(p.sectionSize+1,1,p),true);
 assert.equal(activeSection(0,p.sections*p.sectionSeconds*1000,p),p.sections);
 assert.equal(canAnswer(p.count,p.sections,p),false);
 assert.equal(scoreResponse(['A'],['A'],false,p).marks,p.correct);
 assert.equal(scoreResponse(['B'],['A'],false,p).marks,p.wrong);
 assert.equal(scoreResponse([],['A'],true,p).marks,0);
 assert.equal(scoreResponse(['A'],['A'],true,p).status,p.reviewUnscored?'unanswered':'correct');
 console.log(name+' timing, boundaries and scoring passed');
}
assert.equal(scoreResponse(['A','B'],['A','B'],false,GT_PRESETS.ini_cet_200).status,'correct');
assert.equal(scoreResponse(['A'],['A','B'],false,GT_PRESETS.ini_cet_200).status,'incorrect');
