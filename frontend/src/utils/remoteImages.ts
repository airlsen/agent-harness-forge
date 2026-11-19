const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const IMAGE_PATH_SEGMENT = /(?:^|\/)(?:img|image|images|original|thumbnail|thumb)(?:\/|$)/i;
const IMAGE_FORMATS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

/** Accept only absolute HTTP(S) links without credentials before placing them in an anchor. */
export function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Remote inline images are HTTPS-only; data:, blob:, and relative URLs stay out of chat HTML. */
export function normalizeRemoteImageUrl(value: string): string | null {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return null;
  return new URL(normalized).protocol === 'https:' ? normalized : null;
}

/**
 * There is no reliable way to infer a remote response's Content-Type without fetching it.
 * These common image path/extension hints cover normal CDNs, including OSS `/img/.../original` URLs.
 */
export function looksLikeImageUrl(value: string): boolean {
  const normalized = normalizeRemoteImageUrl(value);
  if (!normalized) return false;

  const url = new URL(normalized);
  if (IMAGE_FILE_EXTENSION.test(url.pathname) || IMAGE_PATH_SEGMENT.test(url.pathname)) return true;

  const format = url.searchParams.get('format')?.toLowerCase();
  const contentType = url.searchParams.get('content-type')?.toLowerCase();
  return IMAGE_FORMATS.has(format ?? '') || contentType?.startsWith('image/') === true;
}
