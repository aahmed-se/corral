// Protocols Chrome can safely navigate to from an extension page. Scriptable
// payload schemes are intentionally absent: imported files are untrusted.
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'chrome:', 'file:', 'ftp:', 'mailto:', 'tel:']);

export function openableBookmarkUrl(raw: string) {
  const value = raw.trim();
  try {
    return OPENABLE_PROTOCOLS.has(new URL(value).protocol.toLowerCase()) ? value : null;
  } catch {
    return null;
  }
}
