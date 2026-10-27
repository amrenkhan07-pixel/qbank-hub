// Resolve durable imported media only when the selected question payload is loaded.
// Original URLs remain a fallback; signed URLs are never stored in source payloads.
export async function resolveImportedMedia(db, media, { externalFirst = false, marrowMedia = new Set(), storageOnly = new Set() } = {}) {
  const blocked = new Set(externalFirst ? media.filter(item => marrowMedia.has(item) && storageOnly.has(item.reference)) : []);
  const external = new Set(externalFirst ? media.filter(item => marrowMedia.has(item) && !storageOnly.has(item.reference) && item.type === 'image' && /^https:\/\//.test(item.reference) && /^marrow\/qbank-v1\/[a-f0-9]{64}\.(jpeg|png|webp)$/.test(item.storage_path)) : []);
  if (external.size) fallbackDb = db;
  const decorate = item => external.has(item) ? { ...item, marrowFallbackPath: item.storage_path } : blocked.has(item) ? { ...item, reference: '' } : item;
  const paths = [...new Set(media.filter(item => !external.has(item)).map(item => item.storage_path).filter(path => typeof path === 'string' && /^marrow\/qbank-v1\/[a-f0-9]{64}\.(jpeg|png|webp)$/.test(path)))];
  if (!paths.length) return media.filter(item => item.type !== 'tracking').map(decorate);
  try {
    const data = [];
    for (let index = 0; index < paths.length; index += 100) {
      const result = await db.storage.from('question-media').createSignedUrls(paths.slice(index, index + 100), 3600);
      if (result.error) throw result.error;
      data.push(...(result.data || []));
    }
    const urls = new Map((data || []).filter(item => !item.error && item.signedUrl).map(item => [item.path, item.signedUrl]));
    return media.filter(item => item.type !== 'tracking').map(item => (external.has(item) ? decorate(item) : { ...item, reference: urls.get(item.storage_path) || (blocked.has(item) ? '' : item.reference) }));
  } catch {
    return media.filter(item => item.type !== 'tracking').map(decorate);
  }
}

// Only renderer-created, Marrow-scoped attributes can request this fallback.
let fallbackDb;
const pending = new Map();
export function tryMarrowFallback(img) {
  const path = img.dataset?.marrowFallbackPath;
  if (!/^marrow\/qbank-v1\/[a-f0-9]{64}\.(jpeg|png|webp)$/.test(path || '') || !fallbackDb || img.dataset.marrowFallbackAttempted) return false;
  img.dataset.marrowFallbackAttempted = 'true';
  img.removeAttribute('srcset');
  let request = pending.get(path);
  if (!request) {
    request = Promise.resolve().then(() => fallbackDb.storage.from('question-media').createSignedUrls([path], 3600))
      .then(result => {
        const item = result.data?.find(row => row.path === path && !row.error);
        if (result.error || !item?.signedUrl) throw new Error('Image fallback unavailable');
        return item.signedUrl;
      });
    pending.set(path, request);
    request.finally(() => pending.delete(path)).catch(() => {});
  }
  request.then(url => { if (img.isConnected) img.src = url; })
    .catch(() => { if (img.isConnected) img.dispatchEvent(new Event('error')); });
  return true;
}

// Lazy images get a bounded wait only once they approach the viewport.
export function watchMarrowImages(root, timeoutMs = 15000) {
  const watched = new WeakSet();
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target; visible.unobserve(img);
      if (img.complete && img.naturalWidth > 0) continue;
      const timer = setTimeout(() => {
        if (img.isConnected && !img.dataset.marrowFallbackAttempted && !(img.complete && img.naturalWidth > 0)) img.dispatchEvent(new Event('error'));
      }, timeoutMs);
      const clear = () => clearTimeout(timer);
      img.addEventListener('load', clear, {once:true});
      img.addEventListener('error', clear, {once:true});
    }
  }, {rootMargin:'200px'});
  const scan = node => {
    if (node.nodeType !== 1) return;
    const images = [...(node.matches?.('img[data-marrow-fallback-path]') ? [node] : []), ...node.querySelectorAll('img[data-marrow-fallback-path]')];
    for (const img of images) if (!watched.has(img)) { watched.add(img); visible.observe(img); }
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node.nodeType === 1) {
        if (node.matches?.('img[data-marrow-fallback-path]')) visible.unobserve(node);
        node.querySelectorAll('img[data-marrow-fallback-path]').forEach(img => visible.unobserve(img));
      }
      record.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, {childList:true,subtree:true}); scan(root);
}
