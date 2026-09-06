/**
 * Community-facing string enum of status effects. This is a SEPARATE public
 * surface from the proxy runtime's canonical bit-index map in
 * `src/constants/ConditionEffect.ts` — the two are intentionally NOT merged.
 * This set diverges (adds CURSED/EXPOSED, omits the *Immune variants); the
 * reconciliation is deferred (see docs/plans/14). Do not change the public
 * members here without a coordinated SDK version bump.
 */
export enum StatusEffect {
    CURSED        = 'cursed',
    SLOWED        = 'slowed',
    STUNNED       = 'stunned',
    BLIND         = 'blind',
    HALLUCINATING = 'hallucinating',
    DRUNK         = 'drunk',
    CONFUSED      = 'confused',
    STASIS        = 'stasis',
    INVISIBLE     = 'invisible',
    ARMORED       = 'armored',
    INVINCIBLE    = 'invincible',
    SPEEDY        = 'speedy',
    HEALING       = 'healing',
    DAMAGING      = 'damaging',
    BERSERK       = 'berserk',
    PETRIFIED     = 'petrified',
    SICK          = 'sick',
    BLEEDING      = 'bleeding',
    QUIET         = 'quiet',
    EXPOSED       = 'exposed',
    HEXED         = 'hexed',
}
