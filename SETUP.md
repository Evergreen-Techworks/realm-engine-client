# Setup — regenerating stripped build artifacts

To keep the source small enough to distribute, large **regenerable** files are
not committed (they're in `.gitignore`):

| Not committed | ~Size | How to regenerate |
|---|---|---|
| `internal/src/game/generated/il2cpp-*.h` | ~94 MB | Dump from your game (step 1) |
| `client/data/objects.xml`, `client/data/tiles.xml`, `internal/data/objects.xml` | ~85 MB | `npm run download-game-xml` (step 2) |
| `client/assets/realm-engine.dll`, `winhttp.dll`, `injector.exe` | ~2.7 MB | `build-all.bat` (step 3) |

The first two regenerate per RotMG build — the game's IL2CPP offsets and
obfuscated names change on every update, so you re-run these after each patch.

The native binaries in `client/assets/` are compiled from source in this repo.
They used to be committed, which meant the shipped copies were only ever as
current as whoever last built them by hand, and every rebuild added another
multi-MB blob to git history. `build-all.bat` builds all three; the automated
release builder does the same.

You need the **RotMG Exalt** game installed (you need it to inject anyway).

---

## 0. Prerequisites

`build-all.bat` verifies all six of these before building and prints every
missing one in one run. None of them are optional:

| # | Requirement | If missing |
|---|---|---|
| 1 | Visual Studio 2022+ with the C++ x64 workload (Build Tools alone are enough) | [visualstudio.microsoft.com/downloads](https://visualstudio.microsoft.com/downloads/) — "Build Tools for Visual Studio 2022" |
| 2 | .NET 10 runtime (the committed `tools\Il2CppInspector.exe` is a .NET 10 app) | [dotnet.microsoft.com/download/dotnet/10.0](https://dotnet.microsoft.com/download/dotnet/10.0) — x64 Desktop Runtime |
| 3 | Node.js 20.12+ / npm | [nodejs.org](https://nodejs.org) — current LTS |
| 4 | RotMG Exalt installed | Auto-located (Deca launcher + common Steam paths). Custom Steam library drive? Set `ROTMG_PATH` to the folder containing `GameAssembly.dll` |
| 5 | Internet access to `builds.him.is` | Serves the decrypted game metadata. Skip the probe entirely by placing `tools/global-metadata.decrypted.dat` yourself |
| 6 | Windows x64 with ~4 GB free | node_modules + Electron cache + two ~160 MB packages |

`tools\Il2CppInspector.exe` ships in this repo — you do **not** need to build
Il2CppInspectorPro yourself.

---

## 1. Dump the il2cpp headers

The C++ DLL (`internal/`) `#include`s generated headers that describe the
game's classes, field offsets, and function addresses. Regenerate them with
**Il2CppInspectorPro** (the tool that produced the originals):

1. Get Il2CppInspectorPro: https://github.com/Jadis0x/Il2CppInspectorPro
2. Point it at your install's two files:
   - `…/RotMG Exalt/RotMG Exalt_Data/il2cpp_data/Metadata/global-metadata.dat`
   - `…/RotMG Exalt/GameAssembly.dll`
3. Generate the **C++ scaffold / application headers**.
4. Copy the resulting `il2cpp-*.h` files into:
   ```
   internal/src/game/generated/
   ```
   (`il2cpp-types.h`, `il2cpp-functions.h`, `il2cpp-types-ptr.h`,
   `il2cpp-api-functions.h`, `il2cpp-api-functions-ptr.h`,
   `il2cpp-metadata-version.h`)

Re-dump whenever the game updates.

---

## 2. Download the game XML

The client reads item/projectile/tile data from `objects.xml` + `tiles.xml`.
Fetch them (tries your local game install → official CDN → public mirror):

```bash
cd client

# → client/data/  (read by the client app at startup)
npm run download-game-xml -- --dir ./data

# → %USERPROFILE%/Documents/Realmengine/data/  (read by the DLL skin feature)
npm run download-game-xml
```

Add `-- --force` to re-fetch after a game update.

> The app still boots without these (it logs a warning and those features are
> just incomplete), so this step is recommended, not mandatory to launch.

---

## 3. Build

Once steps 1–2 are done, build as normal — see the README / `client/package.json`
scripts (`npm run build:native`, `npm run build:prod`, `npm run dist`, …).
