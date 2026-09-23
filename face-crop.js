// ─────────────────────────────────────────
//  FACE CROP - shared by the app and the model trainer
//
//  The classifier slots (glasses / occlusion) look at a padded box around the
//  face, squashed to a square. The trainer (trainer.html) records with
//  this SAME function, so a model is always trained on exactly the kind of
//  image it is shown at run time.
// ─────────────────────────────────────────
function faceCropCanvas(image, lm, size, canvas) {
  const vW=image.width||image.videoWidth||640, vH=image.height||image.videoHeight||480;
  let x0=1,y0=1,x1=0,y1=0;
  [10,152,234,454].forEach(i=>{ const p=lm[i]; if(!p) return;
    x0=Math.min(x0,p.x); y0=Math.min(y0,p.y); x1=Math.max(x1,p.x); y1=Math.max(y1,p.y); });
  const pad=0.18;
  const bx=Math.max(0,(x0-pad)*vW), by=Math.max(0,(y0-pad)*vH);
  const bw=Math.min(vW,(x1+pad)*vW)-bx, bh=Math.min(vH,(y1+pad)*vH)-by;
  if (bw<16||bh<16) return null;
  const crop=canvas||document.createElement('canvas');
  crop.width=size; crop.height=size;
  crop.getContext('2d').drawImage(image, bx,by,bw,bh, 0,0,size,size);
  return crop;
}

// Where a model trained on this device is stored. Installing from the trainer
// writes here; the app checks here before the models/<slot>/ folder.
function localModelKey(slot){ return `indexeddb://aim-model-${slot}`; }
function localLabelsKey(slot){ return `aim-model-${slot}-labels`; }

// Index of the positive class. Exact match first, then a label that contains
// the word but is not its negation - "no_glasses" also contains "glasses", and
// Teachable Machine keeps whatever class order the user created.
function positiveLabelIndex(labels, positive) {
  if (!labels) return 0;
  const L=labels.map(l=>String(l).toLowerCase().trim());
  let i=L.indexOf(positive);
  if (i<0) i=L.findIndex(l=>l.includes(positive) && !/^(no|not|without)[\s_-]/.test(l));
  return i<0 ? 0 : i;
}
