# Subagent Sprites (5-State Productive Glegle System)

Subagents use a lightweight **5-state productive Glegle sprite set** with smart fallbacks so you only need to draw the core poses while keeping every desktop animation lively.

*(The main Boymoder orchestrator in `assets/pets/orchestrator/` remains on its full 9-pose sprite system and is unaffected by subfolders here.)*

## Core 5-State Productive Set

Place PNG files inside a variant subfolder under `assets/pets/subagents/`:

| File | Required? | Purpose |
| --- | --- | --- |
| `idle.png` | **Yes** | Calm resting / waiting pose (also acts as the ultimate fallback) |
| `work.png` | **Yes** | Active coding, researching, or tool-execution pose |
| `sleep.png` | **Yes** | Cozy napping / low-energy idle pose (paired with floating `zZz` CSS badge) |
| `alert.png` | **Yes** | Attention / permission prompt pose |
| `happy.png` | **Yes** | Task completed / cheerful hop pose |
| `error.png` | Optional | Error state pose (automatically falls back to `alert.png` → `idle.png` if omitted) |

## Smart Fallbacks for Omitted Poses

You do **not** need to provide `walk.png`, `fall.png`, `sit.png`, `chat.png`, `phone.png`, or `error.png`. When omitted, `PetSpriteRegistry` automatically maps them and CSS mini-animations keep them expressive:

- `walk` → `walk.png` → `work.png` → `idle.png` (paired with smooth `pet-walk-step` bobbing)
- `fall` → `fall.png` → `alert.png` → `idle.png` (paired with subtle `pet-subagent-float` wobble)
- `error` → `error.png` → `alert.png` → `idle.png`
- `sit`, `sleep`, `happy`, `phone` → `<state>.png` → `idle.png`
- `chat` → `chat.png` → `sit.png` → `work.png` → `idle.png`
- `work` → `work.png` → `walk.png` → `idle.png`

## Multi-Variant Subfolder Discovery

Every immediate subfolder in `assets/pets/subagents/` containing at least one `.png` is automatically discovered on launch or reload:

```text
assets/pets/subagents/
├── default/       # Fallback variant when no custom variants or role matches exist
│   ├── idle.png
│   ├── work.png
│   ├── sleep.png
│   ├── alert.png
│   └── happy.png
├── glegle-1/      # Numbered Glegle variants (rotated across spawned subagents)
├── glegle-2/
├── research/      # Optional role-named folders (matched by role name, e.g. "Research")
└── testing/
```

- **Role-named folders** (e.g., `research/`, `coder/`, `testing/`) match exact or fuzzy subagent role names first.
- **Numbered / custom variants** (e.g., `glegle-1/`, `glegle-2/`) are rotated automatically across spawned subagents via `PetSpriteRegistry.pickSubagentVariant()` while keeping each pet's role badge (`Research`, `Coder`, `Testing`, etc.) intact.
- **`default/`** is used whenever no role match or non-default variant folder is present.

## Image Format & Hot Reload

- **Dimensions & Format**: `256x256` (square) transparent RGBA PNG, facing right (left-facing movement flips automatically).
- **File Size**: Keep each sprite `<= 5 MB` (files larger than 5 MB are skipped by the scanner).
- **Hot Reload**: After adding or editing sprites, click **Settings → Reload Sprites** in the app to refresh without restarting.

## Multi-Frame Animations (Optional)

Any state supports optional numbered frames using `<state>_<n>.png` (1-indexed, e.g. `work_1.png`, `work_2.png`, `work_3.png`, or `idle_1.png`, `idle_2.png`, `idle_3.png` for blink/head-tilt cycles). If no numbered frames exist for a state, the single `<state>.png` (or its fallback) is used.
