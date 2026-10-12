// Tiny, decorative inline marks: no fonts, images, requests or runtime dependency.
const paths={
 book:'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15',
 eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 heart:'M12 20 3 11C-1 4 8 1 12 7c4-6 13-3 9 4z',
 pill:'m8 16 8-8 M5 19a5 5 0 0 1 0-7l7-7a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7 0z',
 scope:'m9 3 5 5-4 4-5-5z M12 11a6 6 0 0 1 1 11 M5 22h14 M4 16h8 M15 6l2-2',
 scan:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M7 8h10v8H7z M10 11h4',
 cells:'M9 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M22 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M16 19a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 ear:'M6 9a6 6 0 0 1 12 0c0 5-5 5-5 9a3 3 0 0 1-6 0 M10 10a2 2 0 0 1 4 0c0 2-3 2-3 4',
 cross:'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
 play:'m8 4 12 8-12 8z',
 retry:'M4 10a8 8 0 1 1 0 5 M4 4v6h6',
 star:'m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
 chart:'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V5',
 saved:'M6 3h12v18l-6-4-6 4z'
};
export function studyIcon(kind='book'){return `<svg class="study-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${paths[kind]||paths.book}"/></svg>`;}
export function subjectIcon(name=''){const n=name.toLowerCase();return studyIcon(/ophthalm|eye/.test(n)?'eye':/pharma/.test(n)?'pill':/micro|biochem/.test(n)?'scope':/path|derma/.test(n)?'cells':/radiol/.test(n)?'scan':/\bent\b|otorhino/.test(n)?'ear':/medicine|cardio|physio/.test(n)?'heart':'cross');}
