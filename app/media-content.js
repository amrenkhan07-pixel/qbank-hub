import {config} from './config.js';
// Shared imported-content renderer. References stay references; no image blobs or DOM caches.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const SIGNED = /[?&](?:x-amz-signature|x-amz-credential|signature|token|expires|policy|key-pair-id)=/i;
export function mediaReference(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.reference || value?.url || value?.src || value?.['data-src'] || value?.['data-original'] || '').trim();
}
export function safeMediaUrl(value) {
  const raw = mediaReference(value);
  if (IMAGE_DATA.test(raw)) return raw;
  try {
    // Relative/blob references cannot be resolved against the QBank application's URL.
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    const ownStorage = url.origin === new URL(config.supabaseUrl).origin && url.pathname.startsWith('/storage/v1/object/sign/question-media/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (SIGNED.test(url.href) && !ownStorage)) return '';
    return url.href;
  } catch { return ''; }
}
function srcset(value) {
  return String(value || '').split(',').map(part => {
    const [ref, descriptor, extra] = part.trim().split(/\s+/);
    const url = safeMediaUrl(ref);
    return url && !extra && (!descriptor || /^(?:\d+w|\d+(?:\.\d+)?x)$/.test(descriptor)) ? `${url}${descriptor ? ' ' + descriptor : ''}` : '';
  }).filter(Boolean).join(', ');
}
const missing = () => '<span class="media-unavailable" role="status">Image unavailable — the source reference is missing or inaccessible.</span>';
function imageMarkup(url, alt, candidates = '') {
  return `<img class="content-image" data-content-image src="${escape(url)}"${candidates ? ` srcset="${escape(candidates)}"` : ''} alt="${escape(alt || 'Question content image')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}
export function renderContent(value, references = []) {
  const doc = new DOMParser().parseFromString(`<div>${String(value ?? '')}</div>`, 'text/html');
  const inline = new Set();
  const allowed = new Set(['P','BR','B','STRONG','I','EM','U','UL','OL','LI','H2','H3','H4','BLOCKQUOTE','CODE','PRE','TABLE','THEAD','TBODY','TR','TH','TD','SUP','SUB','A','HR','DIV','SPAN','FIGURE','FIGCAPTION']);
  const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH','TEMPLATE']);
  const clean = node => {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE || blocked.has(node.tagName)) return '';
    if (node.tagName === 'IMG') {
      const candidates = srcset(node.getAttribute('srcset') || node.getAttribute('data-srcset'));
      const url = safeMediaUrl(node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src')) || safeMediaUrl(candidates.split(',')[0]?.trim().split(/\s+/)[0]);
      if (!url) return missing();
      inline.add(url);candidates.split(',').forEach(x => inline.add(x.trim().split(/\s+/)[0]));
      return imageMarkup(url,node.getAttribute('alt'),candidates);
    }
    if (node.tagName === 'PICTURE') {
      // Keep its position; choose the first valid source if the fallback image is absent.
      const img = node.querySelector('img');
      if (img) {
        const source = [...node.querySelectorAll('source')].map(n => srcset(n.getAttribute('srcset') || n.getAttribute('data-srcset'))).find(Boolean);
        if (source && !img.getAttribute('srcset')) img.setAttribute('srcset', source);
        return clean(img);
      }
      const source = [...node.querySelectorAll('source')].map(n => srcset(n.getAttribute('srcset') || n.getAttribute('data-srcset'))).find(Boolean);
      if (!source) return missing();
      const url = source.split(',')[0].trim().split(/\s+/)[0];inline.add(url);return imageMarkup(url,'Question content image',source);
    }
    const children = [...node.childNodes].map(clean).join('');
    if (node.tagName === 'A') {
      try { const url = new URL(node.getAttribute('href'));return ['http:','https:','mailto:'].includes(url.protocol) ? `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${children}</a>` : children; } catch { return children; }
    }
    if (!allowed.has(node.tagName)) return children;
    // Preserve an explicit background-image at its original element; never copy arbitrary CSS.
    const background = /(?:background(?:-image)?)\s*:[^;]*url\(\s*['"]?([^'"\)]+)['"]?\s*\)/i.exec(node.getAttribute('style') || '');
    let media = '';
    if (background) {const url=safeMediaUrl(background[1]);if(url){inline.add(url);media=imageMarkup(url,'Question content image');}else media=missing();}
    const tag = node.tagName.toLowerCase();
    if (tag === 'br' || tag === 'hr') return `<${tag}>`;
    const span = ['td','th'].includes(tag) ? ['colspan','rowspan'].map(k => /^\d{1,2}$/.test(node.getAttribute(k) || '') ? ` ${k}="${node.getAttribute(k)}"` : '').join('') : '';
    return `<${tag}${span}>${media}${children}</${tag}>`;
  };
  // Sanitize the entire parsed body, even if malformed markup closes the wrapper early.
  const content = [...doc.body.childNodes].map(clean).join('');
  const seen = new Set(inline);
  const appended = (Array.isArray(references) ? references : []).map(ref => {
    const raw=mediaReference(ref),url=safeMediaUrl(raw),key=url||raw;
    if (seen.has(key)) return '';seen.add(key);
    return url ? imageMarkup(url, typeof ref === 'object' ? ref.alt : '') : missing();
  }).join('');
  return content + appended;
}
export function questionContent(question, placement) {
  const explanation = placement === 'explanation';
  const html = explanation ? (question.explanation_html ?? question.explanation ?? '') : (question.question_text ?? (question.raw_text || question.text || ''));
  const references = explanation ? (question.explanation_images || []) : [...(question.question_images || []), ...(question.image_url ? [question.image_url] : [])];
  return renderContent(html, references) + (explanation ? supplementaryMedia(question) : '');
}
function supplementaryMedia(question) {
  const audio = question.audio || question.audio_url;
  const entries = audio && typeof audio === 'object' && !mediaReference(audio) ? Object.entries(audio) : audio ? [['Audio', audio]] : [];
  const seen = new Set();
  const sounds = entries.map(([language, reference]) => {
    const url = safeMediaUrl(reference); if (!url || url.startsWith('data:') || seen.has(url)) return ''; seen.add(url);
    const label = {eng:'English',hindi:'Hindi'}[language] || language;
    return `<div class="content-audio"><label>${escape(label)} audio</label><audio data-content-media controls preload="none" src="${escape(url)}"></audio></div>`;
  }).join('');
  const video = safeMediaUrl(question.video_url || question.video);
  const link = video && !video.startsWith('data:') ? `<a class="button secondary compact" href="${escape(video)}" target="_blank" rel="noopener noreferrer">Open original video</a>` : '';
  return sounds || link ? `<div class="content-media-controls">${sounds}${link}</div>` : '';
}
const installed = new WeakSet();
export function installMediaFailures(root) {
  if (installed.has(root)) return; installed.add(root);
  root.addEventListener('error', event => {
    const img = event.target;
    if (!img.matches?.('img[data-content-image],audio[data-content-media]')) return;
    const notice = document.createElement('span');notice.className='media-unavailable';notice.setAttribute('role','status');notice.textContent=`${img.tagName === 'AUDIO' ? 'Audio' : 'Image'} unavailable — the source could not be loaded.`;img.replaceWith(notice);
  }, true);
}
