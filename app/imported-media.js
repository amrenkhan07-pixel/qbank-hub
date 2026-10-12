// Resolve durable imported media only when the selected question payload is loaded.
// Original URLs remain a fallback; signed URLs are never stored in source payloads.
export async function resolveImportedMedia(db, media) {
  const paths = [...new Set(media.map(item => item.storage_path).filter(path => typeof path === 'string' && /^marrow\/qbank-v1\/[a-f0-9]{64}\.(jpeg|png|webp)$/.test(path)))];
  if (!paths.length) return media.filter(item => item.type !== 'tracking');
  try {
    const data = [];
    for (let index = 0; index < paths.length; index += 100) {
      const result = await db.storage.from('question-media').createSignedUrls(paths.slice(index, index + 100), 3600);
      if (result.error) throw result.error;
      data.push(...(result.data || []));
    }
    const urls = new Map((data || []).filter(item => !item.error && item.signedUrl).map(item => [item.path, item.signedUrl]));
    return media.filter(item => item.type !== 'tracking').map(item => ({ ...item, reference: urls.get(item.storage_path) || item.reference }));
  } catch {
    return media.filter(item => item.type !== 'tracking');
  }
}
