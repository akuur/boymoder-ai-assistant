# Boymoder AI Assistant

oh—uhh, h-hey... welcome to my repository, i guess??  
i'm **Boymoder**, your slightly anxious, overly caffeinated desktop pet & AI coding orchestrator built with **Tauri v2**, vanilla TypeScript, and `@opencode-ai/sdk` talking to a local `opencode serve` backend.

mostly i just hide in my oversized hoodie on your screen, scroll on my phone or curl up for a nap when nothing is happening, and—when you actually give me something to do—panic a little bit and delegate the scary coding tasks to smaller helper pets so nobody breaks `master`. (unless you want me to edit stuff directly in Build mode, which is fine too!! i'll try my best!!)

---

## What i can actually do (features)

- **two window modes (Docked & Free-Roam Desktop Pet):**
  - **Docked Window:** clean DeepSeek-inspired interface with a collapsible `Projects` & `Chats` sidebar, pin/rename/move/remove right-click menus, weighted drag-and-drop chat reordering, live `tok/s` & active-agent telemetry, searchable subscription-grouped model & thinking-depth selectors, and an OpenCode **Statistics** page.
  - **Free-Roam Overlay (`Pets On`):** transparent `alwaysOnTop` overlay (`wlr-layer-shell` on Wayland, `alwaysOnTop` on X11/Windows/macOS) with click-through empty space so you can keep working while i wander around your taskbar, sit, sleep, pull up my laptop to talk with friends, or get grabbed and thrown across your monitor.
- **three modes (`Plan`, `Build`, `Orchestration`):**
  - **Plan** *(default)*: read-only planning so we figure out what's going on before touching any files.
  - **Build:** direct single-session coding & debugging (`Thinking...`, `Building...`, `Debugging...`, `Inspecting...`).
  - **Orchestration:** splits multi-step tasks into parallel subtasks (`Research`, `Execution`, `Testing`, `Review`, etc.) with optional `git worktree` isolation so parallel helper pets don't step on each other.
- **polite permission bubbles:** whenever any agent wants to edit a file or run a terminal command that needs approval, a clean text-only speech bubble pops up above that character with `[Approve]`, `[Always]`, and `[Deny]` buttons.
- **auto-connects on launch:** checks for or spawns an authenticated `opencode serve` instance bound strictly to `127.0.0.1` so nothing is exposed outside localhost.

---

## Prerequisites

you'll need these installed before running me locally:

- **Node.js 20+** and **npm**
- **Rust toolchain** (`cargo` / `rustc`)
- **`opencode` CLI** on your `PATH`
- **Linux system packages (Tauri v2):** `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `libayatana-appindicator`
  - *Optional (recommended on Wayland):* `gtk-layer-shell` (`libgtk-layer-shell.so.0`) so desktop pets stay above every application window on Wayland compositors.

---

## Quickstart

```bash
git clone https://github.com/<your-username>/boymoder-ai-assistant.git
cd boymoder-ai-assistant
npm install
```

verify everything builds cleanly:

```bash
npm run typecheck
npm run build
npm test
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

start the app (it automatically checks for or spawns `opencode serve` on `127.0.0.1:4096`, or you can start `opencode serve` yourself beforehand):

```bash
# optional: start opencode serve manually first
opencode serve --hostname 127.0.0.1 --port 4096

# launch Boymoder AI Assistant
npm run tauri dev
```

---

## Custom characters & 9-pose sprite system (`assets/pets/`)

you can drop your own transparent 2D PNGs straight into `assets/pets/` without recompiling—just open **Settings (`⚙`) → Reload Sprites** to hot-reload them:

```text
assets/pets/
├── orchestrator/             # main Boymoder character
│   ├── idle.png              # (or multi-frame: idle_1.png, idle_2.png, idle_3.png)
│   ├── walk.png              # (or walk_1.png .. walk_4.png)
│   ├── work.png              # (or work_1.png .. work_3.png)
│   ├── fall.png              # (or fall_1.png, fall_2.png)
│   ├── sit.png               # (or sit_1.png, sit_2.png)
│   ├── sleep.png             # (or sleep_1.png, sleep_2.png)
│   ├── happy.png
│   ├── phone.png             # (optional bored animation: phone_1.png, phone_2.png)
│   ├── chat.png              # (optional bored animation: chat_1.png .. chat_3.png)
│   ├── alert.png
│   └── error.png
└── subagents/
    ├── default/              # fallback sprites for helper pets
    │   ├── idle.png
    │   ├── walk.png
    │   ├── work.png
    │   ├── fall.png
    │   ├── sit.png
    │   ├── sleep.png
    │   ├── happy.png
    │   ├── alert.png
    │   └── error.png
    └── research/             # optional role-specific folders (research, execution, testing, review, etc.)
```

the 9 core poses are **`idle`**, **`walk`**, **`work`**, **`fall`**, **`sit`**, **`sleep`**, **`happy`**, **`alert`**, and **`error`** (plus optional `phone` & `chat` idle variations, and numbered `<state>_1.png`, `<state>_2.png`, ... frames for multi-frame animations).

> **careful:** `npm run generate:pets` only fills in missing placeholder PNGs. don't pass `--force` unless you actually want to overwrite custom artwork in `assets/pets/` with generated placeholders.

---

## building & releasing

if you want to build installers locally for your current OS:

```bash
npm run tauri build
```

to trigger an automated multi-platform GitHub Release (`.AppImage` & `.deb` for Linux, `.msi` & `.exe` for Windows, and unsigned universal `.dmg` / `.app` for macOS) via `.github/workflows/release.yml`:

1. bump `"version"` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` to match (e.g. `0.1.0`).
2. commit, tag, and push the version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. the workflow creates a draft release named `Boymoder AI Assistant v0.1.0` with all platform artifacts attached (you can also trigger it manually from GitHub Actions via **Run workflow**).

---

## license

[MIT](LICENSE)
