// ═══════════════════════════════════════════════════════════
//  AI'm Beautiful — SAVED / FAVOURITE MAKEUP LOOKS
//
//  Snapshots a finished makeup session (skin-tone analysis,
//  recommended products/shades, completed steps, saved date)
//  into localStorage, and renders them back in a modal.
//
//  The user chooses HOW to save on the summary screen:
//    saveType 'recommendations' -> session data only, image null
//    saveType 'picture'         -> session data + a JPEG of the
//                                  finished look, captured here
//
//  This file only READS the live session state produced by
//  app.js (STATE, activeShades, formatTone, STEP_LABELS,
//  coverageLevel, goTo). It never changes it, so no existing
//  detection, mapping or recommendation behaviour is affected.
//  The photo camera is a plain getUserMedia preview - it does
//  not load MediaPipe or TensorFlow and never touches the AI.
//
//  Everything written to storage is a deep COPY of plain
//  values, so a saved look can never be rewritten by a later
//  session.
// ═══════════════════════════════════════════════════════════

const SL_STORAGE_KEY = 'aimb_saved_looks_v1';
const SL_MAX_LOOKS   = 50;

// Stored photo size. A 480x640 JPEG at q0.72 lands around 40-70 KB as a
// data URL, so a full library of 50 looks stays well inside the ~5 MB
// localStorage budget. Raising either number risks QuotaExceededError.
const SL_IMG_W = 480;
const SL_IMG_H = 640;
const SL_IMG_Q = 0.72;

const SL_TONE_LEVEL = { light:'Light', medium:'Medium', dark:'Deep' };
const SL_TONE_UNDER = { warm:'Warm',   cool:'Cool' };
const SL_COVER_WORD = ['', 'Sheer', 'Medium', 'Full'];

let SL_PENDING_DELETE = null;   // id awaiting delete confirmation
let SL_SAVING         = false;  // guards against double-clicking Save
let SL_CAM_STREAM     = null;   // photo-preview stream (separate from the AI feeds)
let SL_PENDING_IMAGE  = null;   // captured JPEG awaiting Retake / Save

