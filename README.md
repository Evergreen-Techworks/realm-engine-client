  # Realm Engine — Free Open-Source RotMG Hacks, Client & SDK

  [![Website](https://img.shields.io/badge/site-realmengine.org-14b8a6)](https://realmengine.org)
  [![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/CGuYyTbf)
  [![License](https://img.shields.io/badge/license-Open%20Source-14b8a6)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20x64-0d9488)](https://realmengine.org/download)
  [![Stars](https://img.shields.io/github/stars/Evergreen-Techworks/realm-engine-client?style=social)](https://github.com/Evergreen-Techworks/realm-engine-client/stargazers)
  [![Buy Me A Coffee](https://img.shields.io/badge/buy_me_a_coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/egtw)

  **Realm Engine** is the free, open-source hacking platform for **Realm of the Mad God (RotMG / Exalt)**. Autonexus, WASD autododge, cursor autoaim, autoloot, advanced pathfinding, tile spoofing, hack builder — every line on GitHub. No subscription, no gem grind, no paywall.

  > **TL;DR:** A full RotMG hack stack — Electron client, IL2CPP DLL injector, and TypeScript SDK — published free and open source. Clone it, fork it, sell your own builds.

  🌐 **Site:** [realmengine.org](https://realmengine.org)  ·  💬 **Discord:** [discord.gg/CGuYyTbf](https://discord.gg/CGuYyTbf)  ·  ⬇️ **Download:** [realmengine.org/download](https://realmengine.org/download)

  ---

  ## ✨ Features

  ### Combat
  - **Autonexus** — pulls you out the instant a fight turns lethal
  - **WASD Autododge** — movement-aware dodge logic for cleaner projectile avoidance
  - **Cursor Autoaim** — locks aim on target while you move
  - **Damage Sniffer** — live damage readout for you and nearby players on bosses

  ### Movement
  - **Advanced Pathfinding** — smooth, reliable routing
  - **Tile Spoofing** — stops push tiles from yanking you off course
  - **Auto Kill Gods** — clear godlands for steady fame and loot
  - **Quick Travel** — get where you're going without the busywork

  ### Hacks & Tools
  - **Hack Builder + Behavior Tab** — visual triggers, conditions, and actions, no code required
  - **Autoloot** — rules for tiers, gear categories, and consumables
  - **TypeScript SDK** — write your own hacks against a typed API

  ---

  ## 🧱 Repository layout

  ### [`client/`](./client) — Electron desktop client (`realm-engine`)
  RotMG Exalt MITM proxy + automation dashboard. Windows-targeted Electron app that talks to the game, runs the hacks, and hosts the UI. Built with `electron-builder` (`npm run dist`, `dist:installer`, `dist:portable`) and includes a native module step (`npm run build:native`).

  ### [`internal/`](./internal) — C++ IL2CPP DLL injection
  Native side. Visual Studio 2022 solution (`il2cpp-dll-injection.sln`) that produces `version.dll` — a Windows DLL that hijacks the real `version.dll` for auto-load at game launch, hooks IL2CPP methods, and detours `IDXGISwapChain::Present` for the in-game overlay. Output goes
  to `x64/Release/`.

  ### [`sdk/`](./sdk) — TypeScript script-development kit (`@realmengine/sdk`)
  The typed surface that hack authors write against. `npm run build` produces the package; consume it from your own script project, then drop the compiled output into the client's plugin folder.

  ---

  ## 🚀 Quick Start

  **Run the desktop client (no build required):**
  👉 [realmengine.org/download](https://realmengine.org/download)

  **Build the client from source (Windows):**
  ```bash
  git clone https://github.com/Evergreen-Techworks/realm-engine-client.git
  cd realm-engine-client/client
  npm install
  npm run dev       # dev mode
  npm run dist      # production installer build
  ```

  **Build the native DLL (Visual Studio 2022, toolset v145):**
  ```bash
  cd internal
  msbuild il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64
  # output: x64/Release/version.dll
  ```

  **Build the SDK:**
  ```bash
  cd sdk
  npm install
  npm run build
  ```

  ---

  ## ❓ FAQ

  **Wait — it's actually free?**
  Yes. Engine, client, every hack. No subscription, no gem economy, no trial that turns into a bill.

  **Why is Realm Engine open source?**
  The RotMG hacking scene gets better when the tools aren't held hostage. Raising the floor beats hoarding a moat.

  **Can I sell hacks I build on top of this?**
  Yes. Fork it, build on it, charge for your own work. Just don't claim you wrote the parts you didn't.

  **What OS is supported?**
  Windows x64 only. The client is Electron; the injection layer is a native Win32 DLL. macOS / Linux / Wine are not supported.

  **How do I report a bug or request a feature?**
  Open an issue here or hop into the [Discord](https://discord.gg/CGuYyTbf) — bug reports and feature requests are triaged there.

  ---

  ## 🤝 Contributing

  PRs welcome. Pick an open issue, ship a hack, or rewrite something better.

  ---

  ## 🔗 Related

  - **Website & web app:** [realmengine.org](https://realmengine.org)
  - **Discord community:** [discord.gg/CGuYyTbf](https://discord.gg/CGuYyTbf)
  - **Lore / origin story:** [realmengine.org/lore](https://realmengine.org/lore)

  ---

  ## 📄 License

  Open source. See [LICENSE](LICENSE) for details.

  ---

  <details>
  <summary><strong>Keywords (for search indexing)</strong></summary>

  realm engine, realm engine rotmg, rotmg hacks, rotmg cheats, rotmg mods, rotmg hack client, rotmg mod client, realm of the mad god hacks, realm of the mad god mods, open source rotmg, rotmg autonexus, rotmg autododge, rotmg autoloot, rotmg pathfinding, rotmg hack builder, exalt
   hacks, exalt mods, IL2CPP injection, RotMG, RotMG Exalt
  </details>
