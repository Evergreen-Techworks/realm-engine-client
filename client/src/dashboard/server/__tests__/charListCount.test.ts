import { describe, it, expect } from 'vitest';
import { countLivingCharacters } from '../charListCount.js';

// The char/list XML DECA returns (AccountService.fetchCharListXml) lists only
// LIVING characters as <Char ...> nodes. The Test Lab runner's no-character
// check (2026-09-20 defect D1) turns "0 living characters" into a one-line
// answer instead of a silent never-in-world day-killer, so the counting has
// to be exact about what is and is not a character node.
describe('countLivingCharacters', () => {
  it('counts each <Char ...> node once', () => {
    const xml = '<Chars nextCharId="3"><Account name="lab" /><Char id="1" objectType="782" /><Char id="2" objectType="784" level="20" /></Chars>';
    expect(countLivingCharacters(xml)).toBe(2);
  });

  it('is 0 for an account with no living characters', () => {
    const xml = '<Chars nextCharId="4"><Account name="lab"><Stats /><MaxedStats>0</MaxedStats></Account></Chars>';
    expect(countLivingCharacters(xml)).toBe(0);
  });

  it('does not count similarly-named nodes (<Chars>, <Character>, text mentions)', () => {
    const xml = '<Chars nextCharId="1"><Account name="lab"><Description>Char class info</Description><CharacterSlots>1</CharacterSlots></Account></Chars>';
    expect(countLivingCharacters(xml)).toBe(0);
  });

  it('counts a self-closing <Char/> node', () => {
    const xml = '<Chars><Char/></Chars>';
    expect(countLivingCharacters(xml)).toBe(1);
  });

  it('is 0 for an empty string (caller guards the error case)', () => {
    expect(countLivingCharacters('')).toBe(0);
  });
});
