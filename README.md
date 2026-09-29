# Realm Engine — Open-Source RotMG Automation

[![Website](https://img.shields.io/badge/site-realmengine.org-14b8a6)](https://realmengine.org)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/uEKPPWz9k4)
[![License: MIT](https://img.shields.io/badge/license-MIT-14b8a6)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Wine%2FProton-0d9488)](https://realmengine.org/download)
[![Stars](https://img.shields.io/github/stars/Evergreen-Techworks/realm-engine-client?style=social)](https://github.com/Evergreen-Techworks/realm-engine-client/stargazers)

**Build it yourself, or let us do it for $2.**

Realm Engine is an open-source automation platform for **Realm of the Mad God (RotMG / Exalt)**. This repository holds the full desktop client, the native engine, the TypeScript SDK, and the hack library. Build everything yourself for free, or skip the setup and grab the ready-to-run Windows build for $2.

No subscription. Full source available.

🌐 **Site:** [realmengine.org](https://realmengine.org)  ·  💬 **Discord:** [discord.gg/uEKPPWz9k4](https://discord.gg/uEKPPWz9k4)  ·  ⬇️ **Ready-to-run build:** [realmengine.org/download](https://realmengine.org/download)

---

## Two ways to run it

|  | **Build from source** | **Ready-to-run build** |
|---|---|---|
| Price | $0 | $2 per download |
| What you get | Everything in this repo | The latest approved Windows build, compiled and packaged |
| Setup | Node, Visual Studio 2022, a game dump (see [Quick start](#-quick-start)) | None: download and run |
| Features | Everything | Everything, same project |
| Delivery | `git clone` | Privately through the [Discord](https://discord.gg/uEKPPWz9k4) bot |
| Best for | Developers and tinkerers | People who just want to play |

**You're paying for convenience, not access to the source.** No feature is held back from the source build.

> ⚠️ Third-party tools can lead to game-account bans and lost progress. Use Realm Engine at your own risk. Read the [purchase and game-risk notice](https://realmengine.org/purchase-notice) before buying.

---

## ✨ Features

Realm Engine is a modular platform with tools for combat, movement, loot, scripting, and behavior, not just a collection of toggles.

### Combat
- **Autonexus**: pulls you out the instant a fight turns lethal
- **WASD Autododge**: movement-aware dodge logic for cleaner projectile avoidance
- **Cursor Autoaim**: keeps your aim locked on target while you move
- **Damage Sniffer**: live damage readout for you and nearby players on bosses

### Movement
- **Advanced Pathfinding**: smooth, reliable routing
- **Quick Travel**: get where you're going without the busywork
- **Tile Spoofing**: stops push tiles from yanking you off course
- **Auto Kill Gods**: clear godlands for steady fame and loot

### Build your own
- **Hack Builder**: compose movement, combat, and loot logic into your own hack
- **Visual Behavior Editor**: triggers, conditions, and actions, no code required
- **Autoloot**: rules for tiers, gear categories, and consumables
- **TypeScript SDK**: write your own scripts and plugins against a typed API

---

## 🧱 Repository layout

### [`client/`](./client): Electron desktop client
RotMG Exalt proxy and automation dashboard. A Windows-targeted Electron app that talks to the game, runs the hacks, and hosts the UI. Built with `electron-builder` (`npm run dist`, `dist:installer`, `dist:portable`).

### [`internal/`](./internal): native engine (C++)
Visual Studio 2022 solution (`il2cpp-dll-injection.sln`) that builds `realm-engine.dll`, which hooks IL2CPP methods and draws the in-game overlay. Output goes straight to `client/assets/`.

### [`client/packages/sdk`](./client/packages/sdk): TypeScript SDK (`@realmengine/sdk`)
The typed surface that hack authors write against. See [`sdk/README.md`](./sdk/README.md) for how to write your first plugin.

---

## 🚀 Quick start

**Just want to play?** Get the ready-to-run build: 👉 [realmengine.org/download](https://realmengine.org/download)

**Building from source (Windows):**

Some large files are generated from your own game install instead of being committed: the IL2CPP headers (they change with every RotMG update) and the game XML. Follow [SETUP.md](SETUP.md) to regenerate them first. You need RotMG Exalt installed, Node.js, and Visual Studio 2022.

```bash
git clone https://github.com/Evergreen-Techworks/realm-engine-client.git
cd realm-engine-client

# After the SETUP.md steps, build the native binaries into client/assets/
build-all.bat

cd client
npm install
npm run dev            # dev mode
npm run dist:portable  # portable Windows EXE
```

**Build the SDK on its own:**
```bash
cd client/packages/sdk
npm install
npm run build
```

**Linux / Steam Deck (experimental, through Wine or Proton):**
Run the Windows build in the same Wine/Proton environment you use for RotMG Exalt. The client finds standard Steam, Flatpak Steam, Proton, and Steam Deck game locations through Wine's `Z:` mapping. For a custom game location, set `ROTMG_PATH` to the Exalt `Production` directory.

---

## ❓ FAQ

**Is Realm Engine free?**
Yes. Realm Engine is open source and can be built from this repo for free. If you'd rather skip the development environment and build process, a prepared Windows build is available for $2 per download.

**Why does the prepared build cost $2?**
You're paying for the convenience of having the current version compiled, packaged, and ready to run. You're always free to compile the same project yourself.

**Is there a subscription?**
No.

**Do I get fewer features if I build it myself?**
No. There's no feature tiering. The source build is the same project.

**Can I modify Realm Engine?**
Yes. It's MIT-licensed. Fork it, change it, build on the SDK, and create your own tools.

**What OS is supported?**
Windows x64 is fully supported. Linux and Steam Deck work experimentally through Wine/Proton. The native layer is still a Win32 DLL, so this is compatibility-layer support, not a native Linux backend. macOS is not supported.

**How do I report a bug or request a feature?**
Open an issue here or join the [Discord](https://discord.gg/uEKPPWz9k4), where bug reports and feature requests are triaged.

---

## 🤝 Contributing

Pull requests are welcome. Pick an open issue, ship a hack, or improve something that's already here. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📄 License

MIT. See [LICENSE](LICENSE).

---

<details>
<summary><strong>Keywords (for search indexing)</strong></summary>

realm engine, realm engine rotmg, rotmg hacks, rotmg cheats, rotmg mods, rotmg hack client, rotmg mod client, realm of the mad god hacks, realm of the mad god mods, open source rotmg, rotmg automation, rotmg autonexus, rotmg autododge, rotmg autoloot, rotmg pathfinding, rotmg hack builder, exalt hacks, exalt mods, IL2CPP injection, RotMG, RotMG Exalt, mcp, rotmg mcp, realm of the mad god mcp, realm engine mcp, model context protocol, mcp server, rotmg mcp server, claude mcp, rotmg diagnostics, il2cpp mcp, game mcp server
</details>
