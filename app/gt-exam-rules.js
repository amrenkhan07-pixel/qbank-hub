export const GT_PRESETS = Object.freeze({
 ini_cet_200:{label:'INI-CET · 200 questions',count:200,sectionSize:50,sectionSeconds:2700,sections:4,correct:1,wrong:-1/3,reviewUnscored:true,source:'AIIMS prospectus'},
 neet_pg_2025_200:{label:'NEET-PG 2025 format · 200 questions',count:200,sectionSize:40,sectionSeconds:2520,sections:5,correct:4,wrong:-1,reviewUnscored:false,source:'NBEMS 2025 bulletin'},
 neet_pg_2026_180:{label:'NEET-PG 2026 · 180 questions',count:180,sectionSize:36,sectionSeconds:2520,sections:5,correct:4,wrong:-1,reviewUnscored:false,source:'NBEMS 2026 bulletin'},
});
export function activeSection(startMs,nowMs,preset){return Math.min(preset.sections,Math.max(0,Math.floor((nowMs-startMs)/(preset.sectionSeconds*1000))));}
export function canAnswer(position,section,preset){return Number.isInteger(position)&&position>=1&&position<=preset.count&&section<preset.sections&&Math.floor((position-1)/preset.sectionSize)===section;}
export function scoreResponse(selected,correct,marked,preset){if(!selected.length||(marked&&preset.reviewUnscored))return {status:'unanswered',marks:0};const match=new Set(selected).size===correct.length&&selected.length===correct.length&&correct.every(x=>selected.includes(x));return {status:match?'correct':'incorrect',marks:match?preset.correct:preset.wrong};}
export const formatRemaining=seconds=>{const n=Math.max(0,Math.ceil(seconds));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
