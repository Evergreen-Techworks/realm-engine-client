/**
 * Pure count of living characters in a Deca char/list XML payload.
 *
 * char/list only ever lists LIVING characters as `<Char ...>` nodes — dead
 * ones simply stop appearing (nextCharId keeps climbing). The Test Lab
 * runner's no-character check (2026-09-20 defect D1) reads exactly this
 * number: an account with zero living characters can never reach the world,
 * and reporting that as `no-character` instead of `never-in-world` turns a
 * silent day-killer into a one-line answer.
 *
 * Kept dependency-free and separate from AccountService so it is trivially
 * testable — AccountService's own parseDashboardAccountOverview wants the
 * full inventory, which is far more than this question needs.
 */

/** Matches `<Char` followed by whitespace, `>` or `/` — not `<Chars`, `<Character`. */
const CHAR_NODE = /<Char[\s/>]/g;

export function countLivingCharacters(charListXml: string): number {
  if (!charListXml) return 0;
  const matches = charListXml.match(CHAR_NODE);
  return matches ? matches.length : 0;
}
