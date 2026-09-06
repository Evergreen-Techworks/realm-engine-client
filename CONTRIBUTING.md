# Contributing to Realm Engine

Realm Engine is a three-part project:

- **`client/`** — Electron MITM proxy + automation dashboard (TypeScript, `npm`)
- **`internal/`** — C++ IL2CPP DLL injector, `version.dll` (Visual Studio 2022)
- **`client/packages/sdk/`** — `@realmengine/sdk` TypeScript SDK for user-authored plugins (docs: [`sdk/README.md`](sdk/README.md))

This document is the pre-flight for contributors. The deep architectural
notes live next to the code they describe:

- Top-level: [`README.md`](README.md), [`SETUP.md`](SETUP.md)
- Native: [`internal/CLAUDE.md`](internal/CLAUDE.md),
  [`internal/docs/UPDATING_AFTER_GAME_PATCH.md`](internal/docs/UPDATING_AFTER_GAME_PATCH.md)

## Development environment

You need:

- **Windows 10/11 x64** — the client only supports Windows, and only x64.
  macOS / Linux / Wine are not supported.
- **RotMG Exalt** installed and playable — you'll need it to inject
  against, and its game files are the source-of-truth for the IL2CPP
  headers and XML data assets described in `SETUP.md`.
- **Node.js 20+**, npm (or pnpm — `pnpm-lock.yaml` is present too).
- **Visual Studio 2022** with the v145 toolset and Windows SDK 10.x
  (only if you'll be touching `internal/`).

First-time setup:

1. Clone the repo.
2. Follow [`SETUP.md`](SETUP.md) to regenerate the stripped IL2CPP headers
   and download the game XML — these are per-Exalt-build files that are
   not committed.
3. `cd client && npm install` (also installs `@realmengine/sdk` from
   `client/packages/sdk` via the `file:` dependency).
4. If you're touching native: open `internal/il2cpp-dll-injection.sln`.

Build recipes:

```bash
# Client (dev)
cd client && npm run dev

# Client (production installer / portable)
cd client && npm run dist          # both installer + portable
cd client && npm run dist:portable # portable exe only

# Native DLL (Release x64)
cd internal && msbuild il2cpp-dll-injection.sln \
  /p:Configuration=Release /p:Platform=x64
# Output: internal/x64/Release/version.dll
```

## Working on packet definitions or offsets

The wire protocol and the IL2CPP field offsets change every RotMG patch.
Two things need updating in lockstep:

- **Packet definitions** — `client/data/packet-definitions.json` is the
  single source of truth for both protocol stacks. Edit it, then run
  `cd client && npm run gen:packets` to regenerate every derived artifact
  (including `packages/protocol/src/generated/packet-map.ts`), and
  `npm run check:packets` to confirm nothing drifted. Never hand-edit a
  `*.generated.ts` or `packet-map.ts`. Details: `client/data/README.md`.
  Full runbook: `internal/docs/UPDATING_AFTER_GAME_PATCH.md`.
- **IL2CPP offsets** — `internal/src/core/runtime/RuntimeOffsets.cpp`.
  The offsets are static fallback values (the runtime self-healing /
  recovery system was removed); after a game patch, refresh them per the
  runbook when the in-game **Test → OFFSET HEALTH** panel goes yellow/red.

## Coding style

- **TypeScript** — TS 5.4, ESNext / ES2022 modules, `strict: true`.
  Prefer explicit types on exported symbols. `.js` extensions in `import`
  paths (bundler resolver).
- **C++** — C++20, MS ABI. Prefer the existing helpers
  (`Resolver::safe_call`, `RuntimeOffsets::ReadField<T>`,
  `DBG_FILE_LOG`) over rolling new SEH / logging wrappers.
- **Comments** — the existing code documents *why* offsets are what
  they are (see `RuntimeOffsets.h` for the pattern). Continue that
  when you add a new offset — the reason a value is what it is matters
  more than the value itself, because the value will change next patch.

## Scope discipline

The scope of this project is a RotMG hack platform. Please do not open
PRs that:

- add game features that require compromising external accounts,
  server infrastructure, or other players' data;
- add functionality outside the game (system-wide keyloggers, remote
  access, credential exfiltration to third-party services);
- change the license without prior discussion.

Everything that changes offsets / packets / hacks in the game itself is
fair game.

## Reporting bugs

- **Bug / crash** — open a GitHub issue with the log output. Enable the
  in-game Debug console (`_DEBUG` build) or check the `DbgFileLog` file
  to grab the stack context.
- **Feature request** — open a GitHub issue *or* drop it in
  [Discord](https://discord.gg/uEKPPWz9k4).
- **Security issue in the client itself** (e.g. the MITM proxy exposes
  something it shouldn't) — please report privately via a Discord DM to
  the maintainers before disclosing publicly.

## Pull requests

- Keep PRs focused — one feature or one bug per PR.
- Include a summary of what you tested (what game context, what hack
  configuration).
- If you're touching `RuntimeOffsets` or the packet map, note the
  Exalt build number you tested against.
- PRs are welcome. Just don't claim you wrote the parts you didn't.

## License

Open source. See [LICENSE](LICENSE).
