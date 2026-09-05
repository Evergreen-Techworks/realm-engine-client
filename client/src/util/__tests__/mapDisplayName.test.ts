import { describe, expect, it } from 'vitest';
import { normalizeMapDisplayName } from '../mapDisplayName.js';

describe('normalizeMapDisplayName', () => {
  it('falls back to the packet name when displayName is blank', () => {
    expect(normalizeMapDisplayName('', 'Realm of the Mad God'))
      .toBe('Realm of the Mad God');
  });

  it('normalizes the localized Realm display token', () => {
    expect(normalizeMapDisplayName('{s.rotmg}', 'Realm of the Mad God'))
      .toBe('Realm');
  });

  it('prefers a non-blank display name', () => {
    expect(normalizeMapDisplayName('The Shatters', 'Internal Name'))
      .toBe('The Shatters');
  });
});
