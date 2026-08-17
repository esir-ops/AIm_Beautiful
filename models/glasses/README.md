# Glasses model slot (empty)

Drop a Google Teachable Machine TensorFlow.js export here to replace the
pixel-heuristic glasses detector:

```
models/glasses/model.json
models/glasses/metadata.json
models/glasses/weights.bin
```

The app loads it automatically on next refresh (console logs `[tm:glasses] model ready`).
While this folder has no `model.json`, the built-in heuristic runs instead.

**Installing this model also turns ON the capture block for glasses.** With the
model present, the Capture button is disabled while glasses are detected and
re-enables automatically the moment they are removed. Without the model, glasses
are only a soft, non-blocking reminder (the pixel heuristic is not reliable
enough to lock the user out). Masks / hand / any face covering block capture
either way, via the separate occlusion check.

See `../HOW-TO-TRAIN.md` for the full training walkthrough. One class name must
contain the word **`glasses`**.
