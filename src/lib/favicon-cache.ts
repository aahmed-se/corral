import type { FaviconRow } from './db.ts';

export type FaviconSource = { mode: 'chrome' | 's2'; prefix: string; retryFailures: boolean };

export const FAVICON_OK_FRESH_MS = 30 * 24 * 3_600_000;
export const FAVICON_MISSING_RETRY_MS = 24 * 3_600_000;
export const FAVICON_ERROR_RETRY_MS = 15 * 60_000;

/** Successful icons stay warm for a month. Failures cool down briefly during
 * resumed work, but an explicit user refresh retries them immediately. */
export function faviconNeedsFetch(row: FaviconRow | undefined, now: number, retryFailures: boolean) {
  if (!row) return true;
  const age = Math.max(0, now - row.fetchedAt);
  if (row.status === 'ok') return age > FAVICON_OK_FRESH_MS;
  if (retryFailures) return true;
  return age > (row.status === 'missing' ? FAVICON_MISSING_RETRY_MS : FAVICON_ERROR_RETRY_MS);
}

/** Chrome's local favicon database works best with URLs it has actually seen.
 * Invalid and non-web bookmarks are excluded. These URLs are only used with
 * the extension-local `_favicon` endpoint, never the external preview relay. */
export function chromeFaviconPageUrlCandidates(host: string, samples: string[]) {
  const candidates = new Set<string>();
  for (const raw of samples) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.href.length <= 2_048) candidates.add(url.href);
      candidates.add(`${url.origin}/`);
    } catch {
      // Another sample may still be usable.
    }
  }
  if (candidates.size > 0) {
    candidates.add(`https://${host}/`);
    candidates.add(`http://${host}/`);
  }
  return Array.from(candidates);
}

export function chromeFaviconUrl(prefix: string, pageUrl: string) {
  const url = new URL(prefix);
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.toString();
}

/** The dev preview preserves its existing privacy behavior: only the base
 * hostname is sent to the same-origin relay (and from there to Google). */
export function previewFaviconUrl(prefix: string, host: string) {
  return `${prefix}${encodeURIComponent(host)}`;
}
