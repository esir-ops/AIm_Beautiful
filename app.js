const STATE = {
  focal:null, toneKey:null, shades:null, focalData:null,
  // ── Makeup look (chosen BEFORE the focal point) ──
  look:null,             // 'professional' | 'date_casual_glam' | 'party_glam' | 'school'
  lookData:null,         // data/makeup-looks.json
  currentStep:0, stepResults:[], faceMesh:null, camera:null,
  stream:null, lastLandmarks:null, checkPending:false,
  lipSubStep:0,
  smoothedLm:null,
  blushLm:null,
  blushFrameCount:0,
  detectFrame:0,
  detectLm:null,      // smoothed landmarks for the detection overlay
  accActive:[],       // accessories currently detected (blocks Capture)
  accPosStreak:0,     // consecutive positive accessory reads (hysteresis)
  accNegStreak:0,     // consecutive clear reads (hysteresis)
  countdownStart:0,   // ms timestamp the capture countdown began
  // ── Style variation (Objective 6) ──
  styleData:null,        // data/style-variations.json
  style:null,            // the variation the user picked
  // ── Picture-based reference guide (Objective 7) ──
  captureCanvas:null,    // still frame grabbed at the moment tone was classified
  captureLm:null,        // landmarks belonging to that still frame
  captureArmed:false,    // user is in position; Capture button is live
  baseline:null,         // per-zone bare-face measurements (see captureBaseline)
  // ── Foundation checker (Objective 8) ──
  foundationData:null,   // data/foundations.json
  foundationConfirmed:null, // true = applied, false = skipped
};

const STEPS       = ['lips','blush','eyebrows','contour'];
const STEP_LABELS = { lips:'Lips', blush:'Blush', eyebrows:'Eyebrows', contour:'Contour' };

// Focal point -> makeup step. Also in focal-points.json, kept here in case that file fails to load.
const FOCAL_TO_STEP = { lips:'lips', eyebrows:'eyebrows', cheeks:'blush', contour:'contour' };

const STEP_INSTRUCTIONS = {
  lips:     'Follow the glowing outline on your lips. Start at the gold dot on the V-shape at the top center, then work outward to each corner. Fill in the top, then repeat from the bottom center outward.',
  blush:    'Smile softly and sweep blush onto the apples of your cheeks, blending upward along the oval guide.',
  eyebrows: 'Fill in your brows following the guide. Use short, hair-like strokes for a natural finish.',
  contour:  'Apply contour below your cheekbones following the dashed guide. Start at the white dot near your ear and sweep inward toward your nose.',
};

const LIP_OUTER_LOOP = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];
const LIP_INNER      = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
const LM_CUPID_VALLEY  = 0;
const LM_BOTTOM_CENTER = 17;
const LIP_OUTER_TOP = [61,185,40,39,37,0,267,269,270,409,291];
const LIP_OUTER_BOT = [291,375,321,405,314,17,84,181,91,146,61];
const LIP_FILL_TOP  = [61,185,40,39,37,0,267,269,270,409,291,308,415,310,311,312,13,82,81,80,191,78];
const LIP_FILL_BOT  = [291,375,321,405,314,17,84,181,91,146,61,78,95,88,178,87,14,317,402,318,324,308];
const LIP_SAMPLE_TOP = [37,0,267,82,13,312];
const LIP_SAMPLE_BOT = [17,84,314,87,14,317];

const LIP_SUBSTEP = [
  { label:'Top Lip',     badge:'Step 1 of 3', instruction:'Fill your TOP lip within the white outline. Start at the gold V-dot and stroke outward to each corner.' },
  { label:'Bottom Lip',  badge:'Step 2 of 3', instruction:'Top done! Now fill your BOTTOM lip. Start at the gold centre dot and stroke outward to each corner.' },
  { label:'Final Check', badge:'Step 3 of 3', instruction:'Both lips filled. Hold still while the camera checks your overall application.' },
];

const BLUSH_CENTER_L = [205,50,116,123];
const BLUSH_CENTER_R = [425,280,345,352];

const BROW_LEFT_TOP     = [70,63,105,66,107];
const BROW_LEFT_BOTTOM  = [46,53,52,65,55];
const BROW_RIGHT_TOP    = [300,293,334,296,336];
const BROW_RIGHT_BOTTOM = [276,283,282,295,285];
const JAW_LEFT       = [234,93,132,58,172,136,150,149,176,148,152];
const JAW_RIGHT      = [454,323,361,288,397,365,379,378,400,377,152];
const CHEEK_HOLLOW_L = [123,50,36,203,142,126,209,49,129,64];
const CHEEK_HOLLOW_R = [352,280,266,423,371,355,429,279,358,294];

const SAMPLE_IDX = {
  lips:     [13,14,0,17,61,291,40,270],
  blush:    [123,352,116,345,50,280,205,425],
  eyebrows: [70,300,66,296,63,293,105,334],
  contour:  [172,397,136,365,58,288,152,148],
};

// ── Canvas / overlay sync ──
function syncOverlay(canvasEl, videoEl) {
  const rect = videoEl.getBoundingClientRect();
  const W = Math.round(rect.width)  || videoEl.videoWidth  || 640;
  const H = Math.round(rect.height) || videoEl.videoHeight || 480;
  // Draw at the screen's real pixel density so text stays sharp on scaled displays.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const bw = Math.round(W*dpr), bh = Math.round(H*dpr);
  if (canvasEl.width  !== bw) canvasEl.width  = bw;
  if (canvasEl.height !== bh) canvasEl.height = bh;
  canvasEl.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
  const vW = videoEl.videoWidth  || 640;
  const vH = videoEl.videoHeight || 480;
  const scale = Math.max(W/vW, H/vH);
  const effW = vW*scale, effH = vH*scale;
  const ox = (effW-W)/2, oy = (effH-H)/2;
  return { W, H, effW, effH, ox, oy };
}

// ── Path helpers ──
function softPolyPath(ctx, pts) {
  const n=pts.length; if (n<2) return;
  const s={x:(pts[n-1].x+pts[0].x)/2, y:(pts[n-1].y+pts[0].y)/2};
  ctx.moveTo(s.x, s.y);
  for (let i=0;i<n;i++){const a=pts[i],b=pts[(i+1)%n]; ctx.quadraticCurveTo(a.x,a.y,(a.x+b.x)/2,(a.y+b.y)/2);}
  ctx.closePath();
}
function softArcPath(ctx, pts) {
  const n=pts.length; if (n<2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=0;i<n-1;i++){const a=pts[i],b=pts[i+1]; ctx.quadraticCurveTo(a.x,a.y,(a.x+b.x)/2,(a.y+b.y)/2);}
  ctx.lineTo(pts[n-1].x, pts[n-1].y);
}
function lmPts(lm, indices, W, H) { return indices.map(i=>({x:lm[i].x*W, y:lm[i].y*H})); }

// ── Head-turn visibility ──
// How far off-axis the head is: 0 = straight on, about 0.5 = full profile.
function faceTurnOffset(lm) {
  const faceW = Math.abs(lm[454].x - lm[234].x) || 0.001;
  const r = (lm[1].x - lm[234].x) / faceW;   // nose position across the face
  return Math.abs(r - 0.5);
}

function turnVisibility(lm) {
  const off = faceTurnOffset(lm);
  if (off <= 0.22) return 1;              // comfortable frontal range: full
  // beyond that, ramp down but never below 0.35 so it stays visible
  return Math.max(0.35, 1 - (off - 0.22) / 0.45);
}

// Stricter limits for the capture photo and the accessory check.
const TURN_OK_CAPTURE   = 0.15;   // realistic for a hand-held / desk webcam
const TURN_OK_ACCESSORY = 0.12;   // accessory check needs a near-frontal face

// ── Face shape (from landmark proportions) ──
function detectFaceShape(lm) {
  try {
    const faceW  = Math.abs(lm[234].x - lm[454].x);
    const faceH  = Math.abs(lm[10].y  - lm[152].y);
    const jawW   = Math.abs(lm[172].x - lm[397].x);
    const foreW  = Math.abs(lm[103].x - lm[332].x);
    const cheekW = faceW || 0.001;
    const hwRatio   = faceH  / cheekW;
    const jawRatio  = jawW   / cheekW;
    const foreRatio = foreW  / cheekW;
    if (hwRatio   > 1.55)                          return 'oblong';
    if (foreRatio > 0.95 && jawRatio < 0.68)       return 'heart';
    if (foreRatio < 0.78 && jawRatio < 0.78)       return 'diamond';
    if (hwRatio   < 1.18 && jawRatio > 0.82)       return 'round';
    if (hwRatio   < 1.40 && jawRatio > 0.80)       return 'square';
    return 'oval';
  } catch(e) { return 'oval'; }
}

// ── Data loading ──
async function loadData() {
  // Each file loads on its own so one broken file can't stop the whole app.
  const grab = (url) => fetch(url).then(r=>{
    if(!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }).catch(e=>{ console.error('Data load error:', e.message); return null; });

  const [s,f,v,fd,cb,ml] = await Promise.all([
    grab('data/shades.json'),
    grab('data/focal-points.json'),
    grab('data/style-variations.json'),
    grab('data/foundations.json'),
    grab('data/chuchu-beauty.json'),
    grab('data/makeup-looks.json'),
  ]);
  STATE.shades=s; STATE.focalData=f; STATE.styleData=v; STATE.foundationData=fd;
  STATE.lookData=ml;
  const extra = mergeBrandLibrary(cb);
  console.log('Data loaded.', {
    shades:!!s, focalPoints:!!f, styleVariations:!!v, foundations:!!fd,
    chuchuBeautyEntries:extra, makeupLooks:!!ml,
  });
}

// ── Extra brand libraries ──
// Same shape as shades.json. Entries are added as extra options (.alt) to the
// matching tone; nothing is replaced.
function mergeBrandLibrary(lib) {
  if (!lib || typeof lib!=='object') return 0;
  let n=0;
  const attach = (target, entry) => {
    // An incomplete row is ignored, so a half-filled file is harmless.
    if (!target || !entry || !entry.shade || !entry.hex) return;
    (target.alt = target.alt || []).push({
      shade:entry.shade, product:entry.product||'', brand:entry.brand||'',
      slot:(entry.slot===0||entry.slot)?entry.slot:null, hex:entry.hex,
    });
    n++;
  };
  Object.keys(lib).forEach(toneKey=>{
    if (toneKey.charAt(0)==='_') return;          // "_comment" and friends
    const src=lib[toneKey]; if (!src||typeof src!=='object') return;
    STEPS.forEach(step=>attach(STATE.shades?.[toneKey]?.[step], src[step]));
    attach(STATE.foundationData?.[toneKey], src.foundation);
  });
  return n;
}

// ── Style variation ──
// A variation never invents a colour, it picks an existing shade relative to the tone.
const TONE_LEVELS = ['light','medium','dark'];

function relTone(toneKey, rel) {
  if (!rel || rel==='self') return toneKey;
  const parts = String(toneKey).split('_');
  if (parts.length<2) return toneKey;
  const [lvl, und] = parts;
  let i = TONE_LEVELS.indexOf(lvl);
  if (i < 0) return toneKey;
  if (rel==='lighter') i = Math.max(0, i-1);
  if (rel==='deeper')  i = Math.min(TONE_LEVELS.length-1, i+1);
  return `${TONE_LEVELS[i]}_${und}`;
}

function resolveShades(toneKey, style) {
  const base = STATE.shades?.[toneKey];
  if (!base) return null;
  if (!style?.shadeRefs) return base;
  const out = {};
  STEPS.forEach(step=>{
    const src = STATE.shades?.[relTone(toneKey, style.shadeRefs[step])] || base;
    out[step] = src[step] || base[step];
  });
  return out;
}

// ── One best product per category ──
// Every brand for the tone competes and one winner is picked.
// How far from the user's own colouring the shade should sit (0 = closest, 1 = most contrast).
const LOOK_BOLDNESS = {
  school:           0.20,
  professional:     0.44,
  date_casual_glam: 0.64,
  party_glam:       0.88,
};
// How strongly each category carries colour. Foundation stays near 0 so it matches the skin.
const CATEGORY_BOLD = { lips:1.00, blush:0.80, eyebrows:0.90, contour:0.70, foundation:0.05 };

function lookBoldness(step) {
  const b = LOOK_BOLDNESS[STATE.look];
  return Math.min(1, (typeof b==='number'?b:0.55) * (CATEGORY_BOLD[step] ?? 0.85));
}

// Perceptual distance between a product shade and the user's detected skin tone.
function shadeContrast(hex, skin) {
  if (!hex || hex.length<7) return 0;
  const dr=parseInt(hex.slice(1,3),16)-skin.r;
  const dg=parseInt(hex.slice(3,5),16)-skin.g;
  const db=parseInt(hex.slice(5,7),16)-skin.b;
  return Math.sqrt(dr*dr + dg*dg + db*db);
}

// Flattens one category entry into the list of products competing for it.
function productCandidates(entry) {
  if (!entry) return [];
  return [
    { shade:entry.shade, product:entry.product, brand:entry.brand,
      slot:entry.slot, hex:entry.hex, primary:true },
    ...altOptions(entry).map(a=>({ ...a, primary:false })),
  ];
}

// Scores the candidates against the skin tone, look and category, and returns the best one.
function bestProduct(entry, step) {
  const cands = productCandidates(entry);
  if (cands.length<=1) return cands[0] || null;

  const skin = toneToRGB(STATE.toneKey||'medium_warm');
  const dist = cands.map(c=>shadeContrast(c.hex, skin));
  const lo=Math.min(...dist), hi=Math.max(...dist), span=(hi-lo)||1;
  const target = lookBoldness(step);

  let win=0, winScore=Infinity;
  cands.forEach((c,i)=>{
    // Boldness of this shade within the set, scored against what the look asks for.
    const norm  = (dist[i]-lo)/span;
    const score = Math.abs(norm-target) - (c.primary ? 0.001 : 0);
    if (score < winScore){ winScore=score; win=i; }
  });

  const w = cands[win];
  return { shade:w.shade, product:w.product, brand:w.brand, slot:w.slot, hex:w.hex };
}

// Applies the selection to a whole tone entry (all four makeup categories).
function selectBestSet(tone) {
  if (!tone) return tone;
  const out={};
  STEPS.forEach(s=>{ const b=bestProduct(tone[s], s); if (b) out[s]=b; });
  return out;
}

// Shade set used everywhere: detected tone, chosen variation, one product per category.
function activeShades() {
  return selectBestSet(resolveShades(STATE.toneKey||'medium_warm', STATE.style));
}

// ── Makeup look ──
// Adjusts the focal point and variation through styleIntensity().
// Fallback labels in case makeup-looks.json fails to load.
const LOOK_LABELS = {
  professional:     'Professional',
  date_casual_glam: 'Date / Casual Glam',
  party_glam:       'Party / Glam',
  school:           'School Look',
};

function currentLook(){ return (STATE.look && STATE.lookData?.[STATE.look]) || null; }
function currentLookLabel(){ return currentLook()?.label || LOOK_LABELS[STATE.look] || ''; }

// Per-step multiplier for the selected look. Never above 1.00, so a look can soften
// the result but never make it heavier than the tuned maximum.
function lookIntensity(step) {
  const m = currentLook()?.intensity?.[step];
  return (typeof m==='number' && m>0) ? Math.min(1, m) : 1;
}

// Guidance sentence for this step under the selected look (stronger on the focal step).
function lookNote(step) {
  const l=currentLook(); if (!l) return '';
  const focalStep = STATE.focalData?.[STATE.focal]?.mapStep || FOCAL_TO_STEP[STATE.focal];
  const txt = (step===focalStep ? l.focalGuide?.[step] : null) || l.guide?.[step];
  return txt ? `  ${l.label}: ${txt}` : '';
}

// Rendering strength for this step: the chosen variation scaled by the makeup look.
function styleIntensity(step, style) {
  const s = style===undefined ? STATE.style : style;
  // Never below 0.18, so a soft look still renders a visible guide.
  const scale = v => Math.max(0.18, Math.min(1, v*lookIntensity(step)));
  if (s?.intensity && typeof s.intensity[step]==='number') {
    return scale(s.intensity[step]);
  }
  const FALLBACK = {
    lips:     { lips:1.00, blush:0.38, eyebrows:0.50, contour:0.55 },
    eyebrows: { lips:0.38, blush:0.32, eyebrows:1.00, contour:0.60 },
    cheeks:   { lips:0.38, blush:1.00, eyebrows:0.50, contour:0.55 },
    contour:  { lips:0.38, blush:0.32, eyebrows:0.50, contour:1.00 },
  };
  return scale((FALLBACK[STATE.focal]||FALLBACK.lips)[step] ?? 0.5);
}

// ── Try-on strength ──
// The try-on has its own weights: the look sets the overall strength, every zone
// is always painted, and the focal zone leads. Never above 1.00.
const LOOK_STRENGTH = {
  school:           0.74,   // light, fresh, natural
  professional:     0.82,   // clean, polished, moderate
  date_casual_glam: 0.90,   // soft glam, flattering
  party_glam:       1.00,   // defined and glamorous, still realistic
};
// Share of the strength given to the non-focal zones.
const NON_FOCAL_SHARE = 0.74;
// Per-zone trim: contour and brows read heavier than blush at the same alpha.
const ZONE_TRIM = { lips:1.00, blush:0.98, eyebrows:0.92, contour:0.80 };
// How much of the result the chosen style variation is allowed to move.
const VARIATION_SPAN = 0.14;
// Per-step preview: how much the other zones are dimmed.
const STEP_PREVIEW_DIM = 0.62;

function tryOnIntensity(step, style) {
  const s = LOOK_STRENGTH[STATE.look] ?? 0.86;
  const focalStep = STATE.focalData?.[STATE.focal]?.mapStep || FOCAL_TO_STEP[STATE.focal];
  const base = s * (step===focalStep ? 1 : NON_FOCAL_SHARE) * (ZONE_TRIM[step] ?? 1);
  const raw  = Math.min(1, styleIntensity(step, style));
  const v    = base * (1 - VARIATION_SPAN + VARIATION_SPAN*raw);
  // Keep every zone visible without going above the tuned maximum.
  return Math.max(0.32, Math.min(1, v));
}

// Coverage level (1 sheer, 2 balanced, 3 full) for a step. Used by the variation
// cards, the step instructions and the amount check.
function coverageLevel(step) {
  // Coverage describes the variation, so the look's own weighting is divided out here.
  const c=styleIntensity(step)/(lookIntensity(step)||1);
  return c<0.7 ? 1 : c<0.92 ? 2 : 3;
}

// Sentence telling the user how much product to apply.
function coverageNote(step) {
  if (!STATE.style) return '';
  const words=['', 'sheer, light coverage', 'medium, buildable coverage', 'full, built-up coverage'];
  return `  Aim for ${words[coverageLevel(step)]} (${STATE.style.name}).`;
}

// ── Screen navigation ──
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  if (id==='screen-camera') {
    STATE.detectFrame=0;
    STATE.accActive=[];
    STATE.accPosStreak=0;
    STATE.accNegStreak=0;
    STATE.countdownStart=0;
    STATE.detectLm=null;
    // Retake must re-analyse, so clear the previous capture.
    STATE.toneKey=null;
    STATE.captureCanvas=null;
    STATE.captureLm=null;
    STATE.captureArmed=false;
    STATE.baseline=null;
    STATE.countdownPose=null; STATE.lastPose=null; STATE.cancelNote=null;
    leavePhotoReview();
    STATE.meshPaused=false;
    const db=document.getElementById('btn-detect');
    if (db){ db.style.display=''; db.textContent='Detect My Face'; db.onclick=startDetection; db.disabled=true; }
    const cb=document.getElementById('btn-capture');
    if (cb){ cb.style.display='none'; cb.disabled=true; }
    const cs=document.getElementById('capture-status');
    if (cs){ cs.style.display='none'; cs.className='capture-status'; }
    ['pill-face','pill-lm','pill-tone'].forEach(pid=>{
      const p=document.getElementById(pid); if(p) p.classList.remove('ok');
    });
    hideGlassesWarn();
    initCamera();
  } else if (id!=='screen-step') stopStream();

  // Style and foundation screens use the captured photo, so the camera stays off.
  if (id==='screen-style')      { stopTryOn(); renderStyleScreen(); }
  if (id==='screen-foundation') { stopTryOn(); renderFoundationScreen(); }

  // Coming back: keep the chosen look selected.
  if (id==='screen-look' && STATE.look){
    const card=document.querySelector(`.look-card[data-look="${STATE.look}"]`);
    if (card) selectLook(STATE.look, card);
  }

  // Coming back after analysis: keep the choice and go straight to the new recommendations.
  if (id==='screen-focal'){
    updateLookBadges();
    if (STATE.focal){
      const card=document.querySelector(`#screen-focal .focal-card[data-focal="${STATE.focal}"]`);
      if (card) selectFocal(STATE.focal, card);
    }
  }
}

