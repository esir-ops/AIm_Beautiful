# Glasses model slot

The glasses detector blocks the Capture button while the user is wearing
glasses. It uses a trained model when one is installed, and falls back to a
pixel heuristic when none is.

## Recommended: train at the mirror with `trainer.html?slot=glasses`

Open **`trainer.html?slot=glasses`** on the mirror PC (for example
`http://127.0.0.1:5500/trainer.html?slot=glasses`). It is a staff page and is not
linked from the customer flow.

1. **Record.** Tap *Wearing glasses* and record, then tap again to stop. Do the
   same for *No glasses*. Record several people. Move your head slightly and
   change your distance while recording. Aim for **150+ samples per class**.
   Training unlocks at 40 per class.
   - Glasses: different frames, clear lenses, thin metal rims, tinted lenses.
   - No glasses: dark eyebrows, bangs, deep-set eyes, since these fooled the
     old heuristic.
2. **Train.** This takes under a minute. The accuracy shown is measured on the
   most recent 15% of each class, which is held back from training.
3. **Test live.** Try to fool it. Record more of any case it gets wrong, then
   train again.
4. **Install on This Mirror.** Saved in this browser. The app uses it from the
   next page load, and the console logs
   `[tm:glasses] model ready (trained on this device)`.

The trainer records with the same face crop the app uses at run time
(`face-crop.js`). It saves only numeric features, per model, in this browser,
so switching tabs or reloading keeps your samples. No photos are stored.

### Using the model on other computers

Press **Download Model Files**, then put the three files here:

```
models/glasses/model.json
models/glasses/model.weights.bin
models/glasses/metadata.json
```

## Load order

1. The model installed in this browser by the trainer.
2. `models/glasses/model.json`. This can also be a Teachable Machine export,
   and its positive class name must be `glasses`.
3. The built-in pixel heuristic.

**Remove Installed Model** on the trainer page returns the app to step 2 or 3.
