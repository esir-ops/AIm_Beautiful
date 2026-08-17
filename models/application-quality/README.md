# Application Quality Classifier - drop-in contract

Objective 9 of the proposal specifies a **TensorFlow.js model built on MobileNetV2,
fine-tuned through transfer learning on researcher-collected application images**,
evaluating each completed step for **smudging, unevenness, and excessive or
insufficient product**.

`app.js` already contains the full inference path. It looks for the model at:

```
models/application-quality/model.json
```

Until that file exists, the app logs a warning and falls back to an analytical
image-analysis back-end that produces the **same output**, so every screen,
message and summary line works today. Nothing in `app.js` needs to change when
you drop the trained model in - it is picked up automatically on next load.

## Expected model contract

| Property | Value |
|---|---|
| Format | TensorFlow.js **Layers** model (`tf.loadLayersModel`) |
| Input | `[1, 224, 224, 3]`, float32, scaled to **[-1, 1]** (`x/127.5 - 1`) |
| Output | `[1, 4]` - independent probabilities, one per class |
| Class order | `['good', 'smudged', 'uneven', 'amount']` |
| Decision rule | a class fires when its probability `>= 0.5` |

The input crop is the step's landmark bounding box padded by 30%, taken from the
live video frame - so your training images should be cropped the same way.

`amount` is a single class covering **both** too much and too little product.
If you train separate `excessive` / `insufficient` heads, change
`QUALITY_CLASSES` and the `analyzeQualityModel()` mapping in `app.js` to match.

## Training notes

- Freeze the MobileNetV2 convolutional base, train a new head, then unfreeze the
  last block at a low learning rate.
- Use **sigmoid** activations, not softmax - a step can be both smudged and
  uneven at once.
- Collect images per step (lips, blush, eyebrows, contour). A single model
  across all four steps is what the current code assumes; if you train one model
  per step, change `QUALITY_MODEL_URL` into a per-step lookup.
- Export with:
  ```
  tensorflowjs_converter --input_format=keras model.h5 models/application-quality
  ```

## Analytical fallback (what runs right now)

Implemented as `analyzeQualityHeuristic()` in `app.js`. For the step's zone it
compares every pixel against the user's own forehead skin, then derives:

- **amount** - mean colour distance from skin inside the guide
- **unevenness** - coefficient of variation of that distance
- **smudging** - mean distance in the halo band just outside the guide,
  as a ratio of the inside value

Thresholds live in `QUALITY_BAND`, and the halo width in `QUALITY_HALO`, both
near the top of the quality section. Blush and contour get wider tolerances
because they are meant to diffuse outward.

Smudging and unevenness are reported as *Not assessed* when the amount is below
the minimum - with no product on the face, those two ratios are only noise.
