# Oryx runner implementation notes

The four RealmEye PDFs supplied on September 7, 2026 were read as text and their map diagrams inspected. Their content is dated June 2025. The live RealmEye URLs returned robots denials or empty downloads during development. No world coordinates or attack timings were inferred from diagram pixel dimensions.

## Dungeon structure verified from the supplied PDFs

| Dungeon | Source pages | Structure used by the runner |
| --- | --- | --- |
| [Castle](https://www.realmeye.com/wiki/oryx-s-castle) | 1–5 | Four southern island starts, bridges and three rooms per wing, a shared courtyard, then a northern room containing two Stone Guardians. Both guardians drop the Chamber entrance. Janus and Court are an optional branch beyond the guardians. |
| [Chamber](https://www.realmeye.com/wiki/oryx-s-chamber) | 1–3 | Circular arena, peripheral starts, central Oryx 1 and a ring of solid pillars. The Giant Oryx Chicken is a seasonal replacement. A Wine Cellar Incantation unlocks the dropped portal. |
| [Wine Cellar](https://www.realmeye.com/wiki/wine-cellar) | 1–3, 5–6 | Upper-right/lower-right starts and winding corridors leading around interior walls to the eastern boss room. Oryx 2 spawns Sanctuary rune monuments on defeat. Goo and disabling projectiles complicate travel. |
| [Sanctuary](https://www.realmeye.com/wiki/oryx-s-sanctuary) | 1–10, 14–15 | One assigned wing, three gated clear rooms (6/12/16 enemies), its miniboss, then a long hallway to central Oryx 3. North: Dammah; east: Gemsbok; south: Leucoryx; west: Beisa. Players cannot cross into other wings. Beisa changes his arena edges to void. |

## Implemented behavior

- Independent, map-scoped progression state; MAPINFO resets also handle a new instance with the same name.
- Connected terrain routing, using current static blockers and avoiding blocking, damaging and condition-effect tiles. Short path steps are given to Unified Dodge. Unknown terrain is explored toward a dungeon-specific directional hint. Closed gates remain impassable until their world objects disappear. Player/bag occupancy does not make floor impassable.
- Castle wall shooting works for props as well as enemies. Guardian targets switch when one becomes invulnerable. No Janus detour.
- Oryx 1/2/3 and all four Sanctuary minibosses have explicit target recognition. Nearby adds are handled during invulnerability; Leucoryx orbs and Oryx messengers receive priority. Missing bosses are retained briefly, then searched for again; disappearance alone never declares completion.
- Sanctuary room targets are restricted to its twelve standard enemy types and the reachable floor component. Miniboss deaths resume travel; only confirmed Oryx 3 death finishes Sanctuary.
- Expected portal destinations are allowlisted. Portal use retries every three seconds. Locked Wine Cellar portals are rejected even if the SDK's capacity-based `isOpen` field says true.
- One carried incantation can be consumed beside the locked Cellar portal. One of each carried rune can be offered beside a matching visible monument. No duplicate offers after a delayed inventory update. Unknown monument names or unavailable consumables cause a wait for the group.
- Ten-second post-clear loot windows; two-minute waits for optional progression gates; normal Nexus → Realm farming resumes after completion or an unavailable entrance.

## Combat limits and validation boundary

The SDK now exposes the server animation stat and the two Oryx 3 guard animations already recognized by the client's damage tracker. Guard observation stops automatic weapon fire and renews a connection-scoped Auto Ability pause. The pause expires within one second if the script stops; it does not change plugin settings or recall projectiles already fired. There is no blanket delay on normal vulnerability transitions.

Server chat includes its source object ID. Only a currently observed boss can supply a phase cue; matching a player's name or message cannot trigger it. Dammah's introduction holds weapons and abilities until his attack portals appear or an authenticated later-phase cue arrives. Celestial suspends target pursuit and automatic attacks until a recognized subsequent attack/stagger cue. Heavens is tracked for status while native dodge handles attacks. Gemsbok's coin shuffle suspends attacks until the artifacts resolve; selecting the correct shuffled artifact is not implemented.

Additional behavioral references inspected: [Dammah](https://wikiwiki.jp/rmd/Chancellor%20Dammah), [Oryx 3](https://wikiwiki.jp/rmd/Oryx%20the%20Mad%20God%203), and [Gemsbok](https://wikiwiki.jp/rmd/Treasurer%20Gemsbok). Phase cues are used as observations, not as fixed attack timers. Native Unified Dodge remains responsible for projectile and AoE avoidance. A missing/localized speech cue can leave a hold active; no timer guesses that Celestial has ended.

This implementation automates dungeon progression and adds the encounter controls above. It has not been validated in a live Oryx run. A complete independent Sanctuary solver still requires reliable coin-shuffle observations and validation of Celestial, Heavens and miniboss survival against live attacks; generic native avoidance does not establish that those encounters are solved.

Automated tests exercise progression, incorrect/locked portals, unlock consumption, loot deadlines, confirmed versus missing/revived bosses, guardian switching, all four miniboss branches, animation guards, authenticated phase cues, expiring ability pauses, static-wall corridor routing, room gates, dangerous terrain and map-state reset. They do not simulate the game's complete projectile field or certify encounter survival.
