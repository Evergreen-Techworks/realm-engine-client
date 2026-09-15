# Shooting binding and cadence evidence

Implementation base: `9d316adbbd0c4e2250907e85987595477de32bd7`.
Inspected: 2026-09-15. No game process was launched, stopped or modified.

## Current pin

Read-only hashes of the owner's installed Production game match the stored live collector pin:

| Artifact | SHA-256 |
| --- | --- |
| GameAssembly.dll | `86ad651b675dd677718b3bbd111f6a75fb80d7d167f233c2b170085ab977d788` |
| global-metadata.dat | `82d6cf0adc3b0da40795d3ea9b5fe4501cf66d061f2db6b39b5780382afa04e2` |
| Live collection.json | `d305313e53e4289447fd89630c0bffdf77bf6936892a8da79f3533a7b2fb141a` |

The collector artifact is `/home/jesse/realm-engine-fixtures/collector-86ad651b/collection.json`; its adjacent `PROVENANCE.txt` records the 2026-09-12 live collection. Stored generated bindings at `C:\realm-engine-pinned\binding-port\task13-build-20260913-205048\BuildBindings.generated.h` contain matching method rows and game hashes. These are inspected historical artifacts, not a newly built DLL or new gameplay evidence.

## Binding inspection

| Source token | Collector declaration | Existing generated row | Status |
| --- | --- | --- | --- |
| SWA `FKALGHJIADI.EHGHCACPAGH` | non-generic, flags 134, `System.Void(System.Single)` | one argument; RVA 19089280 | Existing target retained; metadata matches stored build binding |
| CSA `LKHPPBEGNOM.ELCBJAFBLJG` | non-generic, flags 134, `System.Void(System.Byte, System.Single&, System.Boolean&, System.Boolean)` | four arguments; RVA 4083104 | Semantic manual-angle identity unverified; must not call or hook |

RVA numbers identify existing inspected evidence only. They are not new hardcoded callable addresses. Source uses the existing resolver and a generated-binding match, not a new address table.

At the base, `ShootRuntime` requires both pointers even for script firing. Its live-object dispatch calls `il2cpp_object_get_virtual_method` and falls back to the bound SWA. Collector flags do not independently establish that a particular live override is used; that behavior remains an empirical review item. Any virtual-dispatch cache must be reset with the resolved method state.

`AutoFire.cpp` already records that the routine named CSA is condition/status text on pins `4a8beb50` and `86ad651b`, including its immediate return for slot zero. This is existing source evidence, not newly repeated disassembly. No fifth-argument meaning or replacement angle method has been established in this task. The safe prerequisite is to refuse manual diagnostic firing and remove the CSA detour, while retaining Exalt's existing SWA scheduler behind boot and generated-method verification.

The binding pipeline is `BuildBindings::Method` plus `RuntimeOffsets::BindingsReady`; packaged rows are matched to live method pointers. BootGate also protects the required player/avatar anchors. An empty generated table or a resolved pointer without a matching generated method does not establish firing identity.

## Paired captures required

All six pairs are **pending owner capture**. Each pair must use identical equipment, stats, conditions and game pin for ordinary native input and script autofire:

1. Ordinary weapon.
2. Mixed-rate subattacks.
3. Burst longbow.
4. Pattern cycling.
5. Enchanted reduced fire rate.
6. Weapon switch during a burst.

Capture monotonic attempt/send times, verified weapon/subattack identifiers, target-angle changes, exact serialized PLAYERSHOOT bytes and observed server acceptance/rejection. Do not infer counts, cadence tolerance, field meaning or offsets from the ActionScript archive. Preserve every unknown byte. The fixture-directory README specifies provenance and validation requirements.

## Acceptance gates

- Current-pin input hashes: inspected and matching.
- Existing collector declarations/generated rows: inspected and matching.
- Callable manual-angle semantic identity and calling-convention review: **pending**.
- Six real paired weapon traces: **pending**.
- Native compiled runtime/binding smoke: **pending**, independent of host or MSVC syntax checks.
- Manual/script in-game acceptance without new server rejection: **pending**.

No statement here claims manual shooting is restored, cadence has improved, or shots were accepted in game. No second scheduler, archive fire-rate constants or packet-layout changes are authorized by this evidence.

## Safe isolation implemented

Diagnostic manual autofire and manual-angle computation now fail closed because CSA's semantic identity is unverified. Ordinary player input still follows the game's existing firing path; this change does not disable regular manual shooting. Script dispatch retains the existing AppEngine-update cadence and live-object virtual-method lookup/fallback. No manual-angle detour is installed.

Readiness additionally requires a nonempty packaged pin and an exact generated SWA method-row/live-pointer match. A compiled read-only check using the actual stored current-pin generated header confirmed the production `Method(ClassName(sourceClass), sourceMethod, 1)` lookup keys resolve its SWA row. This is identity evidence, not independent calling-convention or live override proof. Reset clears the virtual dispatch cache. The single resolution status log is bounded normal readiness reporting, not per-shot trace instrumentation.
