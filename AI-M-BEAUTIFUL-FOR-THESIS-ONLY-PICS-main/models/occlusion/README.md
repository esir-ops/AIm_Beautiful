# Occlusion model slot (empty)

Drop a Google Teachable Machine TensorFlow.js export here to replace the
pixel-heuristic "face covered" detector (hand / mask / object over the face):

```
models/occlusion/model.json
models/occlusion/metadata.json
models/occlusion/weights.bin
```

The app loads it automatically on next refresh (console logs `[tm:occlusion] model ready`).
While this folder has no `model.json`, the built-in heuristic runs instead.

See `../HOW-TO-TRAIN.md` for the full training walkthrough. One class name must
contain the word **`covered`**.
