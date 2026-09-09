# §G
Vibrate configured Lovense toy when local player loses HP.

# §C
- TypeScript/Node implementation inside Electron proxy.
- Use Lovense Remote local Game Mode API; no developer token or cloud account.
- Disabled by default. User opts in through `data/config.json`.
- Toy/network failure must never block packets, crash proxy, or expose secrets.
- Branch: `codex/lovense-damage-integration`.
- Commit author: `Anonymous Contributor <anonymous@users.noreply.github.com>`.

# §I
- `I.config`: `lovense` object in merged client config: `enabled`, `endpoint`, optional `toyId`, `minStrength`, `maxStrength`, `damagePercentForMaxStrength`, `pulseSeconds`, `cooldownMs`.
- `I.damage`: server `UPDATE`/`NEWTICK` local-player HP stat transitions.
- `I.lovense`: POST `{ command: "Function", action: "Vibrate:<1..20>", timeSec, apiVer: 1, toy? }` to configured local `/command` endpoint with `X-platform: Realm Engine`.

# §V
- `V1`: Initial HP observation, healing, unchanged HP, player replacement, and map transition emit no vibration.
- `V2`: HP decrease emits one bounded strength derived from damage as percent of effective max HP.
- `V3`: Cooldown suppresses repeated commands inside configured interval.
- `V4`: Disabled/invalid config and HTTP/network/API errors remain non-fatal and do not alter game packets.
- `V5`: No Lovense developer token, user identity, or toy secret enters source or logs.

# §T
id|status|goal|cites
T1|x|add tested Lovense damage feedback, config defaults, and setup docs|V1,V2,V3,V4,V5,I.config,I.damage,I.lovense

# §B
id|date|cause|fix
