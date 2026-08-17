# AI'm Beautiful — AI-Assisted Smart Mirror

A browser-based smart-mirror makeup guide for the *Soft & Natural* look. It
detects the user's skin tone, recommends shades, previews them with a live
virtual try-on, and walks the user through a four-step guide (lips → blush →
eyebrows → contour) with real-time AR overlays and per-step feedback.

Built with plain **HTML + CSS + JavaScript**, **MediaPipe FaceMesh** (468-point
face tracking) and **TensorFlow.js** (application-quality model). No build step,
no server framework, no data leaves the device.

Group 11 · BS Computer Engineering · School of Engineering and Architecture.

---

## Project structure

```
AI-M-BEAUTIFUL-main/
├── index.html          App shell + all screens
├── app.js              All application logic (single file)
├── style.css           All styling
├── serve.ps1           Local dev server (see "Running" below)
│
├── data/               Local JSON databases (independently editable)
│   ├── shades.json           Recommended shades per skin tone × step
│   ├── focal-points.json     The four focal-point options
│   ├── style-variations.json Three coverage variations per focal point
│   └── foundations.json      Foundation shade per skin tone
│
├── models/             Optional drop-in AI models (Teachable Machine / TF.js)
│   ├── HOW-TO-TRAIN.md        How to train & install the models
│   ├── application-quality/   Slot: smudging / unevenness / amount classifier
│   ├── glasses/               Slot: glasses detector
│   └── occlusion/             Slot: face-covered detector
│
└── README.md           This file
```

Each `models/*` slot is optional. If a slot has no `model.json`, the app falls
back to a built-in pixel heuristic and says so in the UI — so everything works
today, and you can upgrade one model at a time with zero code changes.

## Running it

The app must be served over `http://` (not opened as a `file://`) because it
`fetch`es the JSON databases and uses the camera, which browsers only allow in a
secure/served context.

Easiest options:

- **VS Code Live Server** — right-click `index.html` → *Open with Live Server*.
- **The included script** (Windows PowerShell) — serves the folder on
  `http://localhost:8765`:
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
  ```

Then allow camera access when prompted. Use good, even lighting — tone and
detection accuracy depend on it.

## User flow

1. **Welcome**
2. **Focal point** — choose which feature to emphasise (lips / eyebrows / cheeks
   / contour). Can be changed later without re-scanning.
3. **Camera** — a manual **Capture Photo** button; capture is only allowed when
   the face is fully visible (no glasses, mask, or covering) and well-positioned.
4. **Shades** — recommended shades for the detected tone, with a live try-on.
5. **Variation** — three coverage levels (sheer / balanced / full) of the *same*
   recommended shades, previewed on the user's own photo.
6. **Foundation check** — recommends a base shade and confirms readiness.
7. **Guide** — four steps with AR overlays, an "amount to apply" indicator, and
   per-step placement + quality feedback.
8. **Summary** — the finished look and how each step scored.

## Notes for maintainers

- All logic lives in `app.js`; it is organised into commented sections
  (data loading, camera, detection, drawing, tone, shades, variations, guide,
  quality feedback, try-on).
- The JSON files in `data/` are the tuning surface — shades, variations,
  foundations and focal points can be edited without touching code.
- Detection heuristics (tone, glasses, occlusion, application quality) are
  best-effort under good lighting; the `models/` slots are the path to reliable
  accuracy. See `models/HOW-TO-TRAIN.md`.