// ─────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────
function slReadAll() {
  try {
    const raw = localStorage.getItem(SL_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('Saved looks: could not read storage —', e.message);
    return [];
  }
}

function slWriteAll(list) {
  try {
    localStorage.setItem(SL_STORAGE_KEY, JSON.stringify(list));
    return { ok:true };
  } catch (e) {
    // A saved photo is the only thing large enough to fill the quota, so the
    // message has to tell the user what they can actually do about it.
    const quota = !!(e && (e.name === 'QuotaExceededError' ||
                           e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                           e.code === 22 || e.code === 1014));
    console.error('Saved looks: could not write storage —', e.message);
    return { ok:false, quota:quota };
  }
}

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function slEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function slFormatDate(d) {
  try {
    return d.toLocaleString(undefined, {
      year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'2-digit'
    });
  } catch (e) { return d.toISOString(); }
}

// One product entry -> a flat, self-contained copy.
function slProductSnapshot(p) {
  if (!p) return null;
  return {
    brand:   p.brand   || '',
    product: p.product || '',
    shade:   p.shade   || '',
    hex:     p.hex     || '',
    slot:    (p.slot === 0 || p.slot) ? p.slot : null
  };
}

function slAltSnapshot(list) {
  return Array.isArray(list) ? list.map(slProductSnapshot).filter(Boolean) : [];
}

function slIsPicture(L) { return L && L.saveType === 'picture' && !!L.image; }

// ─────────────────────────────────────────
//  BUILD THE SNAPSHOT FROM THE LIVE SESSION
//  saveType: 'recommendations' | 'picture'
//  image:    data URL, or null
// ─────────────────────────────────────────
function slBuildSnapshot(saveType, image) {
  if (typeof STATE === 'undefined') return null;

  const results = Array.isArray(STATE.stepResults) ? STATE.stepResults : [];
  if (!results.length) return null;          // nothing was actually completed

  const toneKey = STATE.toneKey || null;
  const parts   = String(toneKey || '').split('_');
  const tone    = (typeof activeShades === 'function' ? activeShades() : null) || {};

  // Only the steps the user actually attempted are stored.
  const steps = results.map(r => {
    const src = tone[r.step] || null;
    let covLevel = null;
    try {
      covLevel = (typeof coverageLevel === 'function') ? coverageLevel(r.step) : null;
    } catch (e) { covLevel = null; }

    return {
      step:    r.step,
      label:   (typeof STEP_LABELS !== 'undefined' && STEP_LABELS[r.step]) || r.step,
      passed:  !!r.passed,
      skipped: !!r.skipped,
      message: r.message || '',
      quality: r.quality ? {
        passed: !!r.quality.passed,
        source: r.quality.source || '',
        issues: Array.isArray(r.quality.issues) ? r.quality.issues.slice() : []
      } : null,
      coverage:   covLevel ? { level: covLevel, word: SL_COVER_WORD[covLevel] } : null,
      product:    slProductSnapshot(src),
      alternates: slAltSnapshot(src && src.alt)
    };
  });

  // Foundation stage (recommendation only — the system never verifies it).
  // Run through the same single-best-match selector the Foundation screen uses,
  // otherwise the saved record would name a different brand than the one the
  // user was actually shown.
  const fRaw = (STATE.foundationData && toneKey) ? STATE.foundationData[toneKey] : null;
  const fSrc = (typeof bestProduct === 'function') ? bestProduct(fRaw, 'foundation') : fRaw;
  const foundation = {
    confirmed:  STATE.foundationConfirmed,
    product:    slProductSnapshot(fSrc),
    alternates: slAltSnapshot(fSrc && fSrc.alt)
  };

  const now = new Date();
  return {
    id: 'look_' + now.getTime() + '_' + Math.random().toString(36).slice(2,7),
    saveType:     (saveType === 'picture') ? 'picture' : 'recommendations',
    image:        (saveType === 'picture' && image) ? image : null,
    savedAt:      now.toISOString(),
    savedAtLabel: slFormatDate(now),
    skin: {
      toneKey:   toneKey,
      toneLabel: (typeof formatTone === 'function' && toneKey) ? formatTone(toneKey) : '—',
      level:     SL_TONE_LEVEL[parts[0]] || '—',
      undertone: SL_TONE_UNDER[parts[1]] || '—'
    },
    focal: {
      key:   STATE.focal || null,
      label: (STATE.focalData && STATE.focal && STATE.focalData[STATE.focal]
               && STATE.focalData[STATE.focal].label) || STATE.focal || '—'
    },
    // The makeup look chosen before the focal point. Stored as a flat copy so
    // the saved entry stays readable even if the preset file changes later.
    look: STATE.look ? {
      key:   STATE.look,
      label: (typeof currentLookLabel === 'function' ? currentLookLabel() : '') || STATE.look,
      desc:  (typeof currentLook === 'function' && currentLook() && currentLook().desc) || ''
    } : null,
    style: STATE.style
      ? { id: STATE.style.id, name: STATE.style.name, desc: STATE.style.desc || '' }
      : null,
    foundation: foundation,
    steps: steps
  };
}

// Shared write path for both save options.
function slCommitSave(saveType, image) {
  const snap = slBuildSnapshot(saveType, image);
  if (!snap) {
    slToast('Nothing to save yet — complete the makeup guide first.', false);
    return false;
  }
  const list = slReadAll();
  list.unshift(snap);                            // newest first
  if (list.length > SL_MAX_LOOKS) list.length = SL_MAX_LOOKS;

  const res = slWriteAll(list);
  if (res.ok) {
    slToast('✓  Makeup look saved successfully!', true);
    slFlashSaveButton();
    return true;
  }
  slToast(res.quota
    ? (image ? 'Storage full — delete an older saved look, or save recommendations only.'
             : 'Storage full — delete an older saved look and try again.')
    : 'Could not save — browser storage is blocked.', false);
  return false;
}

function slFlashSaveButton() {
  const btn = document.getElementById('btn-save-look');
  if (!btn) return;
  btn.classList.add('saved');
  btn.innerHTML = '♥ <span>Saved</span>';
  clearTimeout(btn._slTimer);
  btn._slTimer = setTimeout(() => {
    btn.classList.remove('saved');
    btn.innerHTML = '♡ <span>Save Look</span>';
  }, 2600);
}

function slToast(msg, good) {
  let t = document.getElementById('sl-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'sl-toast';
    t.className = 'sl-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle('bad', !good);
  t.classList.add('show');
  clearTimeout(t._slTimer);
  t._slTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ═══════════════════════════════════════════
//  SAVE CHOICE FLOW  (summary screen)
// ═══════════════════════════════════════════
function openSaveChoice() {
  const m = document.getElementById('save-choice-modal');
  if (!m) return;
  SL_PENDING_IMAGE = null;
  m.style.display = 'flex';
  slShowPane('choice');
}

function closeSaveChoice() {
  const m = document.getElementById('save-choice-modal');
  if (m) m.style.display = 'none';
  slStopCamera();
  SL_PENDING_IMAGE = null;
  slResetSaveButtons();
}

function slShowPane(name) {
  const title = document.getElementById('save-choice-title');
  const panes = { choice:'save-pane-choice', capture:'save-pane-capture', preview:'save-pane-preview' };
  Object.keys(panes).forEach(k => {
    const el = document.getElementById(panes[k]);
    if (el) el.style.display = (k === name) ? 'flex' : 'none';
  });
  if (title) {
    title.textContent = name === 'capture' ? 'Capture Your Look'
                      : name === 'preview' ? 'Preview Your Look'
                      : 'Save Your Look';
  }
}

function backToSaveChoice() {
  slStopCamera();
  SL_PENDING_IMAGE = null;
  slShowPane('choice');
}

function slResetSaveButtons() {
  SL_SAVING = false;
  const a = document.getElementById('btn-save-recs');
  if (a) { a.disabled = false; a.textContent = 'Save Recommendations Only'; }
  const b = document.getElementById('btn-sl-confirm');
  if (b) { b.disabled = false; b.textContent = 'Save Look'; }
}

// ── OPTION 1: recommendations only, no camera involved ──
function saveRecommendationsOnly() {
  if (SL_SAVING) return;
  SL_SAVING = true;
  const btn = document.getElementById('btn-save-recs');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // Let the button repaint before the synchronous write.
  setTimeout(() => {
    const ok = slCommitSave('recommendations', null);
    slResetSaveButtons();
    if (ok) closeSaveChoice();
  }, 30);
}

// ── OPTION 2: camera -> capture -> preview -> save ──
function startLookCapture() {
  slShowPane('capture');

  const video   = document.getElementById('sl-video');
  const loading = document.getElementById('sl-cam-loading');
  const btn     = document.getElementById('btn-sl-capture');
  if (btn) btn.disabled = true;
  if (loading) { loading.style.display = 'flex'; loading.textContent = 'LOADING CAMERA…'; }

  if (SL_CAM_STREAM) {                     // already live (user pressed Retake)
    if (loading) loading.style.display = 'none';
    if (btn) btn.disabled = false;
    return;
  }

  navigator.mediaDevices.getUserMedia({
    video: { width:{ ideal:640 }, height:{ ideal:480 }, facingMode:'user' }
  })
  .then(stream => {
    SL_CAM_STREAM = stream;
    if (video) video.srcObject = stream;
    return video ? video.play() : null;
  })
  .then(() => {
    if (loading) loading.style.display = 'none';
    if (btn) btn.disabled = false;
  })
  .catch(e => {
    console.error('Saved looks: camera unavailable —', e.message);
    if (loading) {
      loading.style.display = 'flex';
      loading.textContent = 'Camera unavailable — go back and save recommendations only.';
    }
  });
}

function slStopCamera() {
  if (SL_CAM_STREAM) {
    try { SL_CAM_STREAM.getTracks().forEach(t => t.stop()); } catch (e) {}
    SL_CAM_STREAM = null;
  }
  const video = document.getElementById('sl-video');
  if (video) video.srcObject = null;
}

// Crops the landscape webcam frame to a portrait photo and mirrors it, so the
// saved picture matches what the user saw in the mirror.
function slCaptureFrame(video) {
  const vW = video.videoWidth, vH = video.videoHeight;
  if (!vW || !vH) return null;

  const c = document.createElement('canvas');
  c.width = SL_IMG_W; c.height = SL_IMG_H;
  const ctx = c.getContext('2d');

  const scale = Math.max(SL_IMG_W / vW, SL_IMG_H / vH);
  const dw = vW * scale, dh = vH * scale;
  const dx = (SL_IMG_W - dw) / 2, dy = (SL_IMG_H - dh) / 2;

  ctx.save();
  ctx.translate(SL_IMG_W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.restore();

  return c.toDataURL('image/jpeg', SL_IMG_Q);
}

function captureLookPhoto() {
  const video = document.getElementById('sl-video');
  if (!video) return;
  const data = slCaptureFrame(video);
  if (!data) { slToast('Camera is not ready yet — try again in a moment.', false); return; }

  SL_PENDING_IMAGE = data;
  const img = document.getElementById('sl-preview-img');
  if (img) img.src = data;
  slStopCamera();                      // release the camera while previewing
  slShowPane('preview');
}

function retakeLookPhoto() {
  SL_PENDING_IMAGE = null;
  startLookCapture();
}

function saveLookWithPicture() {
  if (SL_SAVING) return;
  if (!SL_PENDING_IMAGE) { slToast('Capture a picture first.', false); return; }
  SL_SAVING = true;
  const btn = document.getElementById('btn-sl-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  setTimeout(() => {
    const ok = slCommitSave('picture', SL_PENDING_IMAGE);
    slResetSaveButtons();
    if (ok) closeSaveChoice();
  }, 30);
}

// Kept so the old Save Look binding still works if index.html was not updated.
function saveCurrentLook() { openSaveChoice(); }

// ═══════════════════════════════════════════
//  SAVED LOOKS MODAL
// ═══════════════════════════════════════════
function openSavedLooks() {
  const m = document.getElementById('saved-modal');
  if (!m) return;
  m.style.display = 'flex';
  slHideConfirm();
  renderSavedLooksList();
}

function closeSavedLooks() {
  const m = document.getElementById('saved-modal');
  if (m) m.style.display = 'none';
  slHideConfirm();
}

function slStartFromEmpty() {
  closeSavedLooks();
  // Enters at the makeup-look step, which is now the first step of the guide.
  if (typeof goTo === 'function') goTo('screen-look');
}

// ─────────────────────────────────────────
//  LIST VIEW
// ─────────────────────────────────────────
function renderSavedLooksList() {
  const body  = document.getElementById('saved-body');
  const title = document.getElementById('saved-modal-title');
  if (!body) return;
  if (title) title.textContent = 'My Saved Looks';

  const list = slReadAll();

  if (!list.length) {
    body.innerHTML =
      '<div class="sl-empty">' +
        '<div class="sl-empty-glyph">♡</div>' +
        '<h3 class="sl-empty-title">No Saved Looks Yet</h3>' +
        '<p class="sl-empty-text">Complete a makeup guide and save your favourite look to see it here.</p>' +
        '<button class="btn-primary sl-empty-btn" onclick="slStartFromEmpty()">Let\'s Begin</button>' +
      '</div>';
    return;
  }

  body.innerHTML = list.map((L, i) => {
    const pic   = slIsPicture(L);
    const steps = (L.steps || []).length;

    // Swatch row only for recommendation-only cards; the photo already
    // carries the visual weight on picture cards.
    const swatches = pic ? '' : (L.steps || [])
      .filter(s => s.product && s.product.hex)
      .map(s => '<span class="sl-dot" style="background:' + slEsc(s.product.hex) + '" title="' +
                slEsc(s.label + ': ' + s.product.shade) + '"></span>')
      .join('');

    return '' +
      '<div class="sl-card">' +
        (pic ? '<img class="sl-thumb" src="' + slEsc(L.image) + '" alt="Saved makeup look"/>' : '') +
        '<div class="sl-card-head">' +
          '<span class="sl-card-title">' + (pic ? 'Complete Makeup Look' : 'Makeup Recommendations') + '</span>' +
          '<span class="sl-card-index">#' + (list.length - i) + '</span>' +
        '</div>' +
        (pic ? '' : '<span class="sl-badge">♡ Recommendations Only</span>') +
        (swatches ? '<div class="sl-dot-row">' + swatches + '</div>' : '') +
        '<div class="sl-rows">' +
          slRow('Skin Tone',   L.skin && L.skin.level) +
          slRow('Undertone',   L.skin && L.skin.undertone) +
          (L.look ? slRow('Makeup Look', L.look.label) : '') +
          slRow('Focal Point', L.focal && L.focal.label) +
          slRow('Makeup Steps', steps + (steps === 1 ? ' step' : ' steps')) +
          slRow('Saved',       L.savedAtLabel) +
        '</div>' +
        '<div class="sl-card-actions">' +
          '<button class="btn-primary sl-btn-sm" onclick="viewSavedLook(\'' + slEsc(L.id) + '\')">View</button>' +
          '<button class="btn-retry sl-btn-sm" onclick="askDeleteSavedLook(\'' + slEsc(L.id) + '\')">Delete</button>' +
        '</div>' +
      '</div>';
  }).join('');
}

function slRow(label, value) {
  return '<div class="sl-row"><span class="sl-row-k">' + slEsc(label) +
         '</span><strong class="sl-row-v">' + slEsc(value || '—') + '</strong></div>';
}

// ─────────────────────────────────────────
//  DETAIL VIEW
// ─────────────────────────────────────────
function viewSavedLook(id) {
  const body  = document.getElementById('saved-body');
  const title = document.getElementById('saved-modal-title');
  if (!body) return;

  const L = slReadAll().find(x => x.id === id);
  if (!L) { renderSavedLooksList(); return; }
  if (title) title.textContent = slIsPicture(L) ? 'Complete Makeup Look' : 'Makeup Recommendations';

  let html = '<button class="btn-ghost sl-back" onclick="renderSavedLooksList()">← All Saved Looks</button>';

  // ── Picture, only when one was actually saved ──
  if (slIsPicture(L)) {
    html +=
      '<div class="sl-sect">' +
        '<div class="sl-sect-title">Your Look</div>' +
        '<img class="sl-photo" src="' + slEsc(L.image) + '" alt="Saved makeup look"/>' +
      '</div>';
  }

  // ── Skin-tone analysis ──
  html +=
    '<div class="sl-sect">' +
      '<div class="sl-sect-title">Skin Tone Analysis</div>' +
      '<div class="sl-rows">' +
        slRow('Skin Tone',      L.skin && L.skin.level) +
        slRow('Undertone',      L.skin && L.skin.undertone) +
        slRow('Detected Tone',  L.skin && L.skin.toneLabel) +
        (L.look ? slRow('Makeup Look', L.look.label) : '') +
        slRow('Focal Point',    L.focal && L.focal.label) +
        (L.style ? slRow('Variation', L.style.name) : '') +
      '</div>' +
    '</div>';

  // ── Makeup recommendations (only the categories in this session) ──
  const withProduct = (L.steps || []).filter(s => s.product && s.product.shade);
  if (withProduct.length) {
    html += '<div class="sl-sect"><div class="sl-sect-title">Makeup Recommendations</div>';
    withProduct.forEach(s => { html += slProductBlock(s.label, s.product, s.alternates, s.coverage); });
    html += '</div>';
  }

  // ── Foundation (recommendation stage only) ──
  if (L.foundation && L.foundation.product && L.foundation.product.shade) {
    html += '<div class="sl-sect"><div class="sl-sect-title">Foundation</div>' +
            slProductBlock('', L.foundation.product, L.foundation.alternates, null) +
            '<p class="sl-note">' +
              (L.foundation.confirmed === false
                ? 'Foundation was skipped in this session.'
                : 'Confirmed as applied. The system recommends the shade but does not verify it.') +
            '</p></div>';
  }

  // ── Makeup steps actually completed ──
  if ((L.steps || []).length) {
    html += '<div class="sl-sect"><div class="sl-sect-title">Makeup Steps</div><div class="sl-steps">';
    L.steps.forEach(s => {
      const verdict = s.skipped ? 'Skipped' : (s.passed ? '✓ Well done' : '✗ Needs blending');
      const cls     = s.skipped ? 'skip'    : (s.passed ? 'ok' : 'bad');
      let qLine = '';
      if (s.skipped)                             qLine = 'Step skipped';
      else if (s.quality && s.quality.source === 'unavailable') qLine = 'Quality not assessed';
      else if (s.quality)                        qLine = s.quality.passed
                                                   ? 'Blending, evenness and amount all good'
                                                   : 'Needs work: ' + s.quality.issues.join(', ');
      else                                       qLine = 'Placement not confirmed';

      html +=
        '<div class="sl-step">' +
          '<span class="sl-step-dot ' + cls + '"></span>' +
          '<div>' +
            '<div class="sl-step-name">' + slEsc(s.label) +
              (s.coverage ? ' <span class="sl-step-cov">' + slEsc(s.coverage.word) + ' coverage</span>' : '') +
            '</div>' +
            '<div class="sl-step-verdict ' + cls + '">' + slEsc(verdict) + '</div>' +
            '<div class="sl-step-quality">' + slEsc(qLine) + '</div>' +
          '</div>' +
        '</div>';
    });
    html += '</div></div>';
  }

  // ── Saved date ──
  html +=
    '<div class="sl-sect">' +
      '<div class="sl-sect-title">Saved</div>' +
      '<div class="sl-rows">' +
        slRow('Saved As', slIsPicture(L) ? 'Look + Picture' : 'Recommendations Only') +
        slRow('Date & Time', L.savedAtLabel) +
      '</div>' +
    '</div>' +
    '<div class="sl-card-actions sl-detail-actions">' +
      '<button class="btn-ghost sl-btn-sm" onclick="renderSavedLooksList()">← Back</button>' +
      '<button class="btn-retry sl-btn-sm" onclick="askDeleteSavedLook(\'' + slEsc(L.id) + '\')">Delete</button>' +
    '</div>';

  body.innerHTML = html;
  body.scrollTop = 0;
}

// Brand · Product · Shade · Shade Code · Tray Slot for one product.
// Every brand saved for a category is rendered with this exact same row set,
// so Chuchu Beauty reads identically to Detail Cosmetics and Squad Cosmetics.
function slBrandRows(p, coverage) {
  return '' +
    '<div class="sl-prod-head">' +
      '<span class="sl-dot lg" style="background:' + slEsc(p.hex || '#555') + '"></span>' +
      '<span class="sl-prod-brand">' + slEsc(p.brand || '—') + '</span>' +
    '</div>' +
    '<div class="sl-rows">' +
      (p.brand   ? slRow('Brand',      p.brand)   : '') +
      (p.product ? slRow('Product',    p.product) : '') +
      (p.shade   ? slRow('Shade',      p.shade)   : '') +
      (p.hex     ? slRow('Shade Code', p.hex)     : '') +
      (p.slot != null ? slRow('Tray Slot', 'Slot ' + p.slot) : '') +
      (coverage  ? slRow('Coverage',   coverage.word) : '') +
    '</div>';
}

// One makeup category, listing every brand that was recommended for it.
function slProductBlock(label, p, alts, coverage) {
  const extras = (alts || []).filter(a => a && a.shade);

  return '' +
    '<div class="sl-prod">' +
      (label ? '<div class="sl-prod-label">' + slEsc(label) + '</div>' : '') +
      slBrandRows(p, coverage) +
      extras.map(a => '<div class="sl-brand-sep"></div>' + slBrandRows(a, coverage)).join('') +
    '</div>';
}

// ─────────────────────────────────────────
//  DELETE
//  The photo lives inside the saved-look
//  object, so removing the object removes
//  the image data with it - there is no
//  separate file or blob to clean up.
// ─────────────────────────────────────────
function askDeleteSavedLook(id) {
  SL_PENDING_DELETE = id;
  const c = document.getElementById('saved-confirm');
  if (c) c.style.display = 'flex';
}

function slHideConfirm() {
  SL_PENDING_DELETE = null;
  const c = document.getElementById('saved-confirm');
  if (c) c.style.display = 'none';
}

function confirmDeleteSavedLook() {
  const id = SL_PENDING_DELETE;
  slHideConfirm();
  if (!id) return;
  const list = slReadAll().filter(x => x.id !== id);   // only this one
  slWriteAll(list);
  renderSavedLooksList();
  slToast('Saved look deleted.', true);
}
