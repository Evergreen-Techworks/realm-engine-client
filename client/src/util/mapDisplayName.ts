/**
 * Human-readable map title from MAPINFO {@code displayName} / {@code name}.
 * Localized tokens look like {@code {s.rotmg}} — we map that one to "Realm".
 */
export function normalizeMapDisplayName(displayName: unknown, name?: unknown): string {
  const display = String(displayName ?? '').trim();
  const raw = display || String(name ?? '').trim();
  if (!raw) return '';

  const localized = raw.match(/^\{s\.([^}]+)\}$/i);
  if (!localized) return raw;

  const token = String(localized[1] || '').trim();
  const leaf = token.includes('.') ? token.split('.').pop() || token : token;
  const cleaned = leaf.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return raw;
  if (cleaned.toLowerCase() === 'rotmg') return 'Realm';
  return cleaned;
}