// ── Particles ──
function initParticles() {
  const canvas=document.getElementById('particles-bg'), ctx=canvas.getContext('2d');
  let W,H,P=[];
  function resize(){W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight;}
  resize(); window.addEventListener('resize',resize);
  for (let i=0;i<60;i++) P.push({x:Math.random()*window.innerWidth,y:Math.random()*window.innerHeight,r:Math.random()*2.2+0.6,dx:(Math.random()-.5)*.4,dy:(Math.random()-.5)*.4,o:Math.random()*.5+.25});
  (function draw(){
    ctx.clearRect(0,0,W,H);
    P.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(255,46,126,${p.o})`;ctx.fill();p.x+=p.dx;p.y+=p.dy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;});
    requestAnimationFrame(draw);
  })();
}

// ── Makeup look selection ──
function selectLook(look, el) {
  STATE.look=look;
  // Coverage depends on the look, so the variation is picked again.
  STATE.style=null;
  document.querySelectorAll('.look-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  const btn=document.getElementById('btn-to-focal');
  if (btn) btn.disabled=false;
  updateLookBadges();
}

// Keeps the "Makeup look: X" badges on the focal and shades screens in sync.
function updateLookBadges() {
  const label=currentLookLabel();
  ['look-badge-label','look-badge-label-shades'].forEach(id=>{
    const el=document.getElementById(id); if (el) el.textContent=label||'Not chosen';
  });
  document.querySelectorAll('.look-badge-wrap').forEach(w=>{
    w.style.display = label ? '' : 'none';
  });
}

// ── Focal selection ──
function selectFocal(focal, el) {
  STATE.focal=focal;
  // A new focal point means the variation is picked again.
  STATE.style=null;
  // Only the focal cards (the look cards share the same class).
  document.querySelectorAll('#screen-focal .focal-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  const btn=document.getElementById('btn-to-camera');
  btn.disabled=false;
  // If the face has already been analysed, skip the camera and go straight to
  // the new recommendations for this focal point.
  if (STATE.toneKey){
    btn.textContent='See My Shades →';
    btn.onclick=()=>showShades();
  } else {
    btn.textContent='Analyze My Face →';
    btn.onclick=()=>goTo('screen-camera');
  }
}

// ── Camera setup ──
// One place that opens the webcam. 30 fps is requested so a dim room doesn't drop the frame rate.
async function openCamera() {
  const stream=await navigator.mediaDevices.getUserMedia({video:{
    width:{ideal:640}, height:{ideal:480}, facingMode:'user', frameRate:{ideal:30}
  }});
  tuneCamera(stream);
  return stream;
}

// Keep auto exposure and white balance on where supported (the mirror glass cuts a lot of light).
function tuneCamera(stream) {
  try {
    const track=stream.getVideoTracks()[0];
    const caps=track?.getCapabilities?.(); if (!caps) return;
    const adv={};
    if (caps.exposureMode?.includes('continuous'))     adv.exposureMode='continuous';
    if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode='continuous';
    if (Object.keys(adv).length) track.applyConstraints({advanced:[adv]}).catch(()=>{});
  } catch(e){}
}

// Reused offscreen canvases for per-frame pixel reads (kept on the CPU so reads are fast).
const _scratch={};
function scratchCtx(key, w, h) {
  let c=_scratch[key];
  if (!c) c=_scratch[key]=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  if (c.canvas.width!==w)  c.canvas.width=w;
  if (c.canvas.height!==h) c.canvas.height=h;
  return c;
}

// Feeds the playing <video> to FaceMesh one new frame at a time. Returns {stop}.
function startMeshLoop(video, onFrame) {
  let stopped=false, busy=false, lastT=-1, raf=0;
  function tick(){
    if (stopped) return;
    raf=requestAnimationFrame(tick);
    if (busy || STATE.meshPaused || video.readyState<2 || video.currentTime===lastT) return;
    lastT=video.currentTime; busy=true;
    Promise.resolve().then(onFrame).catch(()=>{}).finally(()=>{ busy=false; });
  }
  tick();
  return { stop(){ stopped=true; cancelAnimationFrame(raf); } };
}

// FaceMesh takes a while to download and start, so one instance is kept warm in the
// background and handed to the next camera screen.
let _warmMesh=null;
function prewarmMesh() {
  if (_warmMesh || typeof FaceMesh==='undefined') return;
  try {
    const mesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    mesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
    mesh.onResults(()=>{});
    const b=document.createElement('canvas'); b.width=1; b.height=1;
    _warmMesh={mesh, ready:mesh.send({image:b}).catch(()=>{})};
  } catch(e){ _warmMesh=null; }
}
// Hands over the warm instance (or a fresh one) wired to onResults. The
// returned promise resolves once the model is loaded; frames wait on it.
function takeMesh(onResults) {
  if (!_warmMesh) prewarmMesh();
  const w=_warmMesh; _warmMesh=null;
  if (!w) return {mesh:null, ready:Promise.resolve()};
  w.mesh.onResults(onResults);
  return w;
}

async function initCamera() {
  const video=document.getElementById('video');
  const titleEl=document.getElementById('cam-title');
  const subEl=document.getElementById('cam-sub');
  titleEl.textContent='Requesting camera...';
  subEl.textContent='Allow camera permission when prompted';
  try {
    if (STATE.camera){ try{STATE.camera.stop();}catch(e){} STATE.camera=null; }
    if (STATE.stream){ STATE.stream.getTracks().forEach(t=>t.stop()); STATE.stream=null; }
    STATE.stream=await openCamera();
    video.srcObject=STATE.stream;
    video.onloadedmetadata=()=>{
      video.onloadedmetadata=null;   // fire once - never reset a running scan
      titleEl.textContent='Camera ready ✓';
      subEl.textContent='Click Detect My Face when ready';
      document.getElementById('btn-detect').disabled=false;
      startLightingCheck();
    };
  } catch(e){
    titleEl.textContent='Camera access denied';
    subEl.textContent='Please allow camera access in browser settings';
  }
}

function stopStream() {
  if (STATE.camera){try{STATE.camera.stop();}catch(e){} STATE.camera=null;}
  if (STATE.faceMesh){try{STATE.faceMesh.close();}catch(e){} STATE.faceMesh=null;}
  if (STATE.stream){STATE.stream.getTracks().forEach(t=>t.stop()); STATE.stream=null;}
  if (STATE.lightTimer){clearInterval(STATE.lightTimer); STATE.lightTimer=null;}
  STATE.meshPaused=false;
  document.body.classList.remove('low-light');
  setTimeout(prewarmMesh, 500);
}

// ── Lighting check ──
function startLightingCheck() {
  const video=document.getElementById('video');
  const warn=document.getElementById('light-warn');
  const tmp=document.createElement('canvas'); tmp.width=64; tmp.height=48;
  const tctx=tmp.getContext('2d',{willReadFrequently:true});
  if (STATE.lightTimer) clearInterval(STATE.lightTimer);
  STATE.lightTimer=setInterval(()=>{
    if (!STATE.stream) return;
    if (STATE.reviewing){ warn.classList.add('hide'); return; }   // a still photo is on screen
    try {
      tctx.drawImage(video,0,0,64,48);
      const d=tctx.getImageData(0,0,64,48).data;
      let br=0,rS=0,gS=0,bS=0;
      const N=d.length/4;
      for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
      const avgBr=br/N,rA=rS/N,gA=gS/N,bA=bS/N;
      const cast=Math.max(rA,gA,bA)-(rA+gA+bA)/3;
      let msg='';
      document.body.classList.toggle('low-light', avgBr<60);
      if      (avgBr<60)  msg='⚠ Too dark. Move to a brighter area so colours are read accurately';
      else if (avgBr>205) msg='⚠ Too bright. Step back or reduce the glare';
      else if (cast>30)   msg='⚠ Strong colour cast. Use neutral white lighting';
      if (msg){warn.textContent=msg;warn.classList.remove('hide');}
      else    {warn.textContent='';warn.classList.add('hide');}
    } catch(e){}
  },1200);
}

function checkStepLighting(video) {
  // Light changes slowly and reading a frame is costly, so check about 3 times a second.
  const now=performance.now();
  if (now-(STATE.stepLightAt||0)<300) return;
  STATE.stepLightAt=now;
  try {
    let warn=document.getElementById('step-light-warn');
    if (!warn){
      warn=document.createElement('div'); warn.id='step-light-warn';
      Object.assign(warn.style,{position:'absolute',top:'8px',left:'50%',transform:'translateX(-50%)',background:'rgba(58,0,30,0.85)',border:'1px solid rgba(255,111,168,0.8)',color:'#fff',fontSize:'12px',fontFamily:"'Jost',sans-serif",fontWeight:'500',padding:'5px 14px',borderRadius:'20px',zIndex:'99',pointerEvents:'none',textAlign:'center',maxWidth:'90%',display:'none',whiteSpace:'nowrap'});
      const wrap=document.getElementById('step-overlay')?.parentElement||document.getElementById('step-video')?.parentElement||document.body;
      wrap.style.position=wrap.style.position||'relative';
      wrap.appendChild(warn);
    }
    if (!STATE.stepLightCanvas){
      const c=document.createElement('canvas'); c.width=32; c.height=24;
      STATE.stepLightCanvas=c.getContext('2d',{willReadFrequently:true});
    }
    const tctx=STATE.stepLightCanvas; tctx.drawImage(video,0,0,32,24);
    const d=tctx.getImageData(0,0,32,24).data;
    let br=0,rS=0,gS=0,bS=0; const N=d.length/4;
    for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
    const avgBr=br/N, cast=Math.max(rS/N,gS/N,bS/N)-(rS/N+gS/N+bS/N)/3;
    let msg='';
    document.body.classList.toggle('low-light', avgBr<60);
    if      (avgBr<60)  msg='⚠ Too dark. Better lighting helps the AI read your makeup accurately';
    else if (avgBr>205) msg='⚠ Too bright. Reduce the glare so colours are read correctly';
    else if (cast>30)   msg='⚠ Colour cast. Switch to neutral white light for the best results';
    warn.textContent=msg; warn.style.display=msg?'block':'none';
  } catch(e){}
}

// ── Trained model slots (trainer.html / Teachable Machine) ──
// If a slot's folder is empty, the pixel rules run instead. See models/HOW-TO-TRAIN.md.
const TM_MODELS = {
  // slot name → { url, input size, and the label that means "positive" }
  glasses:   { url:'models/glasses/model.json',   input:224, positive:'glasses' },
  occlusion: { url:'models/occlusion/model.json', input:224, positive:'covered' },
};
const _tm = {};   // name → { state:'idle|loading|ready|absent', model, labels }

// Warms a model through the same steps the camera uses, so the first real frame doesn't freeze.
async function warmModel(model, size) {
  const c=document.createElement('canvas'); c.width=size; c.height=size;
  const out=tf.tidy(()=>model.predict(
    tf.browser.fromPixels(c).toFloat().div(127.5).sub(1).expandDims(0)));
  try { await out.data(); } finally { out.dispose(); }
}

async function loadTMModel(name) {
  const cfg=TM_MODELS[name];
  if (!cfg) return 'absent';
  const slot=_tm[name] || (_tm[name]={state:'idle', model:null, labels:null});
  if (slot.state!=='idle') return slot.state;
  if (typeof tf==='undefined'){ slot.state='absent'; return slot.state; }
  slot.state='loading';
  // A model trained on this device with trainer.html comes first.
  try {
    slot.model=await tf.loadLayersModel(localModelKey(name));
    await warmModel(slot.model, cfg.input);
    try { slot.labels=JSON.parse(localStorage.getItem(localLabelsKey(name))||'null'); } catch(_){ slot.labels=null; }
    slot.state='ready';
    console.log(`[tm:${name}] model ready (trained on this device)`, slot.labels||'');
    return slot.state;
  } catch(_){ slot.model=null; }
  try {
    slot.model=await tf.loadLayersModel(cfg.url);
    await warmModel(slot.model, cfg.input);
    // Teachable Machine writes its class names into metadata.json beside the model.
    try {
      const metaUrl=cfg.url.replace(/model\.json$/,'metadata.json');
      const meta=await fetch(metaUrl).then(r=>r.ok?r.json():null);
      slot.labels=meta?.labels||null;
    } catch(_){ slot.labels=null; }
    slot.state='ready';
    console.log(`[tm:${name}] model ready`, slot.labels||'(labels from metadata unavailable)');
  } catch(e){
    slot.model=null; slot.state='absent';
    console.warn(`[tm:${name}] no model at ${cfg.url}, using heuristic fallback. (${e.message})`);
  }
  return slot.state;
}

// Kick off loading for every declared model (called once at startup).
function initTMModels(){ Object.keys(TM_MODELS).forEach(loadTMModel); }

// Runs a slot's model on the face crop and returns the positive-class probability.
// null = no model installed. Runs at most every TM_INTERVAL ms and reads the result
// asynchronously, so it never blocks a camera frame.
const TM_INTERVAL = 120;
function classifyTM(name, image, lm) {
  const cfg=TM_MODELS[name];
  const slot=_tm[name];
  if (!cfg || !slot || slot.state!=='ready' || !slot.model) return null;
  const now=performance.now();
  if (!slot.pending && now-(slot.lastRun||0)>=TM_INTERVAL){
    try {
      // Padded box around the whole face (face-crop.js - the trainer uses the same crop).
      const crop=faceCropCanvas(image, lm, cfg.input, slot.crop);
      if (crop){
        slot.crop=crop; slot.lastRun=now; slot.pending=true;
        const out=tf.tidy(()=>slot.model.predict(
          tf.browser.fromPixels(crop).toFloat().div(127.5).sub(1).expandDims(0)));
        out.data().then(p=>{
          slot.prob=p[positiveLabelIndex(slot.labels, cfg.positive)] ?? null;
          slot.probAt=performance.now();
        }).catch(e=>console.warn(`[tm:${name}] inference failed:`, e.message))
          .finally(()=>{ out.dispose(); slot.pending=false; });
      }
    } catch(e){ slot.pending=false; console.warn(`[tm:${name}] inference failed:`, e.message); }
  }
  // undefined = model installed but the first answer isn't back yet. Answers older than
  // a second are ignored unless a new one is on its way.
  if (slot.prob==null) return undefined;
  return (now-slot.probAt<1000 || slot.pending) ? slot.prob : undefined;
}

// ── Accessories (glasses) ──
// Trained model first, pixel rules otherwise.
function checkAccessories(image, lm) {
  try {
    // Trained model first; the pixel copy below is only needed for the fallback.
    const glassesProb=classifyTM('glasses', image, lm);
    if (glassesProb!==null) return glassesProb>=0.6 ? ['glasses'] : [];   // undefined: answer pending

    const vW=image.width||640, vH=image.height||480;
    const tctx=scratchCtx('frame', vW, vH); tctx.drawImage(image,0,0,vW,vH);
    // One read of the whole frame, then patches are taken from it.
    const all=tctx.getImageData(0,0,vW,vH).data;
    // Patch average around each landmark - a single pixel is far too noisy to
    // decide on. Radius scales with face size so it works at any distance.
    const rad=Math.max(2, Math.round(Math.abs(lm[454].x-lm[234].x)*vW*0.012));
    function px(idxs){
      let r=0,g=0,b=0,n=0;
      idxs.forEach(i=>{
        if(i>=lm.length) return;
        const cx=Math.round(lm[i].x*vW), cy=Math.round(lm[i].y*vH);
        const x0=Math.max(0,cx-rad), y0=Math.max(0,cy-rad);
        const x1=Math.min(vW,cx+rad+1), y1=Math.min(vH,cy+rad+1);
        for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
          const p=(y*vW+x)*4; r+=all[p]; g+=all[p+1]; b+=all[p+2]; n++;
        }
      });
      return n>0?{r:r/n,g:g/n,b:b/n,br:function(){return this.r*.299+this.g*.587+this.b*.114;}}:null;
    }
    const fh=px([10,9,151,107,336]); if(!fh) return [];
    const fhBr=fh.br();
    const found=[];

    // Pixel-rule fallback. Only on a frontal face, since turned temples read hair as frames.
    if (faceTurnOffset(lm) <= TURN_OK_ACCESSORY)
      runGlassesHeuristic(px, fhBr, found);

    // Face masks are handled by occlusionCheck.
    return found;
  } catch(e){return [];}
}

// Pixel-rule glasses scoring, used when no trained model is installed.
// Works on thin metal and clear-lens frames too.
function runGlassesHeuristic(px, fhBr, found) {
  // ── Clean baselines ──────────────────────────────────────────────
  const cheek = px([116,345,50,280]);
  const ckBr  = cheek ? cheek.br() : fhBr;
  // Under-eye pouches only (the temples are often hair).
  const underEye = px([145,144,163,374,373,390]);
  const ueBr = underEye ? underEye.br() : ckBr;
  // Forehead skin ONLY (no brow indices). This becomes the "clean skin at
  // eye-line height" reference for the nose-bridge break signal.
  const forehead = px([10,9,151,108,337]);
  const fhCleanBr = forehead ? forehead.br() : fhBr;

  let score = 0;

  // ── Signal A: nose-bridge break ──
  // Frame hardware between the lenses is darker than forehead skin.
  const bridgeBand = px([168, 6, 197, 193, 417]);
  if (bridgeBand){
    const diff = fhCleanBr - bridgeBand.br();
    if      (diff > 26) score += 2;    // strong: obvious hardware
    else if (diff > 16) score += 1;    // weak: possible thin frame
  }

  // ── Signal B: lower rim on the cheek ──
  const lLowerRim = px([119, 118, 117, 111]);
  const rLowerRim = px([348, 347, 346, 340]);
  if (lLowerRim && rLowerRim){
    const dL = ckBr - lLowerRim.br();
    const dR = ckBr - rLowerRim.br();
    if      (dL > 16 && dR > 16) score += 2;
    else if (dL > 10 && dR > 10) score += 1;
  }

  // ── Signal C: lens reflection ──
  // Needs a bright reflection and a consistent offset, so one bright spot doesn't count.
  const lLensCentre = px([159, 145]);
  const rLensCentre = px([386, 374]);
  if (lLensCentre && rLensCentre){
    const bothBright = lLensCentre.br() > 210 && rLensCentre.br() > 210;
    const bothOff    = Math.abs(lLensCentre.br() - ueBr) > 28 &&
                       Math.abs(rLensCentre.br() - ueBr) > 28;
    if (bothBright && bothOff) score += 1;
  }

  // ── Signal D: Outer vertical rim / arm hinge ────────────────────
  const lOuter = px([226, 130]);
  const rOuter = px([446, 359]);
  if (lOuter && rOuter && lOuter.br() < ckBr - 16 && rOuter.br() < ckBr - 16)
    score += 1;

  // ── Trigger ──
  // Needs a score of 3: one strong signal plus one more, or three weak ones.
  if (score >= 3) found.push('glasses');
}

function showGlassesWarn(msg) {
  // Glasses block Capture, so the banner can't be dismissed.
  const el=document.getElementById('glasses-warn');
  if(!el) return;
  const sp=el.querySelector('span');
  if(sp&&msg) sp.textContent=msg;
  el.classList.remove('hide');
}
function hideGlassesWarn() {
  const el=document.getElementById('glasses-warn');
  if(el) el.classList.add('hide');
}

// ── Detection screen ──
function startDetection() {
  document.getElementById('cam-title').textContent='Scanning your face...';
  document.getElementById('cam-sub').textContent='Keep still and look straight ahead';
  // Capture is always started by the user, never automatically.
  const d=document.getElementById('btn-detect');
  if (d) d.style.display='none';
  const cap=document.getElementById('btn-capture');
  if (cap){ cap.style.display=''; cap.disabled=true; cap.textContent='Capture Photo'; }
  const st=document.getElementById('capture-status');
  if (st){ st.style.display=''; st.className='capture-status'; st.textContent='Looking for your face…'; }
  const video=document.getElementById('video');
  let ready=Promise.resolve();
  if (!STATE.faceMesh){
    const w=takeMesh(onDetectResults);
    STATE.faceMesh=w.mesh; ready=w.ready;
  } else STATE.faceMesh.onResults(onDetectResults);
  if (STATE.camera){ try{STATE.camera.stop();}catch(e){} }
  STATE.camera=startMeshLoop(video, ()=>ready.then(()=>STATE.faceMesh?.send({image:video})));
}

function onDetectResults(results) {
  if (STATE.reviewing) return;   // a frame already in flight when the photo was taken
  const canvas=document.getElementById('overlay');
  const video=document.getElementById('video');
  const {W,H,effW,effH,ox,oy}=syncOverlay(canvas,video);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  const pFace=document.getElementById('pill-face');
  const pLM=document.getElementById('pill-lm');
  const pTone=document.getElementById('pill-tone');
  if (results.multiFaceLandmarks?.length>0){
    const lm=results.multiFaceLandmarks[0];
    STATE.lastLandmarks=lm;
    pFace.textContent='Face: Detected ✓'; pFace.classList.add('ok');
    pLM.textContent='Landmarks: 468 ✓';   pLM.classList.add('ok');
    // Smoothed so the overlay doesn't shake.
    const dlm=smoothDetectLm(lm);

    ctx.save(); ctx.translate(-ox,-oy);
    // Guides always follow the face and only dim as the head turns.
    ctx.globalAlpha = turnVisibility(lm);
    ctx.fillStyle='rgba(201,149,106,0.22)';
    // One path for all 468 dots.
    ctx.beginPath();
    dlm.forEach(pt=>{const x=pt.x*effW, y=pt.y*effH; ctx.moveTo(x+1.4,y); ctx.arc(x,y,1.4,0,Math.PI*2);});
    ctx.fill();
    drawLips   (ctx,dlm,effW,effH,'rgba(220,130,120,0.78)','rgba(220,130,120,0.18)',2,false);
    drawBrows  (ctx,dlm,effW,effH,'rgba(180,130,80,0.7)','rgba(160,110,60,0.15)',3);
    drawBlush  (ctx,dlm,effW,effH,'rgba(230,150,140,0.55)','rgba(230,150,140,0.10)',2);
    drawContour(ctx,dlm,effW,effH,'rgba(190,140,80,0.6)','rgba(170,120,60,0.22)',2.5);
    ctx.restore();
    // Glasses check every 4th frame. accActive blocks Capture in assessReadiness.
    STATE.detectFrame=(STATE.detectFrame||0)+1;
    if(STATE.detectFrame%4===1){
      const acc = (faceTurnOffset(lm) <= TURN_OK_ACCESSORY)
        ? checkAccessories(results.image, lm) : (STATE.accActive||[]);
      // Two agreeing reads are needed to set or clear it, so one noisy frame can't flip it.
      if(acc.length>0){
        STATE.accPosStreak=(STATE.accPosStreak||0)+1; STATE.accNegStreak=0;
        if(STATE.accPosStreak>=2) STATE.accActive=acc;
      } else {
        STATE.accNegStreak=(STATE.accNegStreak||0)+1; STATE.accPosStreak=0;
        if(STATE.accNegStreak>=2) STATE.accActive=[];
      }
      if(STATE.accActive && STATE.accActive.includes('glasses')){
        showGlassesWarn('Please remove your glasses so your whole face is visible');
      } else {
        const el=document.getElementById('glasses-warn');
        if(el&&!el.classList.contains('hide')) el.classList.add('hide');
      }
    }

    // ── Guided capture: never photograph the user unannounced ──
    if (!STATE.toneKey) runCaptureCountdown(ctx, results.image, lm, W, H, ox, oy);
  } else {
    pFace.textContent='Face not found. Step closer'; pFace.classList.remove('ok');
    pLM.textContent='Landmarks: waiting'; pLM.classList.remove('ok');
    resetCountdown('Face not detected. Centre yourself in the frame');
  }
}

// Landmark filter for the detection and step overlays ("one euro" style): smooths
// heavily while the face is still and follows quickly when it moves. Time-based.
const LM_MIN_CUTOFF = 0.5;     // Hz while still - lower is steadier
const LM_BETA       = 25;      // how quickly it opens up with speed - higher is less lag
const LM_D_CUTOFF   = 3;       // Hz, smoothing of the speed estimate itself
const LM_DEADBAND   = 0.0016;  // about 1 px of noise ignored while the face is still
const LM_STILL      = 0.06;    // face speed (frame widths / s) below which it counts as still
const LM_ANCHORS    = [1,4,6,168,10,152,234,454,33,263,133,362,61,291,199,9];
const _lmFilt = {};

function lmAlpha(cutoff, dt) {
  const tau=1/(2*Math.PI*cutoff);
  return 1/(1+tau/dt);
}

function smoothLandmarks(prev, lm, turnVis, key) {
  const now=performance.now();
  const f=_lmFilt[key]||(_lmFilt[key]={t:now, v:0});
  if (!prev || prev.length!==lm.length){
    f.t=now; f.v=0;
    return lm.map(p=>({x:p.x,y:p.y}));
  }
  const dt=Math.min(0.1, Math.max(0.005, (now-f.t)/1000));
  f.t=now;
  // Face speed from the centre of stable points (averaging cancels sensor noise).
  // Turning shows up as the nose moving against the cheeks.
  let cx=0, cy=0, turn=0;
  LM_ANCHORS.forEach(i=>{ cx+=lm[i].x-prev[i].x; cy+=lm[i].y-prev[i].y; });
  cx/=LM_ANCHORS.length; cy/=LM_ANCHORS.length;
  turn=Math.abs((lm[1].x-prev[1].x) - ((lm[234].x-prev[234].x)+(lm[454].x-prev[454].x))/2);
  const d=Math.max(Math.hypot(cx,cy), turn*0.5);
  f.v += lmAlpha(LM_D_CUTOFF, dt)*(d/dt - f.v);
  // A turned head has more depth error, so keep a little extra damping there.
  const A=lmAlpha(LM_MIN_CUTOFF + LM_BETA*f.v, dt) * (0.55 + 0.45*turnVis);
  const still=f.v<LM_STILL;
  return prev.map((s,i)=>{
    const dx=lm[i].x-s.x, dy=lm[i].y-s.y;
    if (still && Math.abs(dx)<LM_DEADBAND && Math.abs(dy)<LM_DEADBAND) return s;  // hold still
    return {x:s.x+A*dx, y:s.y+A*dy};
  });
}

function smoothDetectLm(lm) {
  STATE.detectLm=smoothLandmarks(STATE.detectLm, lm, turnVisibility(lm), 'detect');
  return STATE.detectLm;
}

// ── Occlusion check ──
// Blocks capture if part of the face is covered or out of frame: key points must be
// in frame, and the bare-skin zones should all share one skin colour.
function occlusionCheck(image, lm) {
  try {
    // 0) Trained model takes precedence when installed.
    const occProb=classifyTM('occlusion', image, lm);
    if (occProb!==null)   // undefined (answer pending) reads as clear for that frame
      return occProb>=0.6
        ? {occluded:true, reason:'Keep your whole face visible'}
        : {occluded:false, reason:''};

    // 1) Key makeup points must be in frame (forehead top and chin tip may touch the edge).
    const key=[234,454,1,4,61,291,133,362];
    for (const i of key){
      const p=lm[i]; if(!p) continue;
      if (p.x<-0.03||p.x>1.03||p.y<-0.03||p.y>1.03)
        return {occluded:true, reason:'Keep your face in view'};
    }

    const vW=image.width||640, vH=image.height||480;
    const cx=scratchCtx('frame', vW, vH);
    cx.drawImage(image,0,0,vW,vH);
    const all=cx.getImageData(0,0,vW,vH).data;   // one read, see checkAccessories
    const rad=Math.max(2, Math.round(Math.abs(lm[454].x-lm[234].x)*vW*0.02));
    const patch=(idxs)=>{
      let r=0,g=0,b=0,n=0;
      idxs.forEach(i=>{
        const p=lm[i]; if(!p) return;
        const px=Math.round(p.x*vW), py=Math.round(p.y*vH);
        const x0=Math.max(0,px-rad), y0=Math.max(0,py-rad);
        const x1=Math.min(vW,px+rad+1), y1=Math.min(vH,py+rad+1);
        for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
          const q=(y*vW+x)*4; r+=all[q]; g+=all[q+1]; b+=all[q+2]; n++;
        }
      });
      return n>0?{r:r/n,g:g/n,b:b/n}:null;
    };

    // Bare-skin zones only (avoid eyes/brows/lips, which differ naturally).
    const zones={
      forehead: patch([10,9,151,107,336]),
      lcheek:   patch([50,116,205,123]),
      rcheek:   patch([280,345,425,352]),
      nose:     patch([1,4,195,5]),
      chin:     patch([152,175,148,377]),
    };
    const list=Object.entries(zones).filter(([,v])=>v);
    if (list.length<4) return {occluded:true, reason:'Keep your whole face in view'};

    // Compare colour balance, not brightness, so a shadow isn't read as a covering.
    const chroma=v=>{ const s=v.r+v.g+v.b||1; return {r:v.r/s, g:v.g/s, b:v.b/s}; };
    const ch=list.map(([name,v])=>[name, chroma(v)]);
    const medC=k=>{const a=ch.map(([,c])=>c[k]).sort((p,q)=>p-q);return a[a.length>>1];};
    const med={r:medC('r'),g:medC('g'),b:medC('b')};
    let worst=0, worstName='';
    ch.forEach(([name,c])=>{
      const dev=Math.abs(c.r-med.r)+Math.abs(c.g-med.g)+Math.abs(c.b-med.b);
      if (dev>worst){ worst=dev; worstName=name; }
    });
    // Skin-in-shadow stays within ~0.05 of the median chroma; a mask/object is
    // far higher. 0.14 leaves a wide margin so normal lighting never trips it.
    if (worst>0.14){
      const where={forehead:'forehead',lcheek:'cheek',rcheek:'cheek',nose:'nose',chin:'chin'}[worstName]||'face';
      return {occluded:true, reason:`Uncover your ${where} so your whole face is visible`};
    }
    return {occluded:false, reason:''};
  } catch(e){ return {occluded:false, reason:''}; }
}

// ── Capture readiness ──
// ── Expression check ──
// Blocks an open mouth, big grin, pout, smirk, closed eyes and raised brows.
// Measured relative to eye distance so it works at any distance. Add ?expr to the
// URL to see the live numbers.
const EXPR = {
  mouthOpen:   0.12,  // inner-lip gap. Closed ~0.00-0.02, soft smile with parted lips <0.08
  mouthWide:   0.80,  // corner-to-corner. Neutral ~0.50-0.58, natural smile ~0.60-0.72
  mouthPucker: 0.40,  // pout / duck face pulls the corners well inside neutral
  mouthTilt:   0.09,  // one corner higher than the other (smirk)
  mouthShift:  0.10,  // mouth/jaw pushed to one side of the nose
  eyeClosed:   0.10,  // lid opening / eye width. Open ~0.25-0.35, smiling squint ~0.15+
  eyeWink:     0.55,  // narrower eye below 55% of the other one = wink
  browRaise:   0.36,  // brow-to-upper-lid height. Neutral ~0.20-0.28
  browUneven:  0.08,  // one eyebrow raised
};
const EXPR_DEBUG = /[?&]expr\b/.test(location.search);

function expressionMetrics(image, lm) {
  const vW=image?.width||640, vH=image?.height||480;
  const P=i=>({x:lm[i].x*vW, y:lm[i].y*vH});
  const L=P(33), R=P(263);
  const iod=Math.hypot(R.x-L.x, R.y-L.y);
  if (iod<1) return null;
  const a=-Math.atan2(R.y-L.y, R.x-L.x), c=Math.cos(a), s=Math.sin(a);
  const Q=i=>{ const p=P(i), dx=p.x-L.x, dy=p.y-L.y;
    return {x:(dx*c-dy*s)/iod, y:(dx*s+dy*c)/iod}; };
  const D=(i,j)=>{ const p=Q(i), q=Q(j); return Math.hypot(p.x-q.x, p.y-q.y); };
  const mL=Q(61), mR=Q(291);
  return {
    mouthOpen:  D(13,14),
    mouthWide:  D(61,291),
    mouthTilt:  Math.abs(mL.y-mR.y),
    mouthShift: Math.abs((mL.x+mR.x)/2 - Q(1).x),
    eyeL:       D(159,145)/(D(33,133)||1),
    eyeR:       D(386,374)/(D(362,263)||1),
    browL:      Q(159).y-Q(105).y,
    browR:      Q(386).y-Q(334).y,
  };
}

function expressionCheck(image, lm) {
  const raw=expressionMetrics(image, lm);
  if (!raw) return {ok:true, reason:''};
  const prev=STATE.exprEma;
  const m=STATE.exprEma=prev
    ? Object.fromEntries(Object.keys(raw).map(k=>[k, prev[k]*0.6+raw[k]*0.4]))
    : raw;
  if (EXPR_DEBUG) console.debug('[expr]', Object.entries(m).map(([k,v])=>`${k} ${v.toFixed(2)}`).join(' · '));
  const eyeMin=Math.min(m.eyeL,m.eyeR), eyeMax=Math.max(m.eyeL,m.eyeR);
  if (m.mouthOpen  > EXPR.mouthOpen)   return {ok:false, reason:'Close your mouth and keep a soft, natural smile'};
  if (m.mouthWide  > EXPR.mouthWide)   return {ok:false, reason:'Relax your smile a little'};
  if (m.mouthWide  < EXPR.mouthPucker) return {ok:false, reason:'Relax your lips, no pouting'};
  if (m.mouthTilt  > EXPR.mouthTilt || m.mouthShift > EXPR.mouthShift)
                                       return {ok:false, reason:'Keep your smile even and relaxed'};
  if (eyeMax       < EXPR.eyeClosed)   return {ok:false, reason:'Keep both eyes open'};
  if (eyeMin < EXPR.eyeClosed || eyeMin < eyeMax*EXPR.eyeWink)
                                       return {ok:false, reason:'Keep both eyes open evenly'};
  if (Math.max(m.browL,m.browR) > EXPR.browRaise || Math.abs(m.browL-m.browR) > EXPR.browUneven)
                                       return {ok:false, reason:'Relax your eyebrows'};
  return {ok:true, reason:''};
}

function assessReadiness(image, lm) {
  // Head must be genuinely straight on for the photo
  if (faceTurnOffset(lm) > TURN_OK_CAPTURE) return {ok:false, reason:'Face the camera straight on'};

  // Distance: face width should take a sensible share of the frame.
  const faceW=Math.abs(lm[454].x-lm[234].x);
  if (faceW < 0.20) return {ok:false, reason:'Move a little closer'};
  if (faceW > 0.95) return {ok:false, reason:'Move back a little'};

  // Centring - loose, since the portrait crop encourages a large, filled frame.
  const nose=lm[1];
  if (Math.abs(nose.x-0.5) > 0.22) return {ok:false, reason:'Centre your face horizontally'};
  if (nose.y < 0.16 || nose.y > 0.86) return {ok:false, reason:'Centre your face vertically'};

  // The makeup features must be in frame; forehead top and chin tip may touch the edge.
  const coreIdx=[33,263,133,362,105,334,116,345,61,291,0,17,1];
  for (const i of coreIdx){
    const p=lm[i]; if(!p) continue;
    if (p.x<0.03||p.x>0.97||p.y<0.03||p.y>0.97)
      return {ok:false, reason:'Move back a little so your features are in view'};
  }

  // Level head - avoid a tilted reference photo
  const roll=Math.abs(lm[234].y-lm[454].y)/(faceW||0.001);
  if (roll > 0.22) return {ok:false, reason:'Keep your head level'};

  // Relaxed expression only: this photo is the bare-face reference for every step.
  const expr=expressionCheck(image, lm);
  if (!expr.ok) return expr;

  // Face must not be covered by a hand, mask, hair or object.
  const occ=occlusionCheck(image, lm);
  if (occ.occluded) return {ok:false, reason:occ.reason};

  // Lighting must be usable. Checked about 4 times a second.
  try {
    const now=performance.now();
    if (now-(STATE.readyLightAt||0)>=250){
      STATE.readyLightAt=now;
      const tx=scratchCtx('light', 48, 36);
      tx.drawImage(image,0,0,48,36);
      const d=tx.getImageData(0,0,48,36).data;
      let br=0; const N=d.length/4;
      for(let i=0;i<d.length;i+=4) br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
      STATE.readyLight=br/N;
    }
    const avg=STATE.readyLight;
    if (avg<55)  return {ok:false, reason:'Too dark. Turn on your LED strip'};
    if (avg>212) return {ok:false, reason:'Too bright. Reduce the glare'};
  } catch(e){}

  // Glasses block Capture whether or not the trained model is loaded.
  if (STATE.accActive && STATE.accActive.includes('glasses')){
    return {ok:false, reason:'Please remove your glasses so your whole face is visible'};
  }
  return {ok:true, reason:''};
}

function resetCountdown(msg) {
  STATE.countdownStart=0;
  const sub=document.getElementById('cam-sub');
  if (sub && msg) sub.textContent=msg;
}

const COUNTDOWN_MS = 3000;   // 3 · 2 · 1 once the user presses Capture

// White flash when the photo is taken.
function cameraFlash() {
  const f=document.createElement('div');
  f.className='capture-flash';
  f.setAttribute('aria-hidden','true');
  document.body.appendChild(f);
  f.addEventListener('animationend', ()=>f.remove(), {once:true});
  setTimeout(()=>f.remove(), 1500);   // safety net if animations are off
}

// Pressing "Capture Photo" starts the countdown - never the system on its own.
function requestCapture() {
  if (STATE.toneKey || STATE.reviewing) return;
  if (!STATE.captureArmed) return;      // button is only live when you're ready
  STATE.countdownStart=Date.now();
  STATE.countdownPose=null;             // pose is recorded on the first countdown frame
  STATE.cancelNote=null;
}

// ── Movement during the countdown ──
// Moving cancels the photo. Tolerances are fractions of the face width.
const CAPTURE_MOVE_TOL  = 0.07;   // nose drift since the countdown began
const CAPTURE_SCALE_TOL = 0.07;   // leaning in or out
const CAPTURE_TURN_TOL  = 0.05;   // turning the head
const CAPTURE_SHOT_TOL  = 0.025;  // movement between frames at the moment of the shot (blur)

function facePose(lm, image) {
  const ar=(image.height||480)/(image.width||640);   // landmark y to x units
  return { x:lm[1].x, y:lm[1].y*ar, w:Math.abs(lm[454].x-lm[234].x)||0.001, turn:faceTurnOffset(lm) };
}
function poseMoved(a, b, tol) {
  return Math.hypot(b.x-a.x, b.y-a.y)/a.w > tol
      || Math.abs(b.w/a.w-1) > CAPTURE_SCALE_TOL
      || Math.abs(b.turn-a.turn) > CAPTURE_TURN_TOL;
}

function cancelCountdown(reason) {
  STATE.countdownStart=0; STATE.countdownPose=null; STATE.lastPose=null;
  const btn=document.getElementById('btn-capture');
  if (btn){ btn.disabled=true; btn.textContent='Capture Photo'; }
  // Kept on screen for a moment so the user can read why nothing was taken.
  STATE.cancelNote={text:`Cancelled. ${reason}`, until:Date.now()+2500};
}

// ── Photo review ──
// The photo is shown so the user can keep it or retake it. Tracking pauses meanwhile.
function enterPhotoReview() {
  STATE.reviewing=true;
  STATE.meshPaused=true;
  const src=STATE.captureCanvas, rv=document.getElementById('capture-review');
  if (rv && src){
    rv.width=src.width; rv.height=src.height;
    rv.getContext('2d').drawImage(src,0,0);
    rv.hidden=false;
  }
  const ov=document.getElementById('overlay');
  if (ov){ const c=ov.getContext('2d'); c.save(); c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,ov.width,ov.height); c.restore(); }
  hideGlassesWarn();
  document.getElementById('light-warn')?.classList.add('hide');

  const pTone=document.getElementById('pill-tone');
  if (pTone){ pTone.textContent=`Tone: ${formatTone(STATE.toneKey)} ✓`; pTone.classList.add('ok'); }
  const title=document.getElementById('cam-title'), sub=document.getElementById('cam-sub');
  if (title) title.textContent='How does this look?';
  if (sub)   sub.textContent='Keep this photo, or retake it if you want a better one';
  const btn=document.getElementById('btn-capture');   if (btn) btn.style.display='none';
  const st=document.getElementById('capture-status'); if (st) st.style.display='none';
  const d=document.getElementById('btn-detect');
  if (d){ d.style.display=''; d.textContent='Use This Photo →'; d.disabled=false; d.onclick=usePhoto; }
  const rt=document.getElementById('btn-retake');     if (rt) rt.style.display='';
}

function leavePhotoReview() {
  STATE.reviewing=false;
  const rv=document.getElementById('capture-review'); if (rv) rv.hidden=true;
  const rt=document.getElementById('btn-retake');     if (rt) rt.style.display='none';
}

function usePhoto() {
  leavePhotoReview();
  showShades();
}

// Throws the photo away and goes back to the live camera, ready to capture.
function retakePhoto() {
  leavePhotoReview();
  STATE.toneKey=null; STATE.captureCanvas=null; STATE.captureLm=null; STATE.baseline=null;
  STATE.countdownStart=0; STATE.countdownPose=null; STATE.lastPose=null;
  STATE.captureArmed=false; STATE.cancelNote=null;
  const pTone=document.getElementById('pill-tone');
  if (pTone){ pTone.textContent='Tone: waiting'; pTone.classList.remove('ok'); }
  const d=document.getElementById('btn-detect');      if (d) d.style.display='none';
  const btn=document.getElementById('btn-capture');
  if (btn){ btn.style.display=''; btn.disabled=true; btn.textContent='Capture Photo'; }
  const st=document.getElementById('capture-status');
  if (st){ st.style.display=''; st.className='capture-status'; st.textContent='Looking for your face…'; }
  STATE.meshPaused=false;
}

function runCaptureCountdown(ctx, image, lm, W, H, ox, oy) {
  const title=document.getElementById('cam-title');
  const sub=document.getElementById('cam-sub');
  const btn=document.getElementById('btn-capture');
  const status=document.getElementById('capture-status');
  const r=assessReadiness(image, lm);
  STATE.captureArmed=r.ok;

  // ── Countdown running (only ever started by the button) ──
  if (STATE.countdownStart){
    if (!r.ok){
      // Lost the pose mid-count - cancel, take no photo.
      cancelCountdown(r.reason);
      if (status){ status.className='capture-status'; status.textContent=STATE.cancelNote.text; }
      drawCaptureHint(ctx, W, H, ox, oy, r.reason, null);
      return;
    }
    const pose=facePose(lm, image);
    if (!STATE.countdownPose) STATE.countdownPose=pose;
    if (poseMoved(STATE.countdownPose, pose, CAPTURE_MOVE_TOL)){
      cancelCountdown('You moved. Hold still, then press Capture again');
      if (status){ status.className='capture-status'; status.textContent=STATE.cancelNote.text; }
      drawCaptureHint(ctx, W, H, ox, oy, 'You moved. Hold still', null);
      return;
    }
    const prevPose=STATE.lastPose; STATE.lastPose=pose;
    const remain=COUNTDOWN_MS-(Date.now()-STATE.countdownStart);
    if (remain>0){
      const n=Math.ceil(remain/1000);
      if (title)  title.textContent='Taking your photo…';
      if (sub)    sub.textContent='Hold your pose';
      if (btn)    btn.disabled=true;
      if (status){ status.className='capture-status'; status.textContent=`Capturing in ${n}…`; }
      drawCaptureHint(ctx, W, H, ox, oy, null, n);
      return;
    }
    // ── The shot itself: still moving at this instant means a blurred photo ──
    if (prevPose && poseMoved(prevPose, pose, CAPTURE_SHOT_TOL)){
      cancelCountdown('You moved as the photo was taken. Hold still and try again');
      if (status){ status.className='capture-status'; status.textContent=STATE.cancelNote.text; }
      return;
    }
    // ── Countdown finished: classify tone and freeze the reference frame ──
    const tone=detectToneFromImage(image, lm, W, H);
    if (!tone){
      cancelCountdown('Could not read your skin tone. Please try again');
      if (status) status.textContent=STATE.cancelNote.text;
      return;
    }
    STATE.toneKey=tone;
    STATE.countdownStart=0; STATE.countdownPose=null; STATE.lastPose=null;
    cameraFlash();
    captureReferenceFrame(image, lm);
    captureBaseline(image, lm);   // bare-face reference for every later step
    enterPhotoReview();
    return;
  }

  // ── Idle: just report whether the user is ready to press Capture ──
  const note=STATE.cancelNote && Date.now()<STATE.cancelNote.until ? STATE.cancelNote.text : '';
  if (title) title.textContent=note?'Photo cancelled':r.ok?'Ready when you are':'Get into position';
  if (sub)   sub.textContent=r.ok?'Hold a soft, natural smile and press Capture Photo'
                                 :'Adjust your position, then press Capture';
  if (btn)   btn.disabled=!r.ok;
  if (note && status){
    status.className='capture-status'; status.textContent=note;
    if (r.ok) return;                  // keep the note readable; the button is already live
  } else if (status){
    status.className='capture-status'+(r.ok?' ready':'');
    status.textContent=r.ok?'✓ Good to go. Press Capture Photo'
                           :`Not ready: ${r.reason}`;
  }
  if (!r.ok) drawCaptureHint(ctx, W, H, ox, oy, r.reason, null);
}

// The overlay canvas is mirrored with CSS, so text is drawn pre-flipped to read correctly.
function drawMirroredText(ctx, text, cx, cy, font, fill, boxed) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);          // cancel the CSS flip
  ctx.font=font;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  if (boxed){
    // Rounded berry pill with a thin pink edge, matching the app's buttons.
    const px=parseFloat((font.match(/(\d+(?:\.\d+)?)px/)||[])[1])||15;
    const tw=ctx.measureText(text).width, padX=px*1.1, h=px*2.3;
    const x=-tw/2-padX, y=-h/2, w=tw+padX*2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h/2); else ctx.rect(x, y, w, h);
    ctx.shadowColor='rgba(58,0,30,0.35)'; ctx.shadowBlur=14; ctx.shadowOffsetY=3;
    ctx.fillStyle='rgba(58,0,30,0.82)';
    ctx.fill();
    ctx.shadowColor='transparent';
    ctx.lineWidth=1.5; ctx.strokeStyle='rgba(255,111,168,0.85)';
    ctx.stroke();
  } else {
    ctx.lineWidth=6; ctx.strokeStyle='rgba(0,0,0,0.55)';
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle=fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// Countdown number / positioning prompt drawn over the mirror.
function drawCaptureHint(ctx, W, H, ox, oy, message, count) {
  ctx.save();
  ctx.translate(-ox,-oy);
  const cx=W/2+ox, cy=H/2+oy;
  if (count!=null){
    const rad=Math.min(W,H)*0.16;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx,cy,rad,0,Math.PI*2);
    // Berry disc with a pink ring, the same colours as the hint pills.
    ctx.fillStyle='rgba(58,0,30,0.5)'; ctx.fill();
    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,111,168,0.9)'; ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(cx, cy+2); ctx.scale(-1,1);   // cancel the mirror flip
    ctx.font='300 '+Math.round(rad*1.15)+'px Jost, "Segoe UI", sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor='rgba(0,0,0,0.55)'; ctx.shadowBlur=12;
    ctx.fillStyle='rgba(255,246,238,0.98)';
    ctx.fillText(String(count), 0, 0);
    ctx.restore();
  } else if (message){
    // The glasses message already shows on the banner, so it isn't drawn again here.
    const isGlassesMsg = message.toLowerCase().indexOf('glasses')>=0;
    if (!isGlassesMsg){
      // Shrink the font so the pill fits narrow screens.
      const maxW = Math.max(80, W - 28 - 2.2*17);   // minus the pill's side padding
      ctx.save();
      let px = 17;
      ctx.font = `500 ${px}px Jost, sans-serif`;
      let text = message;
      if (ctx.measureText(text).width > maxW){
        px = Math.max(10, Math.floor(17 * maxW / ctx.measureText(text).width));
      }
      ctx.restore();
      drawMirroredText(ctx, text, cx, cy,
        `500 ${px}px Jost, sans-serif`, '#ffffff', true);
    }
  }
  ctx.restore();
}

// ── Guide lines ──
// Guides are white so they show on every skin tone; the product colour is only the soft fill.
const BROW_GUIDE    = 'rgba(255,255,255,0.95)';
const CONTOUR_GUIDE = 'rgba(255,255,255,0.95)';

function drawWhiteGuide(ctx, pts, lw) {
  ctx.save();
  ctx.beginPath(); softArcPath(ctx,pts);
  // Fine line so the lip edge stays visible.
  ctx.strokeStyle='rgba(255,255,255,0.95)'; ctx.lineWidth=lw*0.8;
  ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
  ctx.restore();
}

// ── Draw lips ──
function drawLips(ctx, lm, W, H, strokeColor, fillColor, lw, filterMode, subStep) {
  const outerPts=lmPts(lm,LIP_OUTER_LOOP,W,H);
  const innerPts=lmPts(lm,LIP_INNER,W,H);
  const topPts  =lmPts(lm,LIP_OUTER_TOP,W,H);
  const botPts  =lmPts(lm,LIP_OUTER_BOT,W,H);
  const topFill =lmPts(lm,LIP_FILL_TOP,W,H);
  const botFill =lmPts(lm,LIP_FILL_BOT,W,H);

  if (!filterMode) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.15)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle=strokeColor; ctx.lineWidth=lw; ctx.shadowColor=strokeColor; ctx.shadowBlur=lw*3; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,innerPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.35)'); ctx.lineWidth=Math.max(1,lw*0.5); ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    return;
  }

  const hasSubStep=subStep!==undefined;

  if (hasSubStep && subStep===0) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,topFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,botFill); ctx.fillStyle='rgba(180,180,180,0.08)'; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softArcPath(ctx,botPts); ctx.strokeStyle='rgba(200,200,200,0.25)'; ctx.lineWidth=lw*0.8; ctx.setLineDash([3,4]); ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    drawWhiteGuide(ctx,topPts,lw);
  }

  if (hasSubStep && subStep===1) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,topFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.35)'); ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); softArcPath(ctx,topPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.70)'); ctx.lineWidth=lw*1.2; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,botFill); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    drawWhiteGuide(ctx,botPts,lw);
  }

  if (!hasSubStep || subStep===2) {
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.fillStyle=strokeColor.replace(/[\d.]+\)$/,'0.22)'); ctx.fill(); ctx.restore();
    // Thin dark backing + fine line so the outline reads on any skin tone.
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle='rgba(0,0,0,0.38)'; ctx.lineWidth=lw*1.15+1.2; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,outerPts); ctx.strokeStyle=strokeColor; ctx.lineWidth=lw*0.95; ctx.shadowColor=strokeColor; ctx.shadowBlur=lw*1.4; ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
    ctx.save(); ctx.beginPath(); softPolyPath(ctx,innerPts); ctx.strokeStyle=strokeColor.replace(/[\d.]+\)$/,'0.55)'); ctx.lineWidth=Math.max(0.8,lw*0.5); ctx.lineJoin='round'; ctx.stroke(); ctx.restore();
  }

  const dotR=Math.max(2.2,Math.abs(lm[LM_BOTTOM_CENTER].y*H-lm[LM_CUPID_VALLEY].y*H)*0.052);
  const dotDefs=[];
  if (!hasSubStep||subStep===0) dotDefs.push({idx:LM_CUPID_VALLEY,scale:1.0},{idx:61,scale:0.75},{idx:291,scale:0.75});
  if (!hasSubStep||subStep===1) dotDefs.push({idx:LM_BOTTOM_CENTER,scale:1.0},...(hasSubStep?[]:[{idx:61,scale:0.65},{idx:291,scale:0.65}]));
  if (hasSubStep&&subStep===2) dotDefs.push({idx:LM_CUPID_VALLEY,scale:0.85},{idx:LM_BOTTOM_CENTER,scale:0.85});
  dotDefs.forEach(({idx,scale})=>{
    const pt={x:lm[idx].x*W,y:lm[idx].y*H};
    ctx.save(); ctx.beginPath(); ctx.arc(pt.x,pt.y,dotR*scale,0,Math.PI*2); ctx.fillStyle='#ffe066'; ctx.fill(); ctx.restore();
  });
}

// ── Draw brows ──
// Soft fill, dashed outline, upward hair strokes, start dot and tail arrow.
function drawBrows(ctx, lm, W, H, sc, fc, lw) {
  [[BROW_LEFT_TOP,BROW_LEFT_BOTTOM],[BROW_RIGHT_TOP,BROW_RIGHT_BOTTOM]].forEach(([top,bot])=>{
    const topPts = top.map(i=>({x:lm[i].x*W, y:lm[i].y*H}));
    const botPts = bot.map(i=>({x:lm[i].x*W, y:lm[i].y*H}));
    const allPts = [...topPts, ...[...botPts].reverse()];

    const midT = topPts[Math.floor(topPts.length/2)];
    const midB = botPts[Math.floor(botPts.length/2)];
    const browH = Math.hypot(midT.x-midB.x, midT.y-midB.y);

    // 1. Soft blurred fill - shows WHERE to apply colour
    if (fc) {
      ctx.save();
      ctx.filter='blur(2.5px)';
      ctx.beginPath(); softPolyPath(ctx,allPts);
      ctx.fillStyle=fc; ctx.fill();
      ctx.restore();
    }

    // 2. Dashed outline in white over a dark backing, so it shows on dark brow hair.
    ctx.save();
    ctx.beginPath(); softPolyPath(ctx,allPts);
    ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.lineWidth=lw*0.85+1.1; ctx.lineJoin='round';
    ctx.setLineDash([lw*2.5,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); softPolyPath(ctx,allPts);
    ctx.strokeStyle=BROW_GUIDE; ctx.lineWidth=lw*0.85; ctx.lineJoin='round';
    ctx.setLineDash([lw*2.5,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    // 3. Short upward hair strokes - shows HOW to fill
    const N=6;
    for (let s=0;s<N;s++){
      const t=(s+0.5)/N;
      const ti=Math.min(Math.round(t*(topPts.length-1)),topPts.length-1);
      const bi=Math.min(Math.round(t*(botPts.length-1)),botPts.length-1);
      const mx=(topPts[ti].x+botPts[bi].x)/2;
      const my=(topPts[ti].y+botPts[bi].y)/2;
      const ta=Math.min(ti+1,topPts.length-1), tb=Math.max(ti-1,0);
      const browAngle=Math.atan2(topPts[ta].y-topPts[tb].y, topPts[ta].x-topPts[tb].x);
      const hairAngle=browAngle-Math.PI/2;
      const sLen=Math.max(browH*1.4, lw*3);
      ctx.save();
      ctx.translate(mx,my); ctx.rotate(hairAngle);
      ctx.beginPath(); ctx.moveTo(0,-sLen*0.62); ctx.lineTo(0,sLen*0.38);
      ctx.strokeStyle=BROW_GUIDE; ctx.lineWidth=lw*0.4;
      ctx.lineCap='round'; ctx.globalAlpha=0.9; ctx.stroke();
      ctx.restore();
    }

    // 4. Gold start dot at inner corner
    ctx.save();
    ctx.beginPath();
    ctx.arc(topPts[0].x,topPts[0].y,Math.max(2.5,lw*0.95),0,Math.PI*2);
    ctx.fillStyle='#ffe066'; ctx.fill();
    ctx.restore();

    // 5. Arrow at tail showing direction
    const n=topPts.length;
    if (n>=2){
      const tail=topPts[n-1], prev=topPts[n-2];
      const ang=Math.atan2(tail.y-prev.y, tail.x-prev.x);
      const ah=lw*2.2;
      ctx.save();
      ctx.translate(tail.x,tail.y); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-ah,-ah*0.55); ctx.lineTo(0,0); ctx.lineTo(-ah,ah*0.55);
      ctx.strokeStyle=BROW_GUIDE; ctx.lineWidth=lw*0.6;
      ctx.lineCap='round'; ctx.lineJoin='round'; ctx.stroke();
      ctx.restore();
    }
  });
}

// ── Draw blush ──
function drawBlush(ctx, lm, W, H, sc, fc, lw, coverage) {
  const faceW = Math.abs(lm[234].x - lm[454].x) * W;
  const faceH = Math.abs(lm[10].y  - lm[152].y) * H;
  const faceRef = Math.max(faceW, faceH * 0.80);

  const noseRatio = (lm[1].x - lm[234].x) / ((lm[454].x - lm[234].x) || 0.001);

  const visL = Math.min(1, Math.max(0, (noseRatio - 0.15) / 0.22));
  const visR = Math.min(1, Math.max(0, (0.85 - noseRatio) / 0.22));

  const rx = faceRef * 0.155;
  const ry = faceRef * 0.072;

  const nosePx = lm[1].x * W;
  const nosePy = lm[1].y * H;

  const zones = [
    { temple: 234, vis: visL },
    { temple: 454, vis: visR },
  ];

  zones.forEach(({ temple, vis }) => {
    if (vis <= 0.02) return;

    const templePx = lm[temple].x * W;
    const templePy = lm[temple].y * H;
    const cx = nosePx + 0.60 * (templePx - nosePx);
    const cy = nosePy + 0.60 * (templePy - nosePy) + faceRef * 0.035;

    const angle = Math.atan2(lm[temple].y - lm[1].y, lm[temple].x - lm[1].x);

    const rxV = rx;
    const ryV = ry * Math.max(0.55, vis);

    const arrowStart = -rxV * 0.42;
    const arrowEnd   =  rxV * 0.52;
    const ah         = lw * 2.5;

    ctx.save();
    ctx.globalAlpha = vis;
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    if (fc) {
      ctx.save();
      ctx.scale(1, ryV / rxV);
      const grad = ctx.createRadialGradient(-rxV*0.15, 0, 0, 0, 0, rxV);
      grad.addColorStop(0, sc.replace(/[\d.]+\)$/, '0.22)'));
      grad.addColorStop(1, sc.replace(/[\d.]+\)$/, '0)'));
      ctx.beginPath(); ctx.arc(0, 0, rxV, 0, Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, rxV, ryV, 0, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth   = lw * 0.85;   // was 1.2 - the ring read as a thick band
    ctx.setLineDash([lw*3, lw*2]);
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.lineWidth   = lw * 0.9;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(arrowStart, 0);
    ctx.lineTo(arrowEnd, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(arrowEnd - ah, -ah * 0.6);
    ctx.lineTo(arrowEnd, 0);
    ctx.lineTo(arrowEnd - ah,  ah * 0.6);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(arrowStart + lw*1.5, 0, Math.max(2.5, lw*0.95), 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();
    ctx.restore();

    ctx.restore();
  });
}

// ── Nose contour guide ──
function drawNoseContourGuide(ctx, lm, W, H, sc, fc, lw) {
  const bridge = { x:lm[168].x*W, y:lm[168].y*H };
  const tip    = { x:lm[4].x*W,   y:lm[4].y*H   };
  const alarL  = { x:lm[49].x*W,  y:lm[49].y*H  };
  const alarR  = { x:lm[279].x*W, y:lm[279].y*H };
  const nH     = Math.abs(tip.y - bridge.y);
  const off    = nH * 0.10;

  [
    { p0:{x:bridge.x-off, y:bridge.y+nH*0.08}, ctrl:{x:alarL.x-off*0.4, y:bridge.y+nH*0.50}, p2:{x:alarL.x, y:alarL.y} },
    { p0:{x:bridge.x+off, y:bridge.y+nH*0.08}, ctrl:{x:alarR.x+off*0.4, y:bridge.y+nH*0.50}, p2:{x:alarR.x, y:alarR.y} },
  ].forEach(({p0,ctrl,p2})=>{
    if (fc) {
      ctx.save(); ctx.filter='blur(2px)'; ctx.globalAlpha=0.5;
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
      ctx.strokeStyle=fc; ctx.lineWidth=lw*2.2; ctx.lineCap='round'; ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle='rgba(0,0,0,0.38)'; ctx.lineWidth=lw*0.8+1; ctx.lineCap='round';
    ctx.setLineDash([lw*2,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle=CONTOUR_GUIDE; ctx.lineWidth=lw*0.8; ctx.lineCap='round';
    ctx.setLineDash([lw*2,lw*1.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  });
}

// ── Draw contour ──
// Nose sides plus cheek/jaw sweeps chosen by face shape.
function drawContour(ctx, lm, W, H, sc, fc, lw) {
  const shape = detectFaceShape(lm);
  const faceH = Math.abs(lm[10].y  - lm[152].y) * H;
  const faceW = Math.abs(lm[234].x - lm[454].x) * W;

  // Fade each side by how much it faces the camera, so a turned face doesn't draw
  // contour on the wrong cheek.
  const noseRatio = (lm[1].x - lm[234].x) / ((lm[454].x - lm[234].x) || 0.001);
  const visL = Math.min(1, Math.max(0, (noseRatio - 0.15) / 0.22));
  const visR = Math.min(1, Math.max(0, (0.85 - noseRatio) / 0.22));
  // Landmark 234 sits on the left side of the face; 454 on the right.
  const sideVis = (startIdx) => (startIdx===234 || startIdx===103 || startIdx===116)
    ? visL
    : (startIdx===454 || startIdx===332 || startIdx===345) ? visR : 1;

  function P(i){ return {x:lm[i].x*W, y:lm[i].y*H}; }

  // Reusable quadratic bezier sweep with blurred hint + dashed stroke + arrow + dot
  function sweepStroke(p0, ctrl, p2) {
    // Soft, narrow placement hint.
    if (fc) {
      ctx.save(); ctx.filter='blur(3px)'; ctx.globalAlpha=0.55;
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
      ctx.strokeStyle=fc; ctx.lineWidth=lw*3.2; ctx.lineCap='round'; ctx.stroke();
      ctx.restore();
    }
    // Fine white line over a dark backing so it shows on a shadowed cheek.
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle='rgba(0,0,0,0.40)'; ctx.lineWidth=lw*0.95+1.2; ctx.lineCap='round';
    ctx.setLineDash([lw*4,lw*2.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
    ctx.strokeStyle=CONTOUR_GUIDE; ctx.lineWidth=lw*0.95; ctx.lineCap='round';
    ctx.setLineDash([lw*4,lw*2.5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    const ah=lw*2.4, ang=Math.atan2(p2.y-ctrl.y, p2.x-ctrl.x);
    ctx.save(); ctx.translate(p2.x,p2.y); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(-ah,-ah*0.52); ctx.lineTo(0,0); ctx.lineTo(-ah,ah*0.52);
    ctx.strokeStyle=CONTOUR_GUIDE; ctx.lineWidth=lw*0.75; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(p0.x,p0.y,Math.max(2.2,lw*0.8),0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.fill(); ctx.restore();
  }

  // ① Nose sides, always shown.
  drawNoseContourGuide(ctx, lm, W, H, sc, fc, lw);

  // Fades the receding side; below 0.05 it isn't drawn at all.
  const sided = (startIdx, drawFn) => {
    const v = sideVis(startIdx);
    if (v <= 0.05) return;
    ctx.save(); ctx.globalAlpha = v; drawFn(); ctx.restore();
  };

  // ② Cheek / jaw strokes - per face shape
  if (shape==='oval') {
    // Classic cheekbone hollow sweep: ear → upper-cheek → hollow
    [{s:234,c:116,e:132},{s:454,c:345,e:361}].forEach(({s,c,e})=>{
      sided(s, ()=>{
        const p0=P(s), ctrl=P(c), pe=P(e);
        sweepStroke(p0, ctrl, {x:p0.x+0.65*(pe.x-p0.x), y:p0.y+0.65*(pe.y-p0.y)+faceH*0.01});
      });
    });
  }

  if (shape==='round') {
    // Long sweep temple → cheek-mid → lower jaw to slim sides
    [{s:234,c:116,e:172},{s:454,c:345,e:397}].forEach(({s,c,e})=>{
      sided(s, ()=> sweepStroke(P(s), P(c), P(e)));
    });
  }

  if (shape==='oblong') {
    // Cheek sweep + short forehead-corner marks to add visual width
    [{s:234,c:116,e:132},{s:454,c:345,e:361}].forEach(({s,c,e})=>{
      sided(s, ()=>{
        const p0=P(s), ctrl=P(c), pe=P(e);
        sweepStroke(p0, ctrl, {x:p0.x+0.65*(pe.x-p0.x), y:p0.y+0.65*(pe.y-p0.y)+faceH*0.01});
      });
    });
    [{i:103,dir:1},{i:332,dir:-1}].forEach(({i,dir})=>{
      sided(i, ()=>{
        const sp=P(i);
        sweepStroke(sp, {x:sp.x+dir*faceW*0.06,y:sp.y+faceH*0.03}, {x:sp.x+dir*faceW*0.13,y:sp.y+faceH*0.06});
      });
    });
  }

  if (shape==='heart') {
    // Jaw sides: from cheek outward down toward chin to widen jaw visually
    [{s:234,c:172,e:150},{s:454,c:397,e:379}].forEach(({s,c,e})=>{
      sided(s, ()=> sweepStroke(P(s), P(c), P(e)));
    });
  }

  if (shape==='diamond') {
    // Forehead sides (down) + lower jaw sides to balance wide cheekbones
    [{s:103,c:234,e:116},{s:332,c:454,e:345}].forEach(({s,c,e})=>{
      sided(s, ()=> sweepStroke(P(s), P(c), P(e)));
    });
    [{s:116,c:172,e:150},{s:345,c:397,e:379}].forEach(({s,c,e})=>{
      sided(s, ()=> sweepStroke(P(s), P(c), P(e)));
    });
  }

  if (shape==='square') {
    // Like oval but extended to jaw corner to soften angular jaw
    [{s:234,c:116,e:172},{s:454,c:345,e:397}].forEach(({s,c,e})=>{
      sided(s, ()=> sweepStroke(P(s), P(c), P(e)));
    });
  }
}

// ── Skin tone ──
// The whites of the eyes are close to neutral for everyone, so any tint there comes
// from the lighting. It's used to white-balance the skin sample (Mbatha et al.).
function sampleScleraWhite(ctx, lm, vW, vH) {
  try {
    const pts=[];
    const between=(cornerIdx, irisIdx)=>{
      const c=lm[cornerIdx], ir=lm[irisIdx];
      if(!c||!ir) return;
      [0.35,0.55].forEach(t=>pts.push({x:c.x+(ir.x-c.x)*t, y:c.y+(ir.y-c.y)*t}));
    };
    if (lm.length>473){
      // refineLandmarks gives iris centres (468 left, 473 right): the segment
      // from each eye corner toward the iris lands squarely on sclera.
      between(33,468); between(133,468);
      between(263,473); between(362,473);
    } else {
      [[33,133],[362,263]].forEach(([a,b])=>{
        const p=lm[a], q=lm[b]; if(!p||!q) return;
        pts.push({x:(p.x+q.x)/2, y:(p.y+q.y)/2});
      });
    }

    const cand=[];
    pts.forEach(p=>{
      const cx=Math.round(p.x*vW), cy=Math.round(p.y*vH);
      const x0=Math.max(0,cx-2), y0=Math.max(0,cy-2);
      const w=Math.min(vW,cx+3)-x0, h=Math.min(vH,cy+3)-y0;
      if(w<=0||h<=0) return;
      const d=ctx.getImageData(x0,y0,w,h).data;
      for(let q=0;q<d.length;q+=4){
        const r=d[q], g=d[q+1], b=d[q+2];
        const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
        const sat = mx===0 ? 0 : (mx-mn)/mx;
        // Sclera: bright and the least saturated thing near the eye. Kept loose because a
        // strong colour cast tints the sclera too, and that tint is what we're measuring.
        if (mx>70 && sat<0.45) cand.push({r,g,b,v:mx,s:sat});
      }
    });
    if (cand.length<8) return null;
    // Keep the least saturated half (skin and iris are more saturated than sclera).
    cand.sort((a,b)=>a.s-b.s);
    const top=cand.slice(0, Math.max(6, Math.floor(cand.length*0.5)));
    const med=k=>{const a=top.map(s=>s[k]).sort((p,q)=>p-q);return a[a.length>>1];};
    const w={r:med('r'), g:med('g'), b:med('b')};
    // A clipped reference has lost its colour information, so the cast it
    // reports cannot be trusted (only its brightness can).
    w.clipped = Math.max(w.r,w.g,w.b) >= 250;
    return w;
  } catch(e){ return null; }
}

function detectToneFromImage(image, lm, W, H) {
  try {
    const vW=image.width||W, vH=image.height||H;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const ctx=tmp.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,0,0,vW,vH);
    // Well-lit skin only: cheeks and forehead (no nose tip shine or chin shadow).
    const idxs=[234,454,116,345,50,280,205,425,10,151,9,117,346];
    const samples=[];
    idxs.forEach(i=>{
      const p=lm[i]; if(!p) return;
      const cx=Math.round(p.x*vW), cy=Math.round(p.y*vH);
      const x0=Math.max(0,cx-2), y0=Math.max(0,cy-2);
      const w=Math.min(vW,cx+3)-x0, h=Math.min(vH,cy+3)-y0;
      if(w<=0||h<=0) return;
      const d=ctx.getImageData(x0,y0,w,h).data;
      let r=0,g=0,b=0,n=0;
      for(let q=0;q<d.length;q+=4){r+=d[q];g+=d[q+1];b+=d[q+2];n++;}
      if(n) samples.push({r:r/n,g:g/n,b:b/n});
    });
    if (!samples.length) return 'medium_warm';
    // Median per channel - robust to a single shadowed point, stray hair, or a
    // glasses frame crossing a sample.
    const med=k=>{const a=samples.map(s=>s[k]).sort((p,q)=>p-q);return a[a.length>>1];};
    let r=med('r'), g=med('g'), b=med('b');

    // ── Lighting normalisation against the neutral sclera reference ──
    const white=sampleScleraWhite(ctx, lm, vW, vH);
    if (white){
      // 1. Colour cast: per-channel gains that turn the reference grey (von Kries).
      //    Skipped when the reference is clipped.
      const clampGain=v=>Math.min(1.6, Math.max(0.625, v));
      if (!white.clipped){
        const wMean=(white.r+white.g+white.b)/3;
        r=Math.min(255,r*clampGain(wMean/Math.max(1,white.r)));
        g=Math.min(255,g*clampGain(wMean/Math.max(1,white.g)));
        b=Math.min(255,b*clampGain(wMean/Math.max(1,white.b)));
      } else {
        // Clipped reference: anchor on green for a partial correction.
        r=Math.min(255,r*clampGain(white.g/Math.max(1,white.r)));
        b=Math.min(255,b*clampGain(white.g/Math.max(1,white.b)));
      }

    }

    const br=r*.299+g*.587+b*.114;

    // ── Tone level ──
    // Skin brightness relative to the sclera, so exposure cancels out.
    let level;
    if (white && !white.clipped){
      const wBr=white.r*.299+white.g*.587+white.b*.114;
      const ratio=br/Math.max(1,wBr);
      // Boundaries sit midway between the reference skin swatches measured
      // against a neutral sclera (light .90, medium .68, deep .42).
      level = ratio>0.785 ? 'light' : ratio>0.545 ? 'medium' : 'dark';
    } else {
      // No usable reference (eyes closed or blown out): fall back to absolute bands.
      level = br>178 ? 'light' : br>128 ? 'medium' : 'dark';
    }
    // Undertone judged relative to overall brightness, so it isn't just "warm"
    // for everyone (skin is always r>b in absolute terms).
    const undertone = (r-b) > br*0.20 ? 'warm' : 'cool';
    return `${level}_${undertone}`;
  } catch(e){return 'medium_warm';}
}
function formatTone(k){return{light_warm:'Light Warm',light_cool:'Light Cool',medium_warm:'Medium Warm',medium_cool:'Medium Cool',dark_warm:'Deep Warm',dark_cool:'Deep Cool'}[k]||k;}

// ── Extra brand options (display) ──
// Extra brands use the same markup as the first one. Empty when there's only one brand.
function altOptions(entry){ return (entry&&entry.alt)||[]; }

// Shades screen: extra brand blocks inside the same shade card.
function altShadeHTML(entry) {
  const alts=altOptions(entry);
  if (!alts.length) return '';
  return alts.map(a=>
    `<div class="shade-opt-sep"></div>`+
    `<div class="shade-swatch" style="background:${a.hex}"></div>`+
    `<div class="shade-name-txt">${a.shade}</div>`+
    `<div class="shade-brand-txt">${a.brand||a.product||''}</div>`+
    (a.slot!=null?`<div class="shade-slot-badge">Slot ${a.slot}</div>`:'')
  ).join('');
}

// Step screen: one shade card per extra brand.
function altStepCardsHTML(entry) {
  const alts=altOptions(entry);
  if (!alts.length) return '';
  return alts.map(a=>
    `<div class="step-shade-card">`+
      `<div class="ssc-swatch" style="background:${a.hex}"></div>`+
      `<div class="ssc-info">`+
        `<div class="ssc-shade">${a.shade}</div>`+
        `<div class="ssc-brand">${a.brand||a.product||''}</div>`+
        (a.slot!=null?`<div class="ssc-slot">Tray slot ${a.slot}</div>`:'')+
      `</div>`+
    `</div>`
  ).join('');
}

// Foundation screen: one full .found-card per additional brand.
function altFoundCardsHTML(entry) {
  const alts=altOptions(entry);
  if (!alts.length) return '';
  return alts.map(a=>
    `<div class="found-card">`+
      `<div class="found-swatch" style="background:${a.hex}"></div>`+
      `<div class="found-info">`+
        `<div class="found-label">Also available for your skin tone</div>`+
        `<div class="found-shade">${a.shade}</div>`+
        `<div class="found-product">${a.product||''}</div>`+
        `<div class="found-brand">${a.brand||''}</div>`+
        (a.slot!=null?`<div class="found-slot">Tray slot ${a.slot}</div>`:'')+
      `</div>`+
    `</div>`
  ).join('');
}

// ── Shade recommendations ──
function showShades() {
  const toneKey=STATE.toneKey||'medium_warm';
  // One winning product per category, scored across every available brand.
  const tone=selectBestSet(STATE.shades?.[toneKey]);
  if (!tone||!Object.keys(tone).length){console.error('No shades for',toneKey);return;}
  document.getElementById('shade-tone-label').textContent=`Skin tone: ${formatTone(toneKey)} · Soft & Natural`;
  const map={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const focal=map[STATE.focal]||STATE.focal;
  document.getElementById('focal-badge-label').textContent=STATE.focalData?.[STATE.focal]?.label||STATE.focal;
  updateLookBadges();
  const grid=document.getElementById('shade-grid'); grid.innerHTML='';
  STEPS.forEach(step=>{
    const shade=tone[step]; if (!shade) return;
    const isFocal=step===focal;
    const card=document.createElement('div');
    card.className='shade-card'+(isFocal?' focal-highlight':'');
    // The selected entry has no .alt, so one product shows per category.
    card.innerHTML=`<div class="shade-swatch" style="background:${shade.hex}"></div><div class="shade-step-label">${STEP_LABELS[step]}${isFocal?'<span class="focal-star"> ★</span>':''}</div><div class="shade-name-txt">${shade.shade}</div><div class="shade-brand-txt">${shade.brand||''}</div><div class="shade-prod-txt">${shade.product||''}</div><div class="shade-slot-badge">Slot ${shade.slot}</div>${altShadeHTML(shade)}`;
    grid.appendChild(card);
  });
  // Why these products, and confirmation that all three brands were considered.
  const why=document.getElementById('shade-reason');
  if (why){
    const lookLabel=currentLookLabel();
    // "School Look" already ends in the word; the other three need it added.
    const lookPhrase=lookLabel ? (/look$/i.test(lookLabel)?lookLabel:`${lookLabel} look`) : '';
    why.textContent='One best match per feature, picked from Detail Cosmetics, '
      +`Squad Cosmetics and Chuchu Beauty for your ${formatTone(toneKey)} skin tone`
      +(lookPhrase?` and your ${lookPhrase}`:'')+'.';
  }
  goTo('screen-shades');
  prewarmTryOnMesh();
  // Load the quality model now so the first check isn't delayed.
  initQualityModel();
}

// ── Picture-based reference guide ──
// The captured photo re-rendered with the chosen style, shown beside the mirror.
function captureReferenceFrame(image, lm) {
  try {
    const vW=image.width||640, vH=image.height||480;
    const c=document.createElement('canvas'); c.width=vW; c.height=vH;
    c.getContext('2d').drawImage(image,0,0,vW,vH);
    STATE.captureCanvas=c;
    // Deep copy - the live landmark array is reused by MediaPipe each frame.
    STATE.captureLm=lm.map(p=>({x:p.x,y:p.y,z:p.z}));
  } catch(e){ console.error('Reference capture failed:', e); }
}

// Paints the captured photo and style onto a canvas, cropped to portrait.
const REF_PORTRAIT = 3/4;   // width:height

function paintReferenceGuide(canvasEl, style) {
  if (!canvasEl || !STATE.captureCanvas || !STATE.captureLm) return false;
  const src=STATE.captureCanvas;
  const W=src.width, H=src.height;

  // 1) Render the complete look at native resolution off-screen.
  const full=document.createElement('canvas'); full.width=W; full.height=H;
  const fctx=full.getContext('2d');
  fctx.drawImage(src,0,0);
  // Always the complete look, even if a per-step preview is open.
  drawVirtualMakeup(fctx, STATE.captureLm, W, H, { style, stepOnly:null });

  // 2) Crop a portrait region centred on the FACE, not on the image, so an
  //    off-centre subject is never clipped.
  let cw=H*REF_PORTRAIT, ch=H;
  if (cw>W){ cw=W; ch=W/REF_PORTRAIT; }
  const lmc=STATE.captureLm;
  const faceCx=lmc[1].x*W;
  const faceCy=((lmc[10].y+lmc[152].y)/2)*H;   // brow-to-chin midpoint
  // clamp so the crop window stays inside the source image
  const cx=Math.max(0, Math.min(W-cw, faceCx-cw/2));
  const cy=Math.max(0, Math.min(H-ch, faceCy-ch/2));
  if (canvasEl.width!==Math.round(cw))  canvasEl.width =Math.round(cw);
  if (canvasEl.height!==Math.round(ch)) canvasEl.height=Math.round(ch);
  const ctx=canvasEl.getContext('2d');
  ctx.clearRect(0,0,canvasEl.width,canvasEl.height);
  ctx.drawImage(full, cx,cy,cw,ch, 0,0,canvasEl.width,canvasEl.height);
  return true;
}

// ── Bare-face baseline ──
// Brows, lips and hollows differ from skin even without makeup, so each zone is
// recorded at capture. Later checks ask "has this zone changed since the before
// photo?" instead of comparing it to skin.
function zoneRegionPts(lm, step, W, H) {
  const P=i=>({x:lm[i].x*W, y:lm[i].y*H});
  if (step==='lips')     return [{outer:lmPts(lm,LIP_OUTER_LOOP,W,H), inner:lmPts(lm,LIP_INNER,W,H)}];
  if (step==='eyebrows') return [
    {outer:[...BROW_LEFT_TOP.map(P),  ...[...BROW_LEFT_BOTTOM ].reverse().map(P)], inner:null},
    {outer:[...BROW_RIGHT_TOP.map(P), ...[...BROW_RIGHT_BOTTOM].reverse().map(P)], inner:null},
  ];
  if (step==='contour')  return [
    {outer:CHEEK_HOLLOW_L.map(P), inner:null},
    {outer:CHEEK_HOLLOW_R.map(P), inner:null},
  ];
  // blush - apples of the cheeks
  return [
    {outer:[123,50,205,206,207,187].map(P), inner:null},
    {outer:[352,280,425,426,427,411].map(P), inner:null},
  ];
}

// Average the robust samples of a step's regions in one frame.
function measureZone(frameData, lm, step, W, H) {
  const parts=zoneRegionPts(lm, step, W, H)
    .map(({outer,inner})=>sampleRegionRobust(frameData,W,H,outer,inner))
    .filter(Boolean);
  if (!parts.length) return null;
  const avg=k=>parts.reduce((s,p)=>s+p[k],0)/parts.length;
  return { r:avg('r'), g:avg('g'), b:avg('b'), sat:avg('sat'), satIQR:avg('satIQR') };
}

// Neutral skin reference (forehead) for the same frame.
function measureSkin(frameData, lm, W, H) {
  const P=i=>({x:lm[i].x*W, y:lm[i].y*H});
  return sampleRegionRobust(frameData,W,H,
    [103,67,109,10,338,297,332,336,9,107].map(P), null);
}

function captureBaseline(image, lm) {
  try {
    const W=image.width||640, H=image.height||480;
    const c=document.createElement('canvas'); c.width=W; c.height=H;
    const x=c.getContext('2d',{willReadFrequently:true});
    x.drawImage(image,0,0,W,H);
    const fd=x.getImageData(0,0,W,H).data;
    const skin=measureSkin(fd,lm,W,H);
    if (!skin){ STATE.baseline=null; return; }
    const base={ skin };
    STEPS.forEach(s=>{ base[s]=measureZone(fd,lm,s,W,H); });
    STATE.baseline=base;
    console.log('[baseline] bare-face reference captured', base);
  } catch(e){ console.warn('[baseline] capture failed:', e.message); STATE.baseline=null; }
}

// How much a zone has changed versus the user's own bare-face baseline,
// after neutralising any overall lighting shift between the two moments.
function compareToBaseline(frameData, lm, step, W, H) {
  const b=STATE.baseline;
  if (!b || !b[step] || !b.skin) return null;
  const now=measureZone(frameData,lm,step,W,H);
  const nowSkin=measureSkin(frameData,lm,W,H);
  if (!now || !nowSkin) return null;

  // Lighting compensation: scale the baseline by how the neutral skin
  // reference itself changed, so a brighter room isn't read as product.
  const k=ch=>{ const d=b.skin[ch]; return d>4 ? nowSkin[ch]/d : 1; };
  const kr=k('r'), kg=k('g'), kb=k('b');
  const exp={ r:b[step].r*kr, g:b[step].g*kg, b:b[step].b*kb };

  const dR=now.r-exp.r, dG=now.g-exp.g, dB=now.b-exp.b;
  return {
    now, expected:exp,
    delta: Math.abs(dR)+Math.abs(dG)+Math.abs(dB),   // total colour change
    darker: (exp.r*.299+exp.g*.587+exp.b*.114)-(now.r*.299+now.g*.587+now.b*.114),
    satGain: now.sat - b[step].sat,
    redGain: (now.r-now.g) - (exp.r-exp.g),
    pinkGain:(now.r-now.b) - (exp.r-exp.b),
    satIQR: now.satIQR,
  };
}

// ── Style variation screen ──
function renderStyleScreen() {
  const grid=document.getElementById('style-grid');
  const sub=document.getElementById('style-sub');
  if (!grid) return;
  grid.innerHTML='';

  const focalLabel=STATE.focalData?.[STATE.focal]?.label||STATE.focal||'your focal point';
  const variations=STATE.styleData?.[STATE.focal];

  if (!Array.isArray(variations)||!variations.length){
    // Preset file missing: let the user continue instead of getting stuck.
    grid.innerHTML='<p class="page-sub" style="grid-column:1/-1;text-align:center">'
      +'Style variations are unavailable right now. Continuing with the standard '
      +'Soft &amp; Natural look.</p>';
    STATE.style=null;
    const nb=document.getElementById('btn-style-next'); if(nb) nb.disabled=false;
    return;
  }

  // Kept short so it doesn't wrap on a phone.
  const lookLabel=currentLookLabel();
  if (sub) sub.textContent=(lookLabel?`${lookLabel} · `:'')
    +`Same ${focalLabel} shades, three levels of coverage`;

  const focalStep={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'}[STATE.focal]||'lips';

  // Shades are the same for every variation, so the swatches are too.
  const resolved=selectBestSet(resolveShades(STATE.toneKey||'medium_warm', null))||{};
  const swatches=STEPS.map(step=>{
    const hex=resolved[step]?.hex||'#555';
    const lead=step===focalStep?' lead':'';
    const title=`${STEP_LABELS[step]}: ${resolved[step]?.shade||'Not set'}`;
    return `<span class="style-swatch${lead}" style="background:${hex}" title="${title}"></span>`;
  }).join('');

  variations.forEach(v=>{
    const card=document.createElement('div');
    card.className='style-card'+(STATE.style?.id===v.id?' selected':'');
    card.setAttribute('role','button');
    card.setAttribute('tabindex','0');

    // Coverage of the focal feature is what actually differs between variations.
    const fi=(v.intensity&&v.intensity[focalStep])||0.6;
    const level = fi<0.7 ? 1 : fi<0.92 ? 2 : 3;
    const covLabel = ['','Sheer','Balanced','Full'][level];
    const meter=[1,2,3].map(i=>`<span class="cov-seg${i<=level?' on':''}"></span>`).join('');

    card.innerHTML=
      `<div class="style-card-head">`+
        `<span class="style-name">${v.name}</span>`+
        `<span class="style-tick">✓</span>`+
      `</div>`+
      `<div class="style-coverage">`+
        `<span class="cov-meter">${meter}</span>`+
        `<span class="cov-label">${covLabel} coverage</span>`+
      `</div>`+
      `<div class="style-swatch-row">${swatches}</div>`+
      `<p class="style-desc">${v.desc||''}</p>`;

    card.onclick=()=>selectStyle(v.id);
    card.onkeydown=(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); selectStyle(v.id); } };
    grid.appendChild(card);
  });

  // Re-paint the preview if a style was already chosen (e.g. user came back).
  if (STATE.style) selectStyle(STATE.style.id);
}

function selectStyle(id) {
  const variations=STATE.styleData?.[STATE.focal]||[];
  const v=variations.find(x=>x.id===id);
  if (!v) return;
  STATE.style=v;

  document.querySelectorAll('#style-grid .style-card').forEach((c,i)=>{
    c.classList.toggle('selected', variations[i]?.id===id);
  });

  const canvas=document.getElementById('ref-guide-canvas');
  const empty=document.getElementById('ref-guide-empty');
  const painted=paintReferenceGuide(canvas, v);
  if (canvas) canvas.classList.toggle('ready', painted);
  if (empty)  empty.style.display=painted?'none':'';
  if (empty && !painted){
    empty.textContent='Reference guide unavailable. Your captured photo could not be read. '
      +'You can still continue; the live AR guide is unaffected.';
  }

  const nb=document.getElementById('btn-style-next');
  if (nb) nb.disabled=false;
}

// ── Foundation checker ──
// Recommends a base shade only. It never checks the shade used and has no AR guide.
function renderFoundationScreen() {
  const toneKey=STATE.toneKey||'medium_warm';
  // Same one-product rule; for foundation this picks the closest match to the skin.
  const f=bestProduct(STATE.foundationData?.[toneKey], 'foundation');
  const set=(id,txt)=>{const el=document.getElementById(id); if(el) el.textContent=txt;};

  if (!f){
    set('found-shade','Unavailable');
    set('found-product','The foundation library could not be loaded.');
    set('found-brand','');
    set('found-slot','');
    const fa0=document.getElementById('found-alt');
    if (fa0){ fa0.innerHTML=''; fa0.style.display='none'; }
    const sw=document.getElementById('found-swatch');
    if (sw) sw.style.background='#ffd3e5';
    return;
  }
  const sw=document.getElementById('found-swatch');
  if (sw) sw.style.background=f.hex;
  set('found-shade',   f.shade);
  set('found-product', f.product||'');
  set('found-brand',   f.brand||'');
  set('found-slot',    `Tray slot ${f.slot}`);
  const fa=document.getElementById('found-alt');
  if (fa){ const h=altFoundCardsHTML(f); fa.innerHTML=h; fa.style.display=h?'':'none'; }
}

function confirmFoundation(applied) {
  STATE.foundationConfirmed=!!applied;
  startMakeupSteps();
}

// ── Makeup steps ──
async function startMakeupSteps() {
  stopTryOn();
  stopStream();
  STATE.currentStep=0; STATE.stepResults=[]; STATE.lipSubStep=0;
  renderStep(0); goTo('screen-step');
  const sv=document.getElementById('step-video');
  try {
    STATE.stream=await openCamera();
    sv.srcObject=STATE.stream;
    if (sv.readyState>=1) startStepFaceMesh();
    else sv.onloadedmetadata=()=>startStepFaceMesh();
  } catch(e){console.error('Step camera error:',e);}
}

function renderStep(index) {
  const step=STEPS[index];
  const tone=activeShades();
  const shade=tone?.[step];
  renderStepReference();
  const dr=document.getElementById('step-dot-row'); dr.innerHTML='';
  STEPS.forEach((_,i)=>{const d=document.createElement('div');d.className='step-dot'+(i<index?' done':i===index?' active':'');dr.appendChild(d);});

  // How much product to apply for the chosen variation.
  const covNote = coverageNote(step);
  // Finish guidance from the selected makeup look, combined with the focal point.
  const lookN   = lookNote(step);

  if (step==='lips'){
    const sub=LIP_SUBSTEP[STATE.lipSubStep]||LIP_SUBSTEP[0];
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}  ·  ${sub.badge}`;
    document.getElementById('step-name').textContent=`Lips · ${sub.label}`;
    // Coverage applies to the final lip check, not the top/bottom fill sub-steps.
    document.getElementById('step-instruction').textContent=
      sub.instruction + lookN + (STATE.lipSubStep>=2 ? covNote : '');
  } else {
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}`;
    document.getElementById('step-name').textContent=STEP_LABELS[step];
    document.getElementById('step-instruction').textContent=STEP_INSTRUCTIONS[step] + lookN + covNote;
  }

  if (shade){
    document.getElementById('ssc-swatch').style.background=shade.hex;
    document.getElementById('ssc-shade').textContent=shade.shade;
    document.getElementById('ssc-brand').textContent=shade.brand||shade.product||'';
    document.getElementById('ssc-slot').textContent=`Tray slot ${shade.slot}`;
    const sa=document.getElementById('ssc-alt');
    if (sa){ const h=altStepCardsHTML(shade); sa.innerHTML=h; sa.style.display=h?'':'none'; }
  }

  // Visible "amount to apply" indicator for the chosen variation's coverage.
  const covStep = (step==='lips' && STATE.lipSubStep<2) ? null : step;
  const covCard=document.getElementById('step-coverage-card');
  if (covCard){
    if (covStep){
      const lvl=coverageLevel(covStep);
      const word=['', 'Sheer', 'Medium', 'Full'][lvl];
      const meter=[1,2,3].map(i=>`<span class="scc-seg${i<=lvl?' on':''}"></span>`).join('');
      const m=document.getElementById('scc-meter'); if(m) m.innerHTML=meter;
      const t=document.getElementById('scc-text'); if(t) t.textContent=word+(STATE.style?` · ${STATE.style.name}`:'');
      covCard.style.display='';
    } else {
      covCard.style.display='none';   // hidden on the top/bottom lip fill sub-steps
    }
  }
  document.getElementById('feedback-area').style.display='none';
  hideQualityReport();
  document.getElementById('btn-check').style.display='';
  document.getElementById('btn-check').disabled=false;
  document.getElementById('btn-check').onclick=checkPlacement;
  document.getElementById('btn-next').style.display='none';
  document.getElementById('btn-retry').style.display='none';
  STATE.checkPending=false;

  // Named after the step so it isn't confused with the still "Your Finished Look".
  const cmp=document.getElementById('btn-compare');
  if (cmp) cmp.innerHTML=`<span class="tryon-spark">✦</span>Preview ${STEP_LABELS[step]} Live`;

  STATE.blushLm         = null;
  STATE.blushFrameCount = 0;

  let skipBtn=document.getElementById('btn-skip');
  if (!skipBtn){
    skipBtn=document.createElement('button'); skipBtn.id='btn-skip';
    skipBtn.className='btn-ghost'; skipBtn.textContent='Skip Step →';
    const retryBtn=document.getElementById('btn-retry');
    retryBtn?.parentElement?.insertBefore(skipBtn,retryBtn.nextSibling);
  }
  skipBtn.style.display='';
  skipBtn.onclick=skipStep;
}

// Paints the reference still into the narrow column beside the live mirror.
function renderStepReference() {
  const col=document.getElementById('step-ref-col');
  const canvas=document.getElementById('step-ref-canvas');
  const label=document.getElementById('step-ref-style');
  if (!col||!canvas) return;
  const painted=paintReferenceGuide(canvas, STATE.style);
  col.classList.toggle('ready', painted);
  if (label) label.textContent=painted?(STATE.style?.name||'Soft & Natural'):'';
}

// ── Step screen face tracking ──
function startStepFaceMesh() {
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const video=document.getElementById('step-video');
    const w=takeMesh(onStepResults); STATE.faceMesh=w.mesh;
    STATE.camera=startMeshLoop(video, ()=>w.ready.then(()=>STATE.faceMesh?.send({image:video})));
  }));
}

function onStepResults(results) {
  const canvas=document.getElementById('step-overlay');
  const video=document.getElementById('step-video');
  if (!canvas||!video) return;
  const {W,H,effW,effH,ox,oy}=syncOverlay(canvas,video);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  if (!results.multiFaceLandmarks?.length) return;

  const lm=results.multiFaceLandmarks[0];
  STATE.lastLandmarks=lm;

  let headDelta = 1;
  if (!STATE.smoothedLm||STATE.smoothedLm.length!==lm.length){
    STATE.smoothedLm=lm.map(p=>({x:p.x,y:p.y}));
  } else {
    let maxDelta=0;
    [1,234,454,10,152].forEach(i=>{const dx=lm[i].x-STATE.smoothedLm[i].x,dy=lm[i].y-STATE.smoothedLm[i].y;maxDelta=Math.max(maxDelta,Math.sqrt(dx*dx+dy*dy));});
    headDelta = maxDelta;
    // Same filter as the detection screen.
    STATE.smoothedLm=smoothLandmarks(STATE.smoothedLm, lm, turnVisibility(lm), 'step');
  }
  const dlm=STATE.smoothedLm;

  // Guides dim as the head turns instead of disappearing.
  const turnVis = turnVisibility(lm);

  const fMap={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const cs=STEPS[STATE.currentStep];
  const fs=fMap[STATE.focal]||cs;
  const shade=activeShades()?.[cs];
  const hex=shade?.hex||'#e87090';
  // The variation sets how strong the guide looks (never below 0.55).
  const si=Math.max(0.55, styleIntensity(cs));
  const sc=hexToRgba(hex,0.92*si);
  const fc=hexToRgba(hex,0.30*si);

  if (cs==='blush') {
    const BLUSH_IDX = [1, 10, 152, 205, 50, 116, 123, 425, 280, 345, 352, 234, 454];
    if (!STATE.blushLm) {
      STATE.blushLm = dlm.map(p => ({x:p.x, y:p.y}));
    } else {
      STATE.blushFrameCount++;
      const warmUp = STATE.blushFrameCount < 20;
      // Never jump straight to the raw landmarks, or the blush shape judders.
      const A = warmUp             ? 0.40
              : headDelta > 0.040  ? 0.46
              : headDelta > 0.001  ? 0.07 + (headDelta / 0.040) * 0.36
              :                      0.06;
      BLUSH_IDX.forEach(i => {
        STATE.blushLm[i].x += A * (dlm[i].x - STATE.blushLm[i].x);
        STATE.blushLm[i].y += A * (dlm[i].y - STATE.blushLm[i].y);
      });
      dlm.forEach((p,i) => {
        if (!BLUSH_IDX.includes(i)) { STATE.blushLm[i].x = p.x; STATE.blushLm[i].y = p.y; }
      });
    }
  }

  const blm = (cs==='blush' && STATE.blushLm) ? STATE.blushLm : dlm;

  ctx.save(); ctx.translate(-ox,-oy);
  // Guides fade a bit faster here, since a drifted guide is worse than none.
  const stepFade = turnVis>=0.7 ? turnVis : 0.7 * Math.pow(turnVis/0.7, 1.6);
  ctx.globalAlpha = stepFade;

  const blushCov=cs==='blush'?getBlushCoverage(document.getElementById('step-video'),blm):undefined;

  // The focal step gets a coloured glow.
  ctx.save();
  if (cs===fs && cs!=='lips'){ ctx.shadowColor=hex; ctx.shadowBlur=12; }

  if      (cs==='lips')     drawLips   (ctx,dlm,effW,effH,sc,fc,2.1,true,STATE.lipSubStep);
  else if (cs==='blush')    drawBlush  (ctx,dlm,effW,effH,sc,fc,2.3,blushCov);
  else if (cs==='eyebrows') drawBrows  (ctx,dlm,effW,effH,sc,fc,2.6);
  else if (cs==='contour')  drawContour(ctx,dlm,effW,effH,sc,fc,2.4);
  ctx.restore();

  // Hint when the head is turned too far. Shrinks, or switches to the short text,
  // to fit narrow screens.
  if (turnVis < 0.7){
    ctx.globalAlpha = 1;
    const full  = 'Face forward for the most accurate guide';
    const short = 'Face forward';
    const maxW  = Math.max(80, W - 28 - 2.2*15);   // 14 px inset each side, minus pill padding
    ctx.save();
    let px = 15;
    ctx.font = `500 ${px}px Jost, sans-serif`;
    let text = full;
    if (ctx.measureText(full).width > maxW){
      px = Math.max(10, Math.floor(15 * maxW / ctx.measureText(full).width));
      ctx.font = `500 ${px}px Jost, sans-serif`;
      if (ctx.measureText(full).width > maxW) text = short;
    }
    ctx.restore();
    drawMirroredText(ctx, text,
      W/2+ox, H*0.08+oy, `500 ${px}px Jost, sans-serif`, '#ffffff', true);
  }
  ctx.restore();
  checkStepLighting(video);
}

// ── Application quality (Objective 9) ──
// Checks a finished step for smudging, unevenness and product amount. Uses the
// trained MobileNetV2 model when installed, pixel analysis otherwise. Same output.
const QUALITY_MODEL_URL = 'models/application-quality/model.json';
const QUALITY_CLASSES   = ['good','smudged','uneven','amount'];
const QUALITY_INPUT     = 224;

let _qModel = null;
let _qState = 'idle';   // idle | loading | ready | absent

async function initQualityModel() {
  if (_qState!=='idle') return _qState;
  if (typeof tf==='undefined'){
    console.warn('[quality] TensorFlow.js not loaded, using analytical fallback.');
    _qState='absent'; return _qState;
  }
  _qState='loading';
  // A model trained on this device with trainer.html?slot=quality comes first.
  try {
    _qModel=await tf.loadLayersModel(localModelKey('quality'));
    await warmModel(_qModel, QUALITY_INPUT);
    _qState='ready';
    console.log('[quality] classifier ready (trained on this device).');
    return _qState;
  } catch(_){ _qModel=null; }
  try {
    _qModel=await tf.loadLayersModel(QUALITY_MODEL_URL);
    await warmModel(_qModel, QUALITY_INPUT);
    _qState='ready';
    console.log('[quality] MobileNetV2 classifier ready.');
  } catch(e) {
    _qModel=null; _qState='absent';
    console.warn('[quality] No trained model at '+QUALITY_MODEL_URL+
                 ', using analytical fallback. ('+e.message+')');
  }
  return _qState;
}

// ── ROI geometry, mirroring what each AR guide actually draws ──
function zoneShapes(lm, step, W, H) {
  const P=i=>({x:lm[i].x*W, y:lm[i].y*H});
  if (step==='lips')     return [{type:'poly', pts:lmPts(lm,LIP_OUTER_LOOP,W,H)}];
  if (step==='eyebrows') return [
    {type:'poly', pts:[...BROW_LEFT_TOP.map(P),  ...[...BROW_LEFT_BOTTOM ].reverse().map(P)]},
    {type:'poly', pts:[...BROW_RIGHT_TOP.map(P), ...[...BROW_RIGHT_BOTTOM].reverse().map(P)]},
  ];
  if (step==='contour')  return [
    {type:'poly', pts:CHEEK_HOLLOW_L.map(P)},
    {type:'poly', pts:CHEEK_HOLLOW_R.map(P)},
  ];
  // blush - same placement maths as drawBlush()
  const faceW=Math.abs(lm[234].x-lm[454].x)*W;
  const faceH=Math.abs(lm[10].y -lm[152].y)*H;
  const faceRef=Math.max(faceW, faceH*0.80);
  const nx=lm[1].x*W, ny=lm[1].y*H;
  return [234,454].map(t=>{
    const tx=lm[t].x*W, ty=lm[t].y*H;
    return { type:'ellipse',
      cx:nx+0.60*(tx-nx), cy:ny+0.60*(ty-ny)+faceRef*0.035,
      rx:faceRef*0.155, ry:faceRef*0.072,
      rot:Math.atan2(ty-ny, tx-nx) };
  });
}

// Fills the zone in white, optionally dilated about each shape's own centroid.
function paintZone(ctx, shapes, scale) {
  ctx.fillStyle='#fff';
  shapes.forEach(s=>{
    if (s.type==='ellipse'){
      ctx.save();
      ctx.translate(s.cx,s.cy); ctx.rotate(s.rot);
      ctx.beginPath(); ctx.ellipse(0,0,s.rx*scale,s.ry*scale,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    } else {
      const n=s.pts.length; if(!n) return;
      const cx=s.pts.reduce((a,p)=>a+p.x,0)/n;
      const cy=s.pts.reduce((a,p)=>a+p.y,0)/n;
      const sp=s.pts.map(p=>({x:cx+(p.x-cx)*scale, y:cy+(p.y-cy)*scale}));
      ctx.beginPath(); softPolyPath(ctx,sp); ctx.fill();
    }
  });
}

function shapesBBox(shapes, W, H, pad) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  shapes.forEach(s=>{
    if (s.type==='ellipse'){
      const r=Math.max(s.rx,s.ry);
      x0=Math.min(x0,s.cx-r); x1=Math.max(x1,s.cx+r);
      y0=Math.min(y0,s.cy-r); y1=Math.max(y1,s.cy+r);
    } else s.pts.forEach(p=>{
      x0=Math.min(x0,p.x); x1=Math.max(x1,p.x);
      y0=Math.min(y0,p.y); y1=Math.max(y1,p.y);
    });
  });
  if (!isFinite(x0)) return null;
  const px=(x1-x0)*pad, py=(y1-y0)*pad;
  x0=Math.max(0,Math.floor(x0-px)); y0=Math.max(0,Math.floor(y0-py));
  x1=Math.min(W,Math.ceil (x1+px)); y1=Math.min(H,Math.ceil (y1+py));
  const w=x1-x0, h=y1-y0;
  return (w<8||h<8)?null:{x:x0,y:y0,w,h};
}

// How far past the guide boundary product may sit before it reads as smudged.
// Blush and contour are meant to diffuse outward, so they get a wider band.
const QUALITY_HALO = { lips:1.32, eyebrows:1.40, blush:1.55, contour:1.55 };

// Tolerances per step, measured against the baseline (product only).
const QUALITY_BAND = {
  lips:     { minAmount:18, maxAmount:170, unevenMax:0.62, smudgeMax:0.44 },
  blush:    { minAmount:10, maxAmount:110, unevenMax:0.74, smudgeMax:0.68 },
  eyebrows: { minAmount:14, maxAmount:150, unevenMax:0.76, smudgeMax:0.54 },
  contour:  { minAmount:10, maxAmount:105, unevenMax:0.72, smudgeMax:0.68 },
};

function analyzeQualityHeuristic(video, lm, step) {
  const W=video.videoWidth||640, H=video.videoHeight||480;
  const mk=()=>{const c=document.createElement('canvas');c.width=W;c.height=H;
                return c.getContext('2d',{willReadFrequently:true});};

  const fx=mk(); fx.drawImage(video,0,0,W,H);
  const frame=fx.getImageData(0,0,W,H).data;

  const shapes=zoneShapes(lm,step,W,H);
  const ix=mk(); paintZone(ix,shapes,1.0);
  const ox=mk(); paintZone(ox,shapes,QUALITY_HALO[step]||1.45);
  const inD =ix.getImageData(0,0,W,H).data;
  const outD=ox.getImageData(0,0,W,H).data;

  // Skin baseline from the forehead - never a hardcoded tone lookup.
  let sr=0,sg=0,sb=0,sn=0;
  [10,9,151,107,336].forEach(i=>{
    const x=Math.round(lm[i].x*W), y=Math.round(lm[i].y*H);
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++){
      const px=x+dx, py=y+dy;
      if(px<0||px>=W||py<0||py>=H) continue;
      const o=(py*W+px)*4; sr+=frame[o]; sg+=frame[o+1]; sb+=frame[o+2]; sn++;
    }
  });
  if (!sn) return null;
  const skin={r:sr/sn, g:sg/sn, b:sb/sn};

  const devIn=[], devHalo=[];
  for (let y=0;y<H;y+=2) for (let x=0;x<W;x+=2){
    const m=(y*W+x)*4;
    const isIn=inD[m+3]>200, isOut=outD[m+3]>200;
    if (!isIn && !isOut) continue;
    const d=Math.abs(frame[m]-skin.r)+Math.abs(frame[m+1]-skin.g)+Math.abs(frame[m+2]-skin.b);
    if (isIn) devIn.push(d); else devHalo.push(d);
  }
  if (devIn.length<40) return null;

  const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
  const rawAmount=mean(devIn);

  // Subtract how much the zone differed from skin in the before photo, so "amount"
  // measures product, not anatomy.
  let natural=0;
  const b=STATE.baseline;
  if (b && b[step] && b.skin){
    natural=Math.abs(b[step].r-b.skin.r)+Math.abs(b[step].g-b.skin.g)+Math.abs(b[step].b-b.skin.b);
  }
  const amount=Math.max(0, rawAmount-natural);

  const sd=Math.sqrt(mean(devIn.map(v=>(v-rawAmount)*(v-rawAmount))));
  const uneven=sd/(rawAmount+8);
  const smudge=devHalo.length>20 ? mean(devHalo)/(rawAmount+8) : 0;

  const band=QUALITY_BAND[step]||QUALITY_BAND.lips;
  // Move the accepted amount to the chosen coverage, so a sheer look isn't flagged
  // "too little". cov is about 0.6 (sheer) to 1.0 (full).
  const cov = Math.max(0.45, Math.min(1, styleIntensity(step)));
  const minAmount = band.minAmount * (0.35 + 0.65*cov);   // sheer needs less to count
  const maxAmount = band.maxAmount * (0.55 + 0.45*cov);   // sheer flags excess sooner
  const tooLittle=amount<minAmount;
  const tooMuch  =amount>maxAmount;
  const amountOk =!tooLittle && !tooMuch;
  // Smudging and evenness are only judged once there's enough product.
  const measurable=!tooLittle;
  const smudgeOk=!measurable || smudge<=band.smudgeMax;
  const unevenOk=!measurable || uneven<=band.unevenMax;

  return {
    source:'heuristic',
    metrics:{ amount:+amount.toFixed(1), uneven:+uneven.toFixed(3), smudge:+smudge.toFixed(3) },
    passed: smudgeOk && unevenOk && amountOk,
    verdicts:{
      smudge:{ ok:smudgeOk, text:!measurable?'Not assessed':(smudgeOk?'Clean edges':'Colour outside the guide') },
      uneven:{ ok:unevenOk, text:!measurable?'Not assessed':(unevenOk?'Even coverage':'Patchy in places') },
      amount:{ ok:amountOk, text:amountOk?'Just right':(tooLittle?'Too little product':'Too much product') },
    },
    issues:[
      ...(smudgeOk?[]:['smudged']),
      ...(unevenOk?[]:['uneven']),
      ...(tooLittle?['too little']:[]),
      ...(tooMuch  ?['too much'] :[]),
    ],
  };
}

async function analyzeQualityModel(video, lm, step) {
  if (_qState!=='ready'||!_qModel) return null;
  const W=video.videoWidth||640, H=video.videoHeight||480;
  const box=shapesBBox(zoneShapes(lm,step,W,H), W, H, 0.30);
  if (!box) return null;

  let probs;
  try {
    const crop=document.createElement('canvas');
    crop.width=QUALITY_INPUT; crop.height=QUALITY_INPUT;
    crop.getContext('2d').drawImage(video, box.x,box.y,box.w,box.h, 0,0,QUALITY_INPUT,QUALITY_INPUT);
    const out=tf.tidy(()=>{
      const t=tf.browser.fromPixels(crop).toFloat().div(127.5).sub(1).expandDims(0);
      return _qModel.predict(t);
    });
    probs=Array.from(await out.data());
    out.dispose();
  } catch(e){
    console.warn('[quality] Inference failed, falling back:', e.message);
    return null;
  }

  const p={};
  QUALITY_CLASSES.forEach((c,i)=>{ p[c]=probs[i]??0; });
  const smudgeOk=p.smudged<0.5, unevenOk=p.uneven<0.5, amountOk=p.amount<0.5;

  return {
    source:'model',
    metrics:{ good:+(p.good||0).toFixed(3), smudged:+p.smudged.toFixed(3),
              uneven:+p.uneven.toFixed(3), amount:+p.amount.toFixed(3) },
    passed: smudgeOk && unevenOk && amountOk,
    verdicts:{
      smudge:{ ok:smudgeOk, text:smudgeOk?'Clean edges':'Smudging detected' },
      uneven:{ ok:unevenOk, text:unevenOk?'Even coverage':'Uneven application' },
      amount:{ ok:amountOk, text:amountOk?'Just right':'Product amount is off' },
    },
    issues:[
      ...(smudgeOk?[]:['smudged']),
      ...(unevenOk?[]:['uneven']),
      ...(amountOk?[]:['product amount']),
    ],
  };
}

function qualityMessage(step, q) {
  if (q.passed) return null;
  const label=(STEP_LABELS[step]||step).toLowerCase();
  const parts=[];
  if (!q.verdicts.smudge.ok) parts.push(`colour has spread past the guide, so tidy the edges of your ${label}`);
  if (!q.verdicts.uneven.ok) parts.push('coverage is patchy, so blend until the colour looks the same all over');
  if (!q.verdicts.amount.ok){
    const t=q.verdicts.amount.text;
    if (t.includes('Too little'))      parts.push('build up a little more product');
    else if (t.includes('Too much'))   parts.push('sheer it out, there is more product than the look needs');
    else                               parts.push('adjust the amount of product');
  }
  return parts.length
    ? parts.join('; ').replace(/^./,c=>c.toUpperCase())+'.'
    : 'Application quality needs a small adjustment before moving on.';
}

// Public entry point: model first, analytical fallback second.
async function analyzeApplicationQuality(video, lm, step) {
  await initQualityModel();
  let q=null;
  try { q=await analyzeQualityModel(video,lm,step); } catch(e){ q=null; }
  if (!q){
    try { q=analyzeQualityHeuristic(video,lm,step); } catch(e){ q=null; }
  }
  if (!q){
    // Neither back-end could read the region - never block the user on it.
    return { source:'unavailable', passed:true, metrics:{}, issues:[],
             verdicts:{ smudge:{ok:true,text:'Not assessed'},
                        uneven:{ok:true,text:'Not assessed'},
                        amount:{ok:true,text:'Not assessed'} },
             message:null };
  }
  q.message=qualityMessage(step,q);
  return q;
}

// ── Quality report panel ──
function showQualityReport(q) {
  const box=document.getElementById('quality-report');
  if (!box||!q) return;
  const set=(id,v)=>{
    const el=document.getElementById(id); if(!el) return;
    el.textContent=v.text;
    el.className='quality-verdict '+(v.ok?'ok':'bad');
  };
  set('q-smudge', q.verdicts.smudge);
  set('q-uneven', q.verdicts.uneven);
  set('q-amount', q.verdicts.amount);
  const src=document.getElementById('quality-source');
  if (src){
    src.textContent =
      q.source==='model'       ? 'Assessed by the application quality classifier'
    : q.source==='heuristic'   ? 'Assessed by image analysis (quality model not installed)'
    :                            'Quality assessment unavailable for this frame';
  }
  box.style.display='';
}

function hideQualityReport() {
  const box=document.getElementById('quality-report');
  if (box) box.style.display='none';
}

// ── Placement check ──
async function checkPlacement() {
  if (STATE.checkPending) return;
  STATE.checkPending=true;
  document.getElementById('btn-check').disabled=true;
  const vid=document.getElementById('step-video');
  const step=STEPS[STATE.currentStep];
  const lm=STATE.lastLandmarks;
  if (!lm){showFeedback(false,'Face not detected clearly. Make sure you are well-lit and centred.');return;}

  if (step==='lips'){
    const r=await analyzeLipSubStepAsync(vid,lm,STATE.lipSubStep);
    if (!r.passed)      { showFeedback(false,r.message); return; }
    if (r.warning)      { showShadeWarning(r.message,r);  return; }
    // Quality is judged on the finished mouth, so it only runs on the last sub-step.
    if (STATE.lipSubStep < LIP_SUBSTEP.length-1) { advanceLipSubStep(r); return; }
    const q=await analyzeApplicationQuality(vid,lm,'lips');
    advanceLipSubStep(r,q);
    return;
  }

  const r=analyzeZoneColor(vid,lm,step);
  if (!r.passed){
    recordStepResult(step,{passed:false,message:r.message,quality:null});
    showFeedback(false,r.message);
    return;
  }
  // Placement is correct - now judge how well it was applied.
  const q=await analyzeApplicationQuality(vid,lm,step);
  const passed=q.passed;
  const message=passed?r.message:q.message;
  recordStepResult(step,{passed,message,quality:q});
  showFeedback(passed,message,q);
}

// One row per step; a retry replaces the old result.
function recordStepResult(step, result) {
  const row={step, ...result};
  const i=STATE.stepResults.findIndex(x=>x.step===step);
  if (i>=0) STATE.stepResults[i]=row; else STATE.stepResults.push(row);
}

function advanceLipSubStep(r, q) {
  const step=STEPS[STATE.currentStep];
  const next=STATE.lipSubStep+1;
  if (next>=LIP_SUBSTEP.length){
    const passed=!q||q.passed;
    const message=passed?r.message:q.message;
    // Stay on the last lip sub-step on a fail, so Retry re-checks the whole mouth.
    if (passed) STATE.lipSubStep=0;
    recordStepResult(step,{passed,message,quality:q||null});
    showFeedback(passed,message,q);
  } else {
    STATE.lipSubStep=next;
    document.getElementById('step-name').textContent=`Lips · ${LIP_SUBSTEP[next].label}`;
    document.getElementById('step-instruction').textContent=LIP_SUBSTEP[next].instruction+lookNote('lips');
    document.getElementById('step-counter').textContent=`Step 1 of ${STEPS.length}  ·  ${LIP_SUBSTEP[next].badge}`;
    const area=document.getElementById('feedback-area');
    area.style.display=''; area.className='feedback-area good';
    document.getElementById('feedback-icon').textContent='✓';
    document.getElementById('feedback-msg').textContent=r.message;
    document.getElementById('btn-check').style.display='none';
    document.getElementById('btn-retry').style.display='none';
    document.getElementById('btn-next').style.display='none';
    const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
    setTimeout(()=>{
      area.style.display='none';
      document.getElementById('btn-check').style.display='';
      document.getElementById('btn-check').disabled=false;
      document.getElementById('btn-check').onclick=checkPlacement;
      STATE.checkPending=false;
    },1800);
  }
}

function showShadeWarning(message, r) {
  const area=document.getElementById('feedback-area');
  area.style.display=''; area.className='feedback-area bad';
  document.getElementById('feedback-icon').textContent='⚠';
  document.getElementById('feedback-msg').textContent=message;
  document.getElementById('btn-check').style.display='none';
  const retryBtn=document.getElementById('btn-retry');
  retryBtn.textContent='Try recommended shade'; retryBtn.style.display='';
  retryBtn.onclick=()=>{area.style.display='none';retryBtn.style.display='none';document.getElementById('btn-next').style.display='none';document.getElementById('btn-check').style.display='';document.getElementById('btn-check').disabled=false;document.getElementById('btn-check').onclick=checkPlacement;STATE.checkPending=false;};
  const nextBtn=document.getElementById('btn-next');
  nextBtn.textContent='Proceed anyway →'; nextBtn.style.display='';
  nextBtn.onclick=()=>advanceLipSubStep(r);
  STATE.checkPending=false;
}

// ── Lip analysis over several frames ──
async function analyzeLipSubStepAsync(video, lm, subStep) {
  const FRAMES=4, DELAY=70;

  // ── Measure the same regions across several frames ──
  const reads=[];
  let firstFrame=null;
  for (let f=0;f<FRAMES;f++){
    if(f>0) await new Promise(res=>setTimeout(res,DELAY));
    const W=video.videoWidth||640, H=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d',{willReadFrequently:true});
    tctx.drawImage(video,0,0,W,H);
    const frame=tctx.getImageData(0,0,W,H).data;

    const {outer,inner}=lipRegionPts(lm,W,H,subStep);
    const lip=sampleRegionRobust(frame,W,H,outer,inner);
    if (!lip) continue;
    if (f===0) firstFrame={data:frame,W,H};

    // Skin references, sampled as regions too (not a few pixels)
    const P=i=>({x:lm[i].x*W, y:lm[i].y*H});
    const cheekL=sampleRegionRobust(frame,W,H,[123,50,205,206,207,187].map(P),null);
    const cheekR=sampleRegionRobust(frame,W,H,[352,280,425,426,427,411].map(P),null);
    const fore  =sampleRegionRobust(frame,W,H,[103,67,109,10,338,297,332,336,9,107].map(P),null);
    // If a skin region is too small to sample (subject far from the camera),
    // fall back rather than discarding the frame outright.
    const cks=[cheekL,cheekR].filter(Boolean);
    let ck;
    if (cks.length){
      ck={ r:cks.reduce((s,c)=>s+c.r,0)/cks.length,
           g:cks.reduce((s,c)=>s+c.g,0)/cks.length,
           b:cks.reduce((s,c)=>s+c.b,0)/cks.length,
           sat:cks.reduce((s,c)=>s+c.sat,0)/cks.length };
    } else {
      const t=toneToRGB(STATE.toneKey||'medium_warm');
      ck={...t, sat:rgbSat(t.r,t.g,t.b)};
    }
    const fh = fore || ck;

    reads.push({
      r:lip.r, g:lip.g, b:lip.b, sat:lip.sat, satIQR:lip.satIQR, glare:lip.glareRatio,
      dev:  Math.abs(lip.r-ck.r)+Math.abs(lip.g-ck.g)+Math.abs(lip.b-ck.b),
      devFH:Math.abs(lip.r-fh.r)+Math.abs(lip.g-fh.g)+Math.abs(lip.b-fh.b),
      satInc:lip.sat-ck.sat,
      red:  (lip.r-lip.g)-(ck.r-ck.g),
      pink: (lip.r-lip.b)-(ck.r-ck.b),
    });
  }

  if (reads.length<3)
    return {passed:false,message:'Could not read your lips clearly. Face the camera in even light and hold still, then check again.'};

  // ── Combine frames by MEDIAN so one odd frame cannot decide the outcome ──
  const med=(key)=>{const c=reads.map(x=>x[key]).sort((a,b)=>a-b);const m=c.length>>1;
                    return c.length%2?c[m]:(c[m-1]+c[m])/2;};
  const r=med('r'), g=med('g'), b=med('b');
  const br=r*0.299+g*0.587+b*0.114;
  const absoluteSat=med('sat'), satIQR=med('satIQR'), glare=med('glare');
  const dev=med('dev'), devFH=med('devFH'), satIncrease=med('satInc');
  const redShift=med('red'), pinkShift=med('pink');

  // ── Detection decision ──
  // With a bare-face baseline, "changed since the before photo" decides. The
  // cheek-based thresholds are only a fallback.
  let detected, unstable=false;
  const bv = (STATE.baseline && firstFrame)
    ? baselineVerdict(firstFrame.data, lm, 'lips', firstFrame.W, firstFrame.H)
    : null;

  if (bv){
    detected = bv.applied;
  } else {
    const isLip=(x)=>x.sat>0.24 && x.dev>46 && x.devFH>54 && x.satInc>0.12 &&
                     (x.red>24 || x.pink>26);
    const votes=reads.filter(isLip).length;
    detected = br>20 && br<252 && votes > reads.length/2;
    unstable = !(votes===0 || votes===reads.length);
  }

  if (unstable && glare>0.10)
    return {passed:false,message:'Your lips are catching the light and the reading keeps changing. Blot any shine, angle away from the lamp, and check again.'};
  if (unstable)
    return {passed:false,message:'The reading was unstable. Hold still in even lighting for a moment, then check again.'};

  if (!detected){
    if (bv)
      return {passed:false,message:
        'No lipstick detected. Your lips look the same as in your before photo. '+
        'Fill fully within the outline in even light, then check again.'};
    // No red/pink shift = bare lips, read as "natural", never "too sheer".
    const hasColourShift=(redShift>16||pinkShift>18)&&satIncrease>0.06&&devFH>54;
    let msg;
    if(!hasColourShift)
      msg='No lipstick detected. Your lips look natural. If you have applied colour, fill fully within the outline in good light and hold still.';
    else if(dev<=46)
      msg='Colour is close to your skin tone. Try the recommended shade for a clearer result.';
    else
      msg='Application looks sheer. Build up a little more colour within the outline and check again.';
    return {passed:false,message:msg};
  }

  // Unevenness from the spread of the region, with glare excluded.
  if (satIQR>0.26)
    return {passed:false,message:'Application is uneven. Some areas look bare or patchy. Blend more evenly right to the outline edges, then check again.'};

  const recShade=activeShades()?.lips;
  const shadeHex=recShade?.hex;
  if(!shadeHex||shadeHex.length<7) return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
  const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
  const recBr=sr*0.299+sg*0.587+sb*0.114;
  const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
  const brightDiff=br-recBr;
  if(shadeDist<=70) return{passed:true,warning:false,message:'Lipstick applied and recognized. The shade matches your recommendation! Looks beautiful.'};
  let shadeMsg;
  if(brightDiff>45) shadeMsg='Too light. Your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
  else if(brightDiff<-45) shadeMsg='Too dark. Your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
  else shadeMsg="Wrong shade. The colour doesn't match the recommendation. Try the suggested shade for the best result.";
  return{passed:true,warning:true,message:shadeMsg};
}

// ── Zone colour analysis ──
// Minimum change from the before photo that counts as product applied, per step.
const BASELINE_MIN = {
  lips:     { delta:34, extra:(c)=>c.redGain>10||c.pinkGain>12||c.satGain>0.07 },
  eyebrows: { delta:26, extra:(c)=>c.darker>9 },
  blush:    { delta:20, extra:(c)=>c.redGain>7||c.pinkGain>8||c.satGain>0.045 },
  contour:  { delta:20, extra:(c)=>c.darker>7 },
};

// Has this step been applied? Judged against the before photo. null if there's no baseline.
function baselineVerdict(frameData, lm, step, W, H) {
  const c=compareToBaseline(frameData, lm, step, W, H);
  if (!c) return null;
  const rule=BASELINE_MIN[step]||BASELINE_MIN.lips;
  const applied = c.delta>rule.delta && rule.extra(c);
  return {applied, cmp:c};
}

function analyzeZoneColor(video, lm, step, sampleOverride) {
  try {
    const W=video.videoWidth||640, H=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d',{willReadFrequently:true}); tctx.drawImage(video,0,0,W,H);

    // ── Baseline decision (used whenever a before photo exists) ──
    if (step!=='lips' && STATE.baseline){
      const fd=tctx.getImageData(0,0,W,H).data;
      const bv=baselineVerdict(fd, lm, step, W, H);
      if (bv){
        if (!bv.applied){
          const noun={blush:'blush',eyebrows:'brow',contour:'contour'}[step]||step;
          return {passed:false, message:
            `No ${noun} product detected. This area looks the same as your before photo. `+
            `Apply within the guide in even light, then check again.`};
        }
        return {passed:true, message:goodMessages[step]};
      }
    }
    function sampleLandmarks(indices){
      let r=0,g=0,b=0,n=0;
      indices.forEach(i=>{const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);if(x>=1&&x<W-1&&y>=1&&y<H-1)for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;r+=d[0];g+=d[1];b+=d[2];n++;}});
      return n>0?{r:r/n,g:g/n,b:b/n}:null;
    }
    const zone=sampleLandmarks(sampleOverride||SAMPLE_IDX[step]||[]);
    if (!zone) return{passed:true,message:goodMessages[step]};
    const {r,g,b}=zone;
    const br=r*.299+g*.587+b*.114;

    if (step==='lips'){
      const cheek=sampleLandmarks([50,280,205,425,36,266]);
      const ck=cheek??toneToRGB(STATE.toneKey||'medium_warm');
      const dev=Math.abs(r-ck.r)+Math.abs(g-ck.g)+Math.abs(b-ck.b);
      const satIncrease=rgbSat(r,g,b)-rgbSat(ck.r,ck.g,ck.b);
      const absoluteSat=rgbSat(r,g,b);
      const redShift=(r-g)-(ck.r-ck.g);
      const pinkShift=(r-b)-(ck.r-ck.b);
      const detected=br>20&&br<252&&absoluteSat>0.24&&dev>46&&satIncrease>0.12&&(redShift>24||pinkShift>26);
      if (!detected){
        // No clear red/pink shift = bare lips, read as "natural".
        const hasColourShift=(redShift>16||pinkShift>18)&&satIncrease>0.06;
        let msg;
        if(!hasColourShift)
          msg='No lipstick detected. Your lips look natural. If you have applied colour, fill fully within the outline in good light and hold still.';
        else if(dev<=46)
          msg='Colour is close to your skin tone. Try the recommended shade for a clearer result.';
        else
          msg='Application looks sheer. Build up a little more colour within the outline and check again.';
        return{passed:false,message:msg};
      }
      const samplePts=sampleOverride||SAMPLE_IDX[step]||[];
      const ptSats=samplePts.map(i=>{const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);if(x<1||x>=W-1||y<1||y>=H-1)return null;let pr=0,pg=0,pb=0,pn=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;pr+=d[0];pg+=d[1];pb+=d[2];pn++;}return pn>0?rgbSat(pr/pn,pg/pn,pb/pn):null;}).filter(v=>v!==null);
      if(ptSats.length>2){const spread=Math.max(...ptSats)-Math.min(...ptSats);if(spread>0.20)return{passed:false,message:'Application is uneven. Some areas look bare or smudged. Blend more evenly right to the outline edges, then check again.'};}
      const recShade=STATE.shades?.[STATE.toneKey||'medium_warm']?.lips;
      const shadeHex=recShade?.hex;
      if(!shadeHex||shadeHex.length<7)return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
      const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
      const recBr=sr*0.299+sg*0.587+sb*0.114;
      const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
      const brightDiff=br-recBr;
      if(shadeDist<=55)return{passed:true,warning:false,message:'Lipstick applied and recognized. The shade matches your recommendation! Looks beautiful.'};
      let shadeMsg;
      if(brightDiff>35) shadeMsg='Too light. Your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
      else if(brightDiff<-35) shadeMsg='Too dark. Your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
      else shadeMsg="Wrong shade. The colour doesn't match the recommendation. Try the suggested shade for the best result.";
      return{passed:true,warning:true,message:shadeMsg};
    }

    if (step==='blush'){
      const skinRef=sampleLandmarks([10,9,151,107,336]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const satIncrease=rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b);
      const pinkShift=(r-b)-(sk.r-sk.b);
      const warmShift=(r-g)-(sk.r-sk.g);
      const absSat=rgbSat(r,g,b);
      // All conditions must hold - guards against lighting variation and natural flush
      const detected=br>35&&br<235&&dev>42&&satIncrease>0.10&&absSat>0.30&&(pinkShift>26||warmShift>26);
      if (!detected){
        let msg;
        if(dev<=42||absSat<=0.30) msg='No blush detected. Apply colour to the apples of your cheeks within the guide.';
        else if(satIncrease<=0.10) msg='Blush is too sheer. Build up a little more colour and blend within the outline.';
        else msg='Colour is not reading as blush. Try a pinker or rosier shade and blend upward along the guide.';
        return{passed:false,message:msg};
      }
      return{passed:true,message:goodMessages.blush};
    }

    if (step==='contour'){
      // Sample forehead as skin reference (not a hardcoded tone lookup)
      const skinRef=sampleLandmarks([10,9,151,107,336]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const skBr=sk.r*.299+sk.g*.587+sk.b*.114;
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const darkShift=skBr-br; // contour must darken the zone relative to forehead
      const satIncrease=rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b);
      // Requires the zone to be noticeably darker (shadow product) AND more saturated (brown tone)
      const passed=br>20&&br<230&&dev>50&&darkShift>18&&satIncrease>0.06;
      return{passed,message:passed?goodMessages.contour:tipMessages.contour};
    }

    if (step==='eyebrows'){
      const skinRef=sampleLandmarks([10,9,151]);
      const sk=skinRef??toneToRGB(STATE.toneKey||'medium_warm');
      const skBr=sk.r*.299+sk.g*.587+sk.b*.114;
      const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
      const darkShift=skBr-br; // eyebrows must darken the brow zone
      const passed=br>15&&br<230&&dev>48&&darkShift>22;
      return{passed,message:passed?goodMessages.eyebrows:tipMessages.eyebrows};
    }

    const sk=toneToRGB(STATE.toneKey||'medium_warm');
    const dev=Math.abs(r-sk.r)+Math.abs(g-sk.g)+Math.abs(b-sk.b);
    const passed=br>35&&br<235&&dev>48&&(rgbSat(r,g,b)-rgbSat(sk.r,sk.g,sk.b))>0.06;
    return{passed,message:passed?goodMessages[step]:tipMessages[step]};
  } catch(e){return{passed:true,message:goodMessages[step]};}
}

function rgbSat(r,g,b){const mx=Math.max(r,g,b)/255,mn=Math.min(r,g,b)/255;return mx===0?0:(mx-mn)/mx;}

// ── Robust region sampling ──
// Median colour and spread of every pixel in a polygon, with glare removed.
function sampleRegionRobust(frameData, W, H, outerPts, innerPts) {
  // Only work inside the region's bounding box (much faster).
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  outerPts.forEach(p=>{
    x0=Math.min(x0,p.x); x1=Math.max(x1,p.x);
    y0=Math.min(y0,p.y); y1=Math.max(y1,p.y);
  });
  if (!isFinite(x0)) return null;
  x0=Math.max(0,Math.floor(x0)-1); y0=Math.max(0,Math.floor(y0)-1);
  x1=Math.min(W,Math.ceil(x1)+1);  y1=Math.min(H,Math.ceil(y1)+1);
  const bw=x1-x0, bh=y1-y0;
  if (bw<4||bh<4) return null;

  const mc=document.createElement('canvas'); mc.width=bw; mc.height=bh;
  const mx=mc.getContext('2d',{willReadFrequently:true});
  const shift=pts=>pts.map(p=>({x:p.x-x0, y:p.y-y0}));
  mx.fillStyle='#fff';
  mx.beginPath(); softPolyPath(mx,shift(outerPts)); mx.fill();
  if (innerPts&&innerPts.length){
    mx.globalCompositeOperation='destination-out';
    mx.beginPath(); softPolyPath(mx,shift(innerPts)); mx.fill();
    mx.globalCompositeOperation='source-over';
  }
  const mask=mx.getImageData(0,0,bw,bh).data;

  const R=[],G=[],B=[],S=[];
  let glare=0, total=0;
  for (let y=0;y<bh;y++) for (let x=0;x<bw;x++){
    if (mask[(y*bw+x)*4+3]<190) continue;
    const o=((y+y0)*W+(x+x0))*4;
    total++;
    const r=frameData[o], g=frameData[o+1], b=frameData[o+2];
    const v=Math.max(r,g,b);
    const s=rgbSat(r,g,b);
    // Specular highlight: near-blown and washed out. Also drop near-black.
    if (v>238 || (v>205 && s<0.16)) { glare++; continue; }
    if (v<26) continue;
    R.push(r); G.push(g); B.push(b); S.push(s);
  }
  if (R.length<18) return null;

  const med=a=>{const c=[...a].sort((p,q)=>p-q);const m=c.length>>1;
                return c.length%2?c[m]:(c[m-1]+c[m])/2;};
  const q=(a,f)=>{const c=[...a].sort((p,q2)=>p-q2);
                  return c[Math.min(c.length-1,Math.max(0,Math.floor(f*(c.length-1))))];};

  return {
    r:med(R), g:med(G), b:med(B),
    sat:med(S),
    // Interquartile range of saturation: a robust unevenness measure that a
    // single bright spot cannot inflate.
    satIQR:q(S,0.75)-q(S,0.25),
    n:R.length,
    glareRatio: total? glare/total : 0,
  };
}

// Builds the lip polygons for a sub-step: 0 = top, 1 = bottom, 2 = whole mouth.
function lipRegionPts(lm, W, H, subStep) {
  if (subStep===0) return {outer:lmPts(lm,LIP_FILL_TOP,W,H), inner:null};
  if (subStep===1) return {outer:lmPts(lm,LIP_FILL_BOT,W,H), inner:null};
  return {outer:lmPts(lm,LIP_OUTER_LOOP,W,H), inner:lmPts(lm,LIP_INNER,W,H)};
}

// Blush coverage only sets the guide's shading, so it's measured 5 times a second.
let _blushCov={t:-1e9, v:0};
function getBlushCoverage(video, lm) {
  const now=performance.now();
  if (now-_blushCov.t<200) return _blushCov.v;
  _blushCov.t=now;
  _blushCov.v=measureBlushCoverage(video, lm);
  return _blushCov.v;
}
function measureBlushCoverage(video, lm) {
  try {
    // Small CPU canvas, read once.
    const vW=160, vH=120;
    const tctx=scratchCtx('blush', vW, vH); tctx.drawImage(video,0,0,vW,vH);
    const img=tctx.getImageData(0,0,vW,vH).data;
    const pts=[123,352,116,345,50,280,205,425];
    let sat=0,n=0;
    pts.forEach(i=>{const x=Math.round(lm[i].x*vW),y=Math.round(lm[i].y*vH);if(x>=1&&x<vW-1&&y>=1&&y<vH-1){const o=(y*vW+x)*4;sat+=rgbSat(img[o],img[o+1],img[o+2]);n++;}});
    return Math.min(1,Math.max(0,(n>0?sat/n:0)-0.09)/0.15);
  } catch(e){return 0;}
}

function toneToRGB(k){return{light_warm:{r:225,g:192,b:167},light_cool:{r:218,g:190,b:180},medium_warm:{r:190,g:150,b:120},medium_cool:{r:178,g:152,b:144},dark_warm:{r:133,g:100,b:70},dark_cool:{r:122,g:98,b:93}}[k]||{r:185,g:148,b:122};}

const goodMessages={lips:'Great lip color! Your lips look well-defined and beautiful.',blush:'Beautiful blush placement! Your cheeks are glowing naturally.',eyebrows:'Your brows look well-defined and perfectly framed!',contour:'Great contour! Your cheekbones look beautifully sculpted.'};
const tipMessages={lips:'Lipstick not detected yet. Make sure the area is well-lit, fill within the outline, and hold still for a moment.',blush:'Apply a little more blush to the apples of your cheeks and blend upward.',eyebrows:'Fill in the brows more with short, upward strokes then check again.',contour:'Build up the contour a little more along the cheekbone hollow and blend the edges.'};

function showFeedback(passed, message, quality) {
  const area=document.getElementById('feedback-area');
  area.style.display=''; area.className='feedback-area '+(passed?'good':'bad');
  document.getElementById('feedback-icon').textContent=passed?'✓':'✗';
  document.getElementById('feedback-msg').textContent=message;
  if (quality && quality.source!=='unavailable') showQualityReport(quality);
  else hideQualityReport();
  document.getElementById('btn-check').style.display='none';
  const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
  if (passed){
    const retryBtn=document.getElementById('btn-retry');
    retryBtn.style.display='none'; retryBtn.textContent='Retry'; retryBtn.onclick=retryStep;
    const isLast=STATE.currentStep>=STEPS.length-1;
    const nextBtn=document.getElementById('btn-next');
    nextBtn.textContent=isLast?'See Final Summary →':'Next Step →';
    nextBtn.style.display=''; nextBtn.onclick=isLast?showSummary:nextStep;
  } else {
    const nextBtn=document.getElementById('btn-next');
    nextBtn.style.display='none'; nextBtn.textContent='Next Step →'; nextBtn.onclick=nextStep;
    const retryBtn=document.getElementById('btn-retry');
    retryBtn.textContent='Retry'; retryBtn.onclick=retryStep; retryBtn.style.display='';
  }
}

function nextStep()  { STATE.currentStep++; if(STATE.currentStep>=STEPS.length)showSummary(); else renderStep(STATE.currentStep); }
function retryStep() { renderStep(STATE.currentStep); }
function skipStep()  {
  const step=STEPS[STATE.currentStep];
  if(step==='lips') STATE.lipSubStep=0;
  recordStepResult(step,{passed:false,message:'Skipped',quality:null,skipped:true});
  const skipBtn=document.getElementById('btn-skip'); if(skipBtn)skipBtn.style.display='none';
  STATE.currentStep++;
  if(STATE.currentStep>=STEPS.length)showSummary();
  else renderStep(STATE.currentStep);
}

// ── Summary ──
function showSummary() {
  stopStream();
  const tone=activeShades();
  const grid=document.getElementById('summary-grid'); grid.innerHTML='';
  let pass=0;
  STATE.stepResults.forEach(r=>{
    if(r.passed)pass++;
    const shade=tone?.[r.step];
    // Per-step quality line: smudging, unevenness, product amount.
    let qLine='';
    if (r.skipped)                       qLine='Step skipped';
    else if (r.quality?.source==='unavailable') qLine='Quality not assessed';
    else if (r.quality)                  qLine=r.quality.passed
                                              ? 'Blending, evenness and amount all good'
                                              : 'Needs work: '+r.quality.issues.join(', ');
    else                                 qLine='Placement not confirmed';

    const card=document.createElement('div'); card.className='summary-card';
    card.innerHTML=
      `<div class="summary-swatch" style="background:${shade?.hex||'#888'}"></div>`+
      `<div>`+
        `<div class="summary-step-name">${STEP_LABELS[r.step]}</div>`+
        `<div class="summary-result ${r.passed?'ok':'bad'}">${r.passed?'✓ Well done':'✗ Needs blending'}</div>`+
        `<div class="summary-quality">${qLine}</div>`+
      `</div>`;
    grid.appendChild(card);
  });
  const t=STATE.stepResults.length;
  const styleName=STATE.style?.name;
  const lookName=currentLookLabel();
  const foundNote=STATE.foundationConfirmed===false?' · foundation skipped':'';
  // Label the style so its name isn't read as a verdict on the makeup.
  document.getElementById('summary-sub').textContent=
    `${pass} of ${t} steps looked great`+(lookName?` · Look: ${lookName}`:'')
    +(styleName?` · Style: ${styleName}`:'')+foundNote;
  document.getElementById('summary-overall').textContent=pass===t?'Flawless finish! Your Soft and Natural look is complete.':pass>=t/2?'Great effort! A little more blending and it will be perfect.':'Keep practicing! The guide is here whenever you need it.';
  goTo('screen-summary');
}

// ── Utilities ──
function hexToRgba(hex,a){if(!hex||hex.length<7)return`rgba(200,120,120,${a})`;return`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;}

// trainer.html loads this file as a library and sets AIM_LIBRARY so the app doesn't start.
if (!window.AIM_LIBRARY)
  document.addEventListener('DOMContentLoaded',()=>{loadData();initParticles();initTMModels();setTimeout(prewarmMesh,800);});

// ── Virtual try-on ──
let _toMesh=null, _toStream=null, _toRaf=null, _toLastLm=null, _toStepOnly=null, _toOwnsStream=false;

// Pre-warms FaceMesh while the user reads the shades, so Try It On opens fast.
function prewarmTryOnMesh() {
  if (_toMesh) return;
  _toMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
  _toMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
  _toMesh.onResults(onTryOnResults);
  try {
    const b=document.createElement('canvas'); b.width=1; b.height=1;
    _toMesh.send({image:b}).catch(()=>{});
  } catch(e){}
}

function startStepTryOn() {
  // Tear down any running try-on session
  if(_toRaf)   { cancelAnimationFrame(_toRaf); _toRaf=null; }
  if(_toMesh)  { try{_toMesh.close();}catch(e){} _toMesh=null; }
  if(_toStream){ if(_toOwnsStream) _toStream.getTracks().forEach(t=>t.stop()); _toStream=null; }
  const _tv=document.getElementById('tryon-video');
  if(_tv) _tv.srcObject=null;
  _toLastLm=null;
  const _tl=document.getElementById('tryon-loading');
  if(_tl) _tl.style.display='flex';

  // Set the step-only filter BEFORE startTryOn creates the render loop
  const step  = STEPS[STATE.currentStep];
  _toStepOnly = step;

  const label     = STEP_LABELS[step] || step;
  const titleEl   = document.getElementById('tryon-modal-title');
  const captionEl = document.getElementById('tryon-modal-caption');
  if(titleEl)   titleEl.textContent   = `✦ ${label} Preview`;
  if(captionEl) captionEl.textContent = `${label.toUpperCase()} PREVIEW  ·  YOUR RECOMMENDED SHADE`;
  startTryOn();
}

function startTryOn() {
  const modal=document.getElementById('tryon-modal');
  modal.style.display='flex';
  const video=document.getElementById('tryon-video');
  const loading=document.getElementById('tryon-loading');
  if(_toStream) return; // already live

  // Reuse pre-warmed mesh if available (no lag); create fresh if not
  if(!_toMesh){
    _toMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    _toMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
    _toMesh.onResults(onTryOnResults);
  }

  // Share the step screen's camera and pause its tracking while the try-on runs.
  const live=STATE.stream && STATE.stream.getVideoTracks().some(t=>t.readyState==='live');
  _toOwnsStream=!live;
  if(live) STATE.meshPaused=true;
  (live ? Promise.resolve(STATE.stream) : openCamera())
  .then(stream=>{
    _toStream=stream;
    video.srcObject=stream;
    return video.play();
  })
  .then(()=>{
    if(loading) loading.style.display='none';
    const canvas=document.getElementById('tryon-canvas');
    let sending=false, lastT=-1;
    function loop(){
      if(!_toStream||!_toMesh){ _toRaf=null; return; }
      _toRaf=requestAnimationFrame(loop);
      if(!canvas||!video.videoWidth||video.readyState<2) return;
      const vW=video.videoWidth, vH=video.videoHeight;
      if(canvas.width!==vW) canvas.width=vW;
      if(canvas.height!==vH) canvas.height=vH;
      const ctx=canvas.getContext('2d');
      ctx.drawImage(video,0,0,vW,vH);
      if(_toLastLm) drawVirtualMakeup(ctx,_toLastLm,vW,vH);
      // Track every new camera frame, one at a time.
      if(!sending && video.currentTime!==lastT){
        sending=true; lastT=video.currentTime;
        _toMesh.send({image:video}).finally(()=>{ sending=false; });
      }
    }
    loop();
  })
  .catch(e=>{ console.error('Try-on camera error:',e); if(loading) loading.textContent='Camera unavailable'; });
}

function stopTryOn() {
  document.getElementById('tryon-modal').style.display='none';
  if(_toRaf){cancelAnimationFrame(_toRaf); _toRaf=null;}
  if(_toMesh){try{_toMesh.close();}catch(e){} _toMesh=null;}
  if(_toStream){ if(_toOwnsStream) _toStream.getTracks().forEach(t=>t.stop()); _toStream=null; }
  STATE.meshPaused=false;
  const video=document.getElementById('tryon-video');
  if(video) video.srcObject=null;
  _toLastLm=null;
  _toStepOnly=null;
  const titleEl   = document.getElementById('tryon-modal-title');
  const captionEl = document.getElementById('tryon-modal-caption');
  if(titleEl)   titleEl.textContent   = '✦ Try It On';
  if(captionEl) captionEl.innerHTML   = 'VIRTUAL TRY-ON &nbsp;·&nbsp; YOUR RECOMMENDED SHADES';
  const loading=document.getElementById('tryon-loading');
  if(loading) loading.style.display='flex';
}

function onTryOnResults(results) {
  _toLastLm=results.multiFaceLandmarks?.[0]||null;
}

// ── Virtual makeup renderer ──
// Draw order: contour, blush, brows, lips.
let _lipLayer=null;
function drawVirtualMakeup(ctx, lm, W, H, opts) {
  // opts.style    - render a specific variation (reference guide previews);
  //                 omit to use the one the user selected.
  // opts.stepOnly - render only this step (per-step try-on preview).
  const o = opts || {};
  const style = ('style' in o) ? o.style : STATE.style;
  const stepOnly = ('stepOnly' in o) ? o.stepOnly : _toStepOnly;

  // Same products as the Shades screen.
  const tone=selectBestSet(resolveShades(STATE.toneKey||'medium_warm', style));
  if(!tone) return;

  function rgb(hex){
    if(!hex||hex.length<7) return {r:200,g:120,b:120};
    return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
  }

  // Fade the whole filter out as the head turns or tilts, so it never lands in the
  // wrong place.
  const _clamp=v=>Math.min(1,Math.max(0,v));
  const _off = Math.abs((lm[1].x-lm[234].x)/((lm[454].x-lm[234].x)||0.001) - 0.5);
  const _roll = Math.abs(lm[234].y-lm[454].y)/((Math.abs(lm[234].x-lm[454].x))||0.001);
  const faceOn = _clamp(1 - Math.max(0,(_off-0.14))/0.20 - Math.max(0,(_roll-0.18))/0.25);
  if (faceOn<=0.05) return;   // too turned/tilted to place makeup, draw nothing

  // Complete-look strengths, then faded with pose. Every zone is always present.
  const styleMult = {};
  STEPS.forEach(s=>{ styleMult[s]=tryOnIntensity(s, style)*faceOn; });   // fade with pose
  // Per-step preview: the current step at full strength, the rest dimmed.
  const mult = stepOnly
    ? STEPS.reduce((m,s)=>{ m[s]= s===stepOnly ? styleMult[s] : styleMult[s]*STEP_PREVIEW_DIM; return m; }, {})
    : styleMult;

  const faceW=Math.abs(lm[234].x-lm[454].x)*W;
  const faceH=Math.abs(lm[10].y -lm[152].y)*H;
  const faceRef=Math.max(faceW,faceH*0.80);
  const nosePx=lm[1].x*W, nosePy=lm[1].y*H;

  // Scale each side by how face-on it is, so a turned cheek doesn't get a dark patch.
  const clamp01=v=>Math.min(1,Math.max(0,v));
  const noseRatio=(lm[1].x-lm[234].x)/((lm[454].x-lm[234].x)||0.001);
  const visL=clamp01((noseRatio-0.12)/0.22);   // 234 side
  const visR=clamp01((0.88-noseRatio)/0.22);   // 454 side

  // ── Contour: cheek hollows, jaw sides, nose sides ──
  if(tone.contour?.hex && mult.contour>0.05){
    const {r,g,b}=rgb(tone.contour.hex);
    const a=mult.contour;
    ctx.save();
    ctx.globalCompositeOperation='source-over';

    // Zone 1 - Cheek hollows: soft circular gradient blobs (per-side vis)
    [[234,visL],[454,visR]].forEach(([temple,vis])=>{
      if (vis<=0.02) return;
      const av=a*vis;
      const tx=lm[temple].x*W, ty=lm[temple].y*H;
      const cx=nosePx+0.58*(tx-nosePx);
      const cy=nosePy+0.60*(ty-nosePy)+faceRef*0.04;
      const gradR=faceRef*0.28;
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,gradR);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.80*av).toFixed(3)})`);
      grad.addColorStop(0.28, `rgba(${r},${g},${b},${(0.62*av).toFixed(3)})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${(0.30*av).toFixed(3)})`);
      grad.addColorStop(0.82, `rgba(${r},${g},${b},${(0.08*av).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.arc(cx,cy,gradR,0,Math.PI*2); ctx.fill();
    });

    // Zone 2 - Jaw sides: diffuse oval blobs (per-side vis)
    [[[58,172,136,150,149],visL],[[288,397,365,379,378],visR]].forEach(([idxArr,vis])=>{
      if (vis<=0.02) return;
      const av=a*vis;
      const pts=idxArr.map(i=>({x:lm[i].x*W,y:lm[i].y*H}));
      const cx=pts.reduce((s,p)=>s+p.x,0)/pts.length;
      const cy=pts.reduce((s,p)=>s+p.y,0)/pts.length;
      const gradR=faceW*0.17;
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,gradR);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.38*av).toFixed(3)})`);
      grad.addColorStop(0.50, `rgba(${r},${g},${b},${(0.18*av).toFixed(3)})`);
      grad.addColorStop(0.80, `rgba(${r},${g},${b},${(0.05*av).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.ellipse(cx,cy,faceW*0.15,faceRef*0.075,0,0,Math.PI*2); ctx.fill();
    });

    // Zone 3 - Nose sides: slim shadow strips along the nose bridge
    const bridgePt={x:lm[6].x*W, y:lm[6].y*H};
    const tipPt   ={x:lm[4].x*W, y:lm[4].y*H};
    const alarL   ={x:lm[49].x*W,y:lm[49].y*H};
    const alarR   ={x:lm[279].x*W,y:lm[279].y*H};
    const nW=Math.abs(alarR.x-alarL.x);
    const nH=Math.abs(tipPt.y-bridgePt.y);
    const midY=(bridgePt.y+tipPt.y)/2;
    [{cx:alarL.x-nW*0.07,cy:midY},{cx:alarR.x+nW*0.07,cy:midY}].forEach(({cx,cy})=>{
      const grad=ctx.createRadialGradient(cx,cy,0, cx,cy,nW*0.14);
      grad.addColorStop(0,    `rgba(${r},${g},${b},${(0.46*a).toFixed(3)})`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},${(0.18*a).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.beginPath(); ctx.ellipse(cx,cy,nW*0.11,nH*0.52,0,0,Math.PI*2); ctx.fill();
    });

    ctx.restore();
  }

  // ── Blush: tilted ellipse on the cheekbone, clipped to the face outline ──
  if(tone.blush?.hex && mult.blush>0.05){
    const {r,g,b}=rgb(tone.blush.hex);
    const baseAlpha=mult.blush;
    ctx.save();
    ctx.globalCompositeOperation='source-over';
    // MediaPipe FACE_OVAL - one clockwise loop around the visible face.
    const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,
                       365,379,378,400,377,152,148,176,149,150,136,172,58,
                       132,93,234,127,162,21,54,103,67,109];
    ctx.beginPath();
    FACE_OVAL.forEach((i,k)=>{
      const x=lm[i].x*W, y=lm[i].y*H;
      if (k===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.closePath();
    ctx.clip();
    [[234,visL],[454,visR]].forEach(([temple,vis])=>{
      if (vis<=0.02) return;
      const av=baseAlpha*vis;
      const tx=lm[temple].x*W, ty=lm[temple].y*H;
      const angle=Math.atan2(ty-nosePy, tx-nosePx);
      const cx=nosePx+0.62*(tx-nosePx);
      const cy=nosePy+0.62*(ty-nosePy)+faceRef*0.04;
      const rMaj=faceRef*0.22;
      const rMin=faceRef*0.13;
      ctx.save();
      ctx.translate(cx,cy); ctx.rotate(angle);
      const grad=ctx.createRadialGradient(0,0,0, 0,0,rMaj);
      grad.addColorStop(0,   `rgba(${r},${g},${b},${(0.52*av).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(${r},${g},${b},${(0.26*av).toFixed(3)})`);
      grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.fillStyle=grad;
      ctx.scale(1, rMin/rMaj);
      ctx.beginPath(); ctx.arc(0,0,rMaj,0,Math.PI*2); ctx.fill();
      ctx.restore();
    });
    ctx.restore();
  }

  // ── Eyebrows: multiply fill - darkens existing hair naturally ──
  if(tone.eyebrows?.hex && mult.eyebrows>0.05){
    const {r,g,b}=rgb(tone.eyebrows.hex);
    ctx.save();
    ctx.globalCompositeOperation='multiply';
    ctx.filter='blur(1.6px)';
    ctx.globalAlpha=0.88*mult.eyebrows;
    ctx.fillStyle=`rgb(${r},${g},${b})`;
    [[BROW_LEFT_TOP,BROW_LEFT_BOTTOM],[BROW_RIGHT_TOP,BROW_RIGHT_BOTTOM]].forEach(([top,bot])=>{
      ctx.beginPath();
      ctx.moveTo(lm[top[0]].x*W,lm[top[0]].y*H);
      top.slice(1).forEach(i=>ctx.lineTo(lm[i].x*W,lm[i].y*H));
      [...bot].reverse().forEach(i=>ctx.lineTo(lm[i].x*W,lm[i].y*H));
      ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  }

  // ── Lips: full outer shape with inner punch-out ────────────────
  if(tone.lips?.hex && mult.lips>0.05){
    const {r,g,b}=rgb(tone.lips.hex);
    // One lip layer reused every frame.
    const lc=_lipLayer||(_lipLayer=document.createElement('canvas'));
    if (lc.width!==W || lc.height!==H){ lc.width=W; lc.height=H; }
    const lx=lc.getContext('2d');
    lx.globalCompositeOperation='source-over'; lx.globalAlpha=1; lx.filter='none';
    lx.clearRect(0,0,W,H);
    lx.filter='blur(1px)';
    lx.fillStyle=`rgb(${r},${g},${b})`;
    // Outer lip pulled 4% inward so colour stays inside the lip line.
    const outerRaw=lmPts(lm,LIP_OUTER_LOOP,W,H);
    const ocx=outerRaw.reduce((s,p)=>s+p.x,0)/outerRaw.length;
    const ocy=outerRaw.reduce((s,p)=>s+p.y,0)/outerRaw.length;
    const outerPts=outerRaw.map(p=>({x:ocx+(p.x-ocx)*0.96, y:ocy+(p.y-ocy)*0.96}));
    lx.beginPath(); softPolyPath(lx,outerPts); lx.fill();

    // Inner cut-out pulled 18% inward so it only removes the mouth opening.
    const innerPts=lmPts(lm,LIP_INNER,W,H);
    const icx=innerPts.reduce((s,p)=>s+p.x,0)/innerPts.length;
    const icy=innerPts.reduce((s,p)=>s+p.y,0)/innerPts.length;
    const innerShrunk=innerPts.map(p=>({x:icx+(p.x-icx)*0.82, y:icy+(p.y-icy)*0.82}));
    lx.globalCompositeOperation='destination-out';
    lx.filter='blur(0.8px)';
    lx.beginPath(); softPolyPath(lx,innerShrunk); lx.fill();

    // Soft sheen
    lx.globalCompositeOperation='source-over';
    lx.filter='blur(2.5px)';
    lx.globalAlpha=0.18;
    lx.fillStyle='rgba(255,255,255,1)';
    const shinePts=lmPts(lm,[37,0,267,82,13,312],W,H);
    lx.beginPath(); softPolyPath(lx,shinePts); lx.fill();

    // Two passes: a base tint so every part is coloured, then multiply for depth.
    ctx.save();
    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=0.42*mult.lips;
    ctx.drawImage(lc,0,0);
    ctx.globalCompositeOperation='multiply';
    ctx.globalAlpha=0.78*mult.lips;
    ctx.drawImage(lc,0,0);
    ctx.restore();
  }
}
