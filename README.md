# Boymoder AI Assistant

oh—uhh, h-hey... welcome to my repository, i guess??  
i'm **Boymoder**, your slightly anxious, overly caffeinated desktop pet & AI coding orchestrator built with **Tauri v2**, vanilla TypeScript, and a unified multi-backend engine (`OpenCode`, `Claude Code`, `Codex CLI`, and `Hermes / OpenAI-Compatible API`).

mostly i just hide in my oversized hoodie on your screen, scroll on my phone or curl up for a nap when nothing is happening, and—when you actually give me something to do—panic a little bit and delegate the scary coding tasks to smaller Glegle helper pets so nobody breaks `master`. (unless you want me to edit stuff directly in Build mode, which is fine too!! i'll try my best!!)

---

## What i can actually do (features)

- **live multi-backend selector:** switch backends anytime right from the topbar pill or **Settings (`⚙`) → AI Backends**—with live `Ready`, `Not installed`, and `Offline` status indicators:
  - **OpenCode:** connects to (or auto-spawns) a local `opencode serve` on `127.0.0.1:4096` with `@opencode-ai/sdk` V1/V2 support, searchable subscription-grouped model & thinking-depth selectors, and the **Statistics** page.
  - **Claude Code:** spawns your local `claude` CLI in streaming `stream-json` mode, with optional model override & custom CLI directory settings.
  - **Codex CLI:** runs `codex exec --json` and parses JSONL reasoning, command, file-change, and message streams, with optional model override & custom CLI directory settings.
  - **Hermes / OpenAI-Compatible API:** talks directly to any OpenAI-compatible `/v1/chat/completions` endpoint (like Hermes Agent, vLLM, Ollama, or LM Studio)—complete with streaming `<think>...</think>` reasoning support, configurable Base URL (defaults to `http://127.0.0.1:8000/v1`), optional API key, and custom model name.
- **two window modes (Docked & Free-Roam Desktop Pet):**
  - **Docked Window:** clean DeepSeek-inspired interface with a collapsible `Projects` & `Chats` sidebar, pin/rename/move/remove right-click menus, weighted drag-and-drop chat reordering, live `tok/s` & active-agent telemetry, and an OpenCode **Statistics** page.
  - **Free-Roam Overlay (`Pets On`):** transparent `alwaysOnTop` overlay (`wlr-layer-shell` on Wayland, `alwaysOnTop` on X11/Windows/macOS) with click-through empty space so you can keep working while i wander around your taskbar, sit, sleep, pull up my laptop to talk with friends, or get grabbed and thrown across your monitor.
- **three modes (`Plan`, `Build`, `Orchestration`):**
  - **Plan** *(default)*: read-only planning so we figure out what's going on before touching any files.
  - **Build:** direct single-session coding & debugging (`Thinking...`, `Building...`, `Debugging...`, `Inspecting...`).
  - **Orchestration:** splits multi-step tasks into parallel subtasks (`Research`, `Execution`, `Testing`, `Review`, etc.) with optional `git worktree` isolation so parallel helper pets don't step on each other.
- **polite permission bubbles:** whenever any agent wants to edit a file or run a terminal command that needs approval, a clean text-only speech bubble pops up above that character with `[Approve]`, `[Always]`, and `[Deny]` buttons.
- **auto-connects on launch:** remembers your selected backend & settings in `localStorage` and checks availability automatically (spawning an authenticated `opencode serve` bound strictly to `127.0.0.1` when OpenCode is active).

---

## Prerequisites

you'll need these installed before running me locally:

- **Node.js 20+** and **npm**
- **Rust toolchain** (`cargo` / `rustc`)
- **at least one AI backend:**
  - **`opencode` CLI** on your `PATH` (for the OpenCode backend), **or**
  - **`claude` CLI** / **`codex` CLI** on your `PATH` (or pointed to via **Custom CLI Directory** in Settings), **or**
  - any local/remote **OpenAI-compatible server** (Hermes, Ollama, vLLM, etc.)
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

start the app (if OpenCode is selected it automatically checks for or spawns `opencode serve` on `127.0.0.1:4096`, or you can switch to Claude Code, Codex CLI, or Hermes / OpenAI API right in the UI):

```bash
# optional: start opencode serve manually first
opencode serve --hostname 127.0.0.1 --port 4096

# launch Boymoder AI Assistant
npm run tauri dev
```

---

## Custom characters & sprite systems (`assets/pets/`)

you can drop your own transparent 2D PNGs straight into `assets/pets/` without recompiling—just open **Settings (`⚙`) → Reload Sprites** to hot-reload them!

### Boymoder (9-pose orchestrator system)

my own sprites in `assets/pets/orchestrator/` still use the full **9-pose system** (`idle`, `walk`, `work`, `fall`, `sit`, `sleep`, `happy`, `alert`, `error`, plus optional `phone` & `chat` idle animations, and numbered `<state>_1.png`, `<state>_2.png`, ... multi-frame cycles).

### Helper pets (5-state productive Glegle subagent system)

helper pets under `assets/pets/subagents/<variant>/` use the lightweight **5-state productive Glegle sprite system** with smart fallbacks, so you only have to draw 5 poses instead of 9:

```text
assets/pets/
├── orchestrator/             # main Boymoder character (9-pose system)
│   ├── idle.png              # (or multi-frame: idle_1.png, idle_2.png, idle_3.png)
│   ├── walk.png              # (or walk_1.png .. walk_4.png)
│   ├── work.png              # (or work_1.png .. work_3.png)
│   ├── fall.png
│   ├── sit.png
│   ├── sleep.png
│   ├── happy.png
│   ├── phone.png             # (optional bored animation)
│   ├── chat.png              # (optional bored animation)
│   ├── alert.png
│   └── error.png
└── subagents/                # 5-state productive Glegle system
    ├── default/              # fallback variant when no custom/role folders match
    │   ├── idle.png          # resting / waiting pose (ultimate fallback)
    │   ├── work.png          # active coding / researching / tool pose
    │   ├── sleep.png         # cozy napping pose (gets floating zZz)
    │   ├── alert.png         # permission prompt / attention pose
    │   ├── happy.png         # task completed / celebratory hop pose
    │   └── error.png         # (optional — falls back to alert.png -> idle.png)
    ├── glegle-1/             # numbered / custom Glegle variants (rotated across subagents)
    ├── glegle-2/
    └── research/             # optional role-named folders (matched by role name)
```

- **smart fallbacks for omitted poses:** you don't need `walk.png`, `fall.png`, `sit.png`, `phone.png`, `chat.png`, or even `error.png` for subagents—`walk` falls back to `work` → `idle`, `fall` falls back to `alert` → `idle`, `error` falls back to `alert` → `idle`, and `sit`/`chat`/`phone` fall back cleanly to `idle`/`work` while CSS mini-animations keep them expressive.
- **multi-variant subfolder discovery:** every subfolder in `assets/pets/subagents/` containing at least one `.png` is discovered automatically on launch or reload. role-named folders (e.g. `research/`, `testing/`) match that role first, while numbered/custom folders (e.g. `glegle-1/`, `glegle-2/`) rotate automatically across spawned subagents, falling back to `default/` otherwise.
- **optional multi-frame animations:** any state in either folder supports 1-indexed `<state>_1.png`, `<state>_2.png`, ... frames.

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
