# Training the AI models for AI'm Beautiful

The app works today on pixel heuristics, but those are inherently limited under
varying lighting - a dark eyebrow and a brow pencil, or a tear-trough shadow and
a glasses rim, look nearly identical to a colour comparison. Objective 9 of the
proposal calls for a **TensorFlow.js model built on MobileNetV2, fine-tuned by
transfer learning**. This guide gets you there **without writing any ML code**,
using **Google Teachable Machine** (which uses MobileNet under the hood - exactly
the specified architecture).

Everything runs **in the browser, offline** after export - no cloud, no facial
images leaving the laptop. That keeps the privacy constraint in your Scope
section intact.

There are three model slots. Each is independent - train and drop in whichever
you want; any slot left empty falls back to the existing heuristic automatically,
so nothing breaks.

| Slot | Folder the app loads from | Purpose |
|------|---------------------------|---------|
| Glasses  | `models/glasses/`             | glasses vs no-glasses reminder |
| Occlusion| `models/occlusion/`           | face covered by hand/mask/object |
| Application quality | `models/application-quality/` | per-step smudging / unevenness / amount |

---

## Part A - Glasses & Occlusion (start here, ~30 min each)

These are simple 2-class image models and give the biggest immediate win.

### 1. Collect examples
Go to **https://teachablemachine.withgoogle.com** → **Get Started** →
**Image Project** → **Standard image model**.

**Glasses model - two classes:**
- Class 1, name it exactly **`glasses`** - record 150-300 webcam samples wearing
  glasses. Vary: head angle, lighting, distance, different frames if you have
  them, hair up/down.
- Class 2, name it **`no_glasses`** - 150-300 samples with no glasses, same
  variety. Include tricky cases: deep-set eyes, dark eyebrows, hair near the
  temples (these are what fooled the heuristic).

**Occlusion model - two classes:**
- Class 1, name it exactly **`covered`** - hand over cheek, mask on, hair across
  the face, object in front. 200+ samples, many variations.
- Class 2, name it **`clear`** - full, unobstructed face. 200+ samples.

> The label names matter. The loader looks for a class containing the word
> **`glasses`** (glasses slot) or **`covered`** (occlusion slot). Keep those
> substrings in the positive class name.

### 2. Train
Click **Train Model** (defaults are fine: 50 epochs, batch 16). Keep the tab
open until it finishes. Test it live with the preview panel - try to fool it and
add more samples to whichever class it gets wrong, then retrain.

### 3. Export
**Export Model** → **TensorFlow.js** tab → **Download my model**. You get a zip
containing:
```
model.json
metadata.json
weights.bin
```

### 4. Drop it in
Unzip and place all three files directly in the matching folder:
```
models/glasses/model.json
models/glasses/metadata.json
models/glasses/weights.bin
```
(and/or `models/occlusion/…`)

### 5. Done
Reload the app. The console will log `[tm:glasses] model ready …`. From then on
the model decides, and the heuristic is bypassed. Remove the files to go back to
the heuristic. No code changes needed.

---

## Part B - Application quality (the core reliability win, more work)

This is the model the feedback report is really waiting on. Same Teachable
Machine workflow, but **one model per step** is more accurate than one shared
model. Simplest version: a single 2-class model per step, `applied` vs `bare`.

Recommended classes per step (name the positive ones so the loader can find them
- see `models/application-quality/README.md` for the exact class-order contract
the code expects if you go beyond 2 classes):

- **Lips:** `bare`, `applied` - ideally later split `applied` into `good`,
  `uneven`, `smudged`, `too_much`, `too_little`.
- **Blush / Eyebrows / Contour:** same idea.

Collect samples **on real faces with the actual Squad / Detail products** in your
tray, under your evaluation lighting. 200+ per class. Export exactly as in Part A
and drop into `models/application-quality/`.

The inference path already exists in `app.js`
(`initQualityModel` / `analyzeApplicationQuality`) and expects:

| Property | Value |
|---|---|
| Format | TF.js **Layers** model (`tf.loadLayersModel`) |
| Input | `[1, 224, 224, 3]`, float32, scaled to **[-1, 1]** |
| Classes | order defined in `QUALITY_CLASSES` in `app.js` |

Teachable Machine exports this format directly.

---

## Tips for a reliable model (all three)

- **Collect in your real evaluation room**, at the real camera distance. A model
  trained in bright daylight will underperform under your LED strip.
- **Balance the classes** - similar sample counts each.
- **Add the hard cases** the heuristic failed on: dark brows, tear-trough
  shadows, hair near temples, wet/licked lips, glossy lipstick.
- **More variety beats more samples.** 200 varied shots beat 500 near-identical
  ones.
- Test live and keep adding misclassified examples until it holds up.

## How the app decides (for your defence)

For each check the app asks: *is a trained model installed for this slot?*
- **Yes** → the model's probability decides (positive class ≥ 0.6).
- **No**  → the pixel heuristic runs, and the UI says so
  (e.g. "Assessed by image analysis (quality model not installed)").

This means you can demo with heuristics now and upgrade to models incrementally,
one slot at a time, with zero code changes.
