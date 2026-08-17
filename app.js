const STATE = {
  focal:null, toneKey:null, shades:null, focalData:null,
  currentStep:0, stepResults:[], faceMesh:null, camera:null,
  stream:null, lastLandmarks:null, checkPending:false,
  lipSubStep:0,
  smoothedLm:null,
  blushLm:null,
  blushFrameCount:0,
  detectFrame:0,
  accDismissedAt:0,
  detectLm:null,      // smoothed landmarks for the detection overlay
  accActive:[],       // accessories currently detected (reminder banner only)
  accPosStreak:0,     // consecutive positive accessory reads (hysteresis)
  accNegStreak:0,     // consecutive clear reads (hysteresis)
  accDismissedForSession:false, // user clicked ✕ on the reminder - stay quiet
  readyStreak:0,      // consecutive frames the user has held a valid pose
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
  { label:'Final Check', badge:'Step 3 of 3', instruction:'Both lips filled - hold still while the camera checks your overall application.' },
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

// ─────────────────────────────────────────
//  CANVAS / OVERLAY SYNC
// ─────────────────────────────────────────
function syncOverlay(canvasEl, videoEl) {
  const rect = videoEl.getBoundingClientRect();
  const W = Math.round(rect.width)  || videoEl.videoWidth  || 640;
  const H = Math.round(rect.height) || videoEl.videoHeight || 480;
  if (canvasEl.width  !== W) canvasEl.width  = W;
  if (canvasEl.height !== H) canvasEl.height = H;
  const vW = videoEl.videoWidth  || 640;
  const vH = videoEl.videoHeight || 480;
  const scale = Math.max(W/vW, H/vH);
  const effW = vW*scale, effH = vH*scale;
  const ox = (effW-W)/2, oy = (effH-H)/2;
  return { W, H, effW, effH, ox, oy };
}

// ─────────────────────────────────────────
//  PATH HELPERS
// ─────────────────────────────────────────
function polyPath(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}
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

// ─────────────────────────────────────────
//  HEAD-TURN VISIBILITY
//  MediaPipe tracks the face through a full
//  profile, so guides should never vanish -
//  they only fade as the head turns, since
//  landmark accuracy drops with the angle.
//  Returns an opacity multiplier in [0.35,1].
// ─────────────────────────────────────────
// How far off-axis the head is: 0 = dead-on, ~0.5 = full profile.
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

// Stricter gates than the display fade above. A reference PHOTO and an
// accessory decision both need a genuinely straight-on face.
const TURN_OK_CAPTURE   = 0.15;   // realistic for a hand-held / desk webcam
const TURN_OK_ACCESSORY = 0.12;   // accessory check needs a near-frontal face

// ─────────────────────────────────────────
//  FACE SHAPE DETECTION
//  Classifies from landmark proportions.
//  Returns: 'oval'|'round'|'oblong'|
//           'heart'|'diamond'|'square'
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  DATA LOADING
// ─────────────────────────────────────────
async function loadData() {
  // Each JSON database is fetched independently so that one missing or malformed
  // file cannot take down the rest of the application (ISO/IEC 25010 - Updatability).
  const grab = (url) => fetch(url).then(r=>{
    if(!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }).catch(e=>{ console.error('Data load error:', e.message); return null; });

  const [s,f,v,fd] = await Promise.all([
    grab('data/shades.json'),
    grab('data/focal-points.json'),
    grab('data/style-variations.json'),
    grab('data/foundations.json'),
  ]);
  STATE.shades=s; STATE.focalData=f; STATE.styleData=v; STATE.foundationData=fd;
  console.log('Data loaded.', {
    shades:!!s, focalPoints:!!f, styleVariations:!!v, foundations:!!fd,
  });
}

// ─────────────────────────────────────────
//  STYLE VARIATION RESOLUTION
//  A variation never invents a colour - it
//  re-points each step at an entry that
//  already exists in the local shade
//  library, relative to the detected tone.
// ─────────────────────────────────────────
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

// The shade set every other module should read from: detected tone
// after the selected style variation has been applied.
function activeShades() {
  return resolveShades(STATE.toneKey||'medium_warm', STATE.style);
}

// Per-step rendering strength for the selected variation. Falls back to the
// focal-point weighting when no variation has been chosen yet.
function styleIntensity(step, style) {
  const s = style===undefined ? STATE.style : style;
  if (s?.intensity && typeof s.intensity[step]==='number') {
    return s.intensity[step];
  }
  const FALLBACK = {
    lips:     { lips:1.00, blush:0.38, eyebrows:0.50, contour:0.55 },
    eyebrows: { lips:0.38, blush:0.32, eyebrows:1.00, contour:0.60 },
    cheeks:   { lips:0.38, blush:1.00, eyebrows:0.50, contour:0.55 },
    contour:  { lips:0.38, blush:0.32, eyebrows:0.50, contour:1.00 },
  };
  return (FALLBACK[STATE.focal]||FALLBACK.lips)[step] ?? 0.5;
}

// Coverage level (1=sheer, 2=balanced, 3=full) for a step under the chosen
// variation. This is the single source of truth used by the variation cards,
// the step instructions and the amount check, so they always agree.
function coverageLevel(step) {
  const c=styleIntensity(step);
  return c<0.7 ? 1 : c<0.92 ? 2 : 3;
}

// A short sentence appended to the step instruction telling the user how much
// of the recommended product to apply for their selected variation.
function coverageNote(step) {
  if (!STATE.style) return '';
  const words=['', 'sheer, light coverage', 'medium, buildable coverage', 'full, built-up coverage'];
  return `  Aim for ${words[coverageLevel(step)]} (${STATE.style.name}).`;
}

// ─────────────────────────────────────────
//  SCREEN NAVIGATION
// ─────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  if (id==='screen-camera') {
    STATE.detectFrame=0;
    STATE.accDismissedAt=0;
    STATE.accActive=[];
    STATE.accPosStreak=0;
    STATE.accNegStreak=0;
    STATE.accDismissedForSession=false;
    STATE.readyStreak=0;
    STATE.countdownStart=0;
    STATE.detectLm=null;
    // "Retake" must genuinely re-analyse: clear the tone, the captured still
    // and the detect button, otherwise the screen reopens already-complete.
    STATE.toneKey=null;
    STATE.captureCanvas=null;
    STATE.captureLm=null;
    STATE.captureArmed=false;
    STATE.baseline=null;
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

  // The style and foundation screens work from the captured still, not the
  // live feed, so the camera stays off until the AR guide actually begins.
  if (id==='screen-style')      { stopTryOn(); renderStyleScreen(); }
  if (id==='screen-foundation') { stopTryOn(); renderFoundationScreen(); }

  // Returning to the focal screen after analysis: restore the current choice
  // and wire the button to jump straight back to the (new) recommendations.
  if (id==='screen-focal' && STATE.focal){
    const card=document.querySelector(`.focal-card[data-focal="${STATE.focal}"]`);
    if (card) selectFocal(STATE.focal, card);
  }
}

// ─────────────────────────────────────────
//  PARTICLES
// ─────────────────────────────────────────
function initParticles() {
  const canvas=document.getElementById('particles-bg'), ctx=canvas.getContext('2d');
  let W,H,P=[];
  function resize(){W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight;}
  resize(); window.addEventListener('resize',resize);
  for (let i=0;i<60;i++) P.push({x:Math.random()*window.innerWidth,y:Math.random()*window.innerHeight,r:Math.random()*1.4+0.3,dx:(Math.random()-.5)*.4,dy:(Math.random()-.5)*.4,o:Math.random()*.5+.1});
  (function draw(){
    ctx.clearRect(0,0,W,H);
    P.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(201,149,106,${p.o})`;ctx.fill();p.x+=p.dx;p.y+=p.dy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;});
    requestAnimationFrame(draw);
  })();
}

// ─────────────────────────────────────────
//  FOCAL SELECTION
// ─────────────────────────────────────────
function selectFocal(focal, el) {
  STATE.focal=focal;
  // Changing the focal point clears the previously chosen variation so the
  // Shades / Variation screens rebuild fresh for the new focal.
  STATE.style=null;
  document.querySelectorAll('.focal-card').forEach(c=>c.classList.remove('selected'));
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

// ─────────────────────────────────────────
//  CAMERA SETUP
// ─────────────────────────────────────────
async function initCamera() {
  const video=document.getElementById('video');
  const titleEl=document.getElementById('cam-title');
  const subEl=document.getElementById('cam-sub');
  titleEl.textContent='Requesting camera...';
  subEl.textContent='Allow camera permission when prompted';
  try {
    STATE.stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
    video.srcObject=STATE.stream;
    video.onloadedmetadata=()=>{
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
}

// ─────────────────────────────────────────
//  LIGHTING CHECK
// ─────────────────────────────────────────
function startLightingCheck() {
  const video=document.getElementById('video');
  const warn=document.getElementById('light-warn');
  const tmp=document.createElement('canvas'); tmp.width=64; tmp.height=48;
  const tctx=tmp.getContext('2d');
  setInterval(()=>{
    if (!STATE.stream) return;
    try {
      tctx.drawImage(video,0,0,64,48);
      const d=tctx.getImageData(0,0,64,48).data;
      let br=0,rS=0,gS=0,bS=0;
      const N=d.length/4;
      for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
      const avgBr=br/N,rA=rS/N,gA=gS/N,bA=bS/N;
      const cast=Math.max(rA,gA,bA)-(rA+gA+bA)/3;
      let msg='';
      if      (avgBr<60)  msg='⚠ Too dark - move to a brighter area for accurate colour detection';
      else if (avgBr>205) msg='⚠ Too bright / overexposed - step back or reduce glare';
      else if (cast>30)   msg='⚠ Strong colour cast detected - use neutral white lighting';
      if (msg){warn.textContent=msg;warn.classList.remove('hide');}
      else    {warn.textContent='';warn.classList.add('hide');}
    } catch(e){}
  },1200);
}

function checkStepLighting(video) {
  try {
    let warn=document.getElementById('step-light-warn');
    if (!warn){
      warn=document.createElement('div'); warn.id='step-light-warn';
      Object.assign(warn.style,{position:'absolute',top:'8px',left:'50%',transform:'translateX(-50%)',background:'rgba(180,60,0,0.82)',color:'#fff',fontSize:'12px',padding:'5px 14px',borderRadius:'20px',zIndex:'99',pointerEvents:'none',textAlign:'center',maxWidth:'90%',display:'none',whiteSpace:'nowrap'});
      const wrap=document.getElementById('step-overlay')?.parentElement||document.getElementById('step-video')?.parentElement||document.body;
      wrap.style.position=wrap.style.position||'relative';
      wrap.appendChild(warn);
    }
    const tmp=document.createElement('canvas'); tmp.width=32; tmp.height=24;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,32,24);
    const d=tctx.getImageData(0,0,32,24).data;
    let br=0,rS=0,gS=0,bS=0; const N=d.length/4;
    for (let i=0;i<d.length;i+=4){br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;rS+=d[i];gS+=d[i+1];bS+=d[i+2];}
    const avgBr=br/N, cast=Math.max(rS/N,gS/N,bS/N)-(rS/N+gS/N+bS/N)/3;
    let msg='';
    if      (avgBr<60)  msg='⚠ Too dark - better lighting helps the AI detect your makeup accurately';
    else if (avgBr>205) msg='⚠ Too bright - reduce glare so colours are detected correctly';
    else if (cast>30)   msg='⚠ Colour cast - switch to neutral white light for best results';
    warn.textContent=msg; warn.style.display=msg?'block':'none';
  } catch(e){}
}

// ═════════════════════════════════════════
//  TEACHABLE-MACHINE CLASSIFIER LOADER
//
//  A drop-in slot for Google Teachable
//  Machine image models (which are MobileNet
//  under the hood - exactly what Objective 9
//  specifies). Train in the browser, export
//  "TensorFlow.js", drop the files into the
//  matching models/… folder, and the app
//  uses the model automatically. If the
//  folder is empty, the existing pixel
//  heuristic runs instead - nothing breaks.
//
//  See models/HOW-TO-TRAIN.md for the full
//  workflow and the exact class-label names
//  each slot expects.
// ═════════════════════════════════════════
const TM_MODELS = {
  // slot name → { url, input size, and the label that means "positive" }
  glasses:   { url:'models/glasses/model.json',   input:224, positive:'glasses' },
  occlusion: { url:'models/occlusion/model.json', input:224, positive:'covered' },
};
const _tm = {};   // name → { state:'idle|loading|ready|absent', model, labels }

async function loadTMModel(name) {
  const cfg=TM_MODELS[name];
  if (!cfg) return 'absent';
  const slot=_tm[name] || (_tm[name]={state:'idle', model:null, labels:null});
  if (slot.state!=='idle') return slot.state;
  if (typeof tf==='undefined'){ slot.state='absent'; return slot.state; }
  slot.state='loading';
  try {
    slot.model=await tf.loadLayersModel(cfg.url);
    tf.tidy(()=>slot.model.predict(tf.zeros([1,cfg.input,cfg.input,3])));  // warm-up
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
    console.warn(`[tm:${name}] no model at ${cfg.url} - using heuristic fallback. (${e.message})`);
  }
  return slot.state;
}

// Kick off loading for every declared model (called once at startup).
function initTMModels(){ Object.keys(TM_MODELS).forEach(loadTMModel); }

// Runs a loaded classifier on a face-region crop. Returns the positive-class
// probability in [0,1], or null when no model is installed for this slot.
function classifyTM(name, image, lm) {
  const cfg=TM_MODELS[name];
  const slot=_tm[name];
  if (!cfg || !slot || slot.state!=='ready' || !slot.model) return null;
  try {
    const vW=image.width||640, vH=image.height||480;
    // Crop a padded box around the whole face so the classifier sees context.
    let x0=1,y0=1,x1=0,y1=0;
    [10,152,234,454].forEach(i=>{ const p=lm[i]; if(!p) return;
      x0=Math.min(x0,p.x); y0=Math.min(y0,p.y); x1=Math.max(x1,p.x); y1=Math.max(y1,p.y); });
    const pad=0.18;
    const bx=Math.max(0,(x0-pad)*vW), by=Math.max(0,(y0-pad)*vH);
    const bw=Math.min(vW,(x1+pad)*vW)-bx, bh=Math.min(vH,(y1+pad)*vH)-by;
    if (bw<16||bh<16) return null;
    const crop=document.createElement('canvas');
    crop.width=cfg.input; crop.height=cfg.input;
    crop.getContext('2d').drawImage(image, bx,by,bw,bh, 0,0,cfg.input,cfg.input);
    const probs=tf.tidy(()=>{
      const t=tf.browser.fromPixels(crop).toFloat().div(127.5).sub(1).expandDims(0);
      const out=slot.model.predict(t);
      return out.dataSync();
    });
    // Map the positive label to its index via metadata; default to index 0.
    let idx=0;
    if (slot.labels){
      const i=slot.labels.findIndex(l=>String(l).toLowerCase().includes(cfg.positive));
      if (i>=0) idx=i;
    }
    return probs[idx] ?? null;
  } catch(e){ console.warn(`[tm:${name}] inference failed:`, e.message); return null; }
}

// ─────────────────────────────────────────
//  ACCESSORIES DETECTION
//  Model-first: a trained Teachable Machine
//  glasses classifier is used when present;
//  otherwise the pixel heuristic below runs.
//  Mask  → mouth area desaturated vs forehead.
// ─────────────────────────────────────────
function checkAccessories(image, lm) {
  try {
    const vW=image.width||640, vH=image.height||480;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const tctx=tmp.getContext('2d',{willReadFrequently:true}); tctx.drawImage(image,0,0,vW,vH);
    // Patch average around each landmark - a single pixel is far too noisy to
    // decide on. Radius scales with face size so it works at any distance.
    const rad=Math.max(2, Math.round(Math.abs(lm[454].x-lm[234].x)*vW*0.012));
    function px(idxs){
      let r=0,g=0,b=0,n=0;
      idxs.forEach(i=>{
        if(i>=lm.length) return;
        const cx=Math.round(lm[i].x*vW), cy=Math.round(lm[i].y*vH);
        const x0=Math.max(0,cx-rad), y0=Math.max(0,cy-rad);
        const w=Math.min(vW,cx+rad+1)-x0, h=Math.min(vH,cy+rad+1)-y0;
        if(w<=0||h<=0) return;
        const d=tctx.getImageData(x0,y0,w,h).data;
        for(let p=0;p<d.length;p+=4){r+=d[p];g+=d[p+1];b+=d[p+2];n++;}
      });
      return n>0?{r:r/n,g:g/n,b:b/n,br:function(){return this.r*.299+this.g*.587+this.b*.114;}}:null;
    }
    const fh=px([10,9,151,107,336]); if(!fh) return [];
    const fhBr=fh.br();
    const found=[];

    // ── Glasses: trained model takes precedence when installed ──
    const glassesProb=classifyTM('glasses', image, lm);
    if (glassesProb!=null){
      if (glassesProb>=0.6) found.push('glasses');
      // Model handles glasses; fall through only for the mask heuristic below.
    } else {
      // ── Pixel-heuristic fallback ──
      // Only meaningful on a reasonably frontal face. When the head turns, the
      // temple sample points slide onto HAIR - dark hair then reads as several
      // "dark frame" signals at once, which caused earlier false alarms.
      if (faceTurnOffset(lm) <= TURN_OK_ACCESSORY)
        runGlassesHeuristic(px, fhBr, found);
    }

    // NOTE: face masks are handled by occlusionCheck (colour-balance based,
    // lighting-tolerant) which reliably blocks the Capture button. The old
    // pixel mask heuristic here compared the LIPS against the forehead, so
    // naturally red lips or a shadowed lower face read as a "mask" - a false
    // positive that wrongly told users to remove a mask they weren't wearing.
    // It has been removed; only glasses (which occlusion cannot see) remain.
    return found;
  } catch(e){return [];}
}

// Pixel-heuristic glasses scoring. This is the fallback whenever no trained
// glasses model is installed. Since the policy is HARD-BLOCK on any detection,
// this tuning favours recall over precision within the constraints below.
//
// Tuned specifically for the failure case the old detector missed:
// clear-lens metal-rimmed frames. The old detector required the lens brightness
// anomaly to fire, and that cue is silent on clear lenses - so a whole class
// of glasses was invisible to it. This version drops the lens dependency and
// leans on signals that survive thin metal / clear lens / hair-covered temples.
function runGlassesHeuristic(px, fhBr, found) {
  // ── Clean baselines ──────────────────────────────────────────────
  const cheek = px([116,345,50,280]);
  const ckBr  = cheek ? cheek.br() : fhBr;
  // Under-eye pouches only. The old sampler mixed in the temples (234, 454)
  // which are hair on many people - that biased the baseline dark and hid
  // the very rim signals below.
  const underEye = px([145,144,163,374,373,390]);
  const ueBr = underEye ? underEye.br() : ckBr;
  // Forehead skin ONLY (no brow indices). This becomes the "clean skin at
  // eye-line height" reference for the nose-bridge break signal.
  const forehead = px([10,9,151,108,337]);
  const fhCleanBr = forehead ? forehead.br() : fhBr;

  let score = 0;

  // ── Signal A: Nose-bridge break ─────────────────────────────────
  // Glasses hardware between the two lenses creates a darker strip than
  // the forehead skin. Thresholds tightened: on a bare face the natural
  // brow shadow can produce a small (<18) diff that used to fire the weak
  // tier and false-positive; only a genuine hardware-scale diff scores now.
  const bridgeBand = px([168, 6, 197, 193, 417]);
  if (bridgeBand){
    const diff = fhCleanBr - bridgeBand.br();
    if      (diff > 26) score += 2;    // strong: obvious hardware
    else if (diff > 16) score += 1;    // weak: possible thin frame
  }

  // ── Signal B: Lower rim on the cheek ────────────────────────────
  // Lower lens edge sits on bare cheek skin. Thresholds tightened so
  // natural under-eye shadow (which is asymmetric on many faces) doesn't
  // pass both sides at once.
  const lLowerRim = px([119, 118, 117, 111]);
  const rLowerRim = px([348, 347, 346, 340]);
  if (lLowerRim && rLowerRim){
    const dL = ckBr - lLowerRim.br();
    const dR = ckBr - rLowerRim.br();
    if      (dL > 16 && dR > 16) score += 2;
    else if (dL > 10 && dR > 10) score += 1;
  }

  // ── Signal C: Lens reflectivity ─────────────────────────────────
  // Glass catches ambient light differently than skin. Tightened: needs
  // BOTH a bright reflection AND consistent off-baseline, so a single
  // bright spot from a window on bare skin doesn't count.
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

  // ── Trigger ─────────────────────────────────────────────────────
  // Threshold 3 (was 2). This means at minimum:
  //   * one signal at strong tier (2) + one at any tier (1), OR
  //   * three weak-tier signals simultaneously.
  // A bare face's natural darkness might trigger one weak signal; hitting
  // two independent, symmetric ones at strong tiers is very rare without
  // an actual frame present. That's the sweet spot between missing thin
  // metal (the old failure mode) and flagging a bare face (the current one).
  if (score >= 3) found.push('glasses');
}

function showGlassesWarn(msg) {
  // Session-dismiss is intentionally NOT respected any more. Glasses hard-block
  // Capture and the user should not be able to silence a blocking condition -
  // the banner must stay visible until the glasses are actually removed.
  const el=document.getElementById('glasses-warn');
  if(!el) return;
  const sp=el.querySelector('span');
  if(sp&&msg) sp.textContent=msg;
  el.classList.remove('hide');
}
function hideGlassesWarn(userDismissed) {
  const el=document.getElementById('glasses-warn');
  if(el) el.classList.add('hide');
  // Dismiss button is retained for the DOM but does not silence future warnings
  // (the detection loop re-shows it as long as glasses are present).
}

// ─────────────────────────────────────────
//  MEDIAPIPE - DETECTION SCREEN
// ─────────────────────────────────────────
function startDetection() {
  document.getElementById('cam-title').textContent='Scanning your face...';
  document.getElementById('cam-sub').textContent='Keep still and look straight ahead';
  // Hand over to the manual Capture button - the system never photographs
  // the user on its own timing.
  const d=document.getElementById('btn-detect');
  if (d) d.style.display='none';
  const cap=document.getElementById('btn-capture');
  if (cap){ cap.style.display=''; cap.disabled=true; cap.textContent='Capture Photo'; }
  const st=document.getElementById('capture-status');
  if (st){ st.style.display=''; st.className='capture-status'; st.textContent='Looking for your face…'; }
  const video=document.getElementById('video');
  if (!STATE.faceMesh){
    STATE.faceMesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    STATE.faceMesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
  }
  STATE.faceMesh.onResults(onDetectResults);
  STATE.camera=new Camera(video,{onFrame:async()=>{if(STATE.faceMesh)await STATE.faceMesh.send({image:video});},width:640,height:480});
  STATE.camera.start();
}

function onDetectResults(results) {
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
    // Smooth the detection overlay too - it was drawing raw landmarks, which
    // jitter frame to frame and shake noticeably when the head turns.
    const dlm=smoothDetectLm(lm);

    ctx.save(); ctx.translate(-ox,-oy);
    // Landmarks and guides track the face at every angle and are never hidden.
    // Past a comfortable frontal range they only dim, because landmark depth
    // error grows as the head turns - they still follow the face.
    ctx.globalAlpha = turnVisibility(lm);
    ctx.fillStyle='rgba(201,149,106,0.22)';
    dlm.forEach(pt=>{ctx.beginPath();ctx.arc(pt.x*effW,pt.y*effH,1.4,0,Math.PI*2);ctx.fill();});
    drawLips   (ctx,dlm,effW,effH,'rgba(220,130,120,0.78)','rgba(220,130,120,0.18)',2,false);
    drawBrows  (ctx,dlm,effW,effH,'rgba(180,130,80,0.7)','rgba(160,110,60,0.15)',3);
    drawBlush  (ctx,dlm,effW,effH,'rgba(230,150,140,0.55)','rgba(230,150,140,0.10)',2);
    drawContour(ctx,dlm,effW,effH,'rgba(190,140,80,0.6)','rgba(170,120,60,0.22)',2.5);
    ctx.restore();
    // Glasses / accessory check - BLOCKING. STATE.accActive drives the hard
    // gate in assessReadiness. Polled every 4 frames (~0.25s at 30fps) rather
    // than every 10, so a real pair of glasses shows the block within about
    // half a second of the face becoming frontal. The pos streak was 2 (=1.5s
    // latency after the throttle change); dropped to 1 so a single confident
    // heuristic hit locks the block on. Neg streak stayed at 2 so a transient
    // one-frame flicker doesn't clear the block.
    STATE.detectFrame=(STATE.detectFrame||0)+1;
    if(STATE.detectFrame%4===1){
      const acc = (faceTurnOffset(lm) <= TURN_OK_ACCESSORY)
        ? checkAccessories(results.image, lm) : (STATE.accActive||[]);
      // Two-frame streaks in both directions so a single noisy frame can't
      // set OR clear the state. Poll interval is 4 frames (~130ms), so
      // detection latency and clearance latency are both ~260ms — fast
      // enough to feel responsive, slow enough to filter one-frame noise.
      // Single-frame confirmation (pos>=1) was tried last round and was
      // exactly what caused the current false-positive complaint.
      if(acc.length>0){
        STATE.accPosStreak=(STATE.accPosStreak||0)+1; STATE.accNegStreak=0;
        if(STATE.accPosStreak>=2) STATE.accActive=acc;
      } else {
        STATE.accNegStreak=(STATE.accNegStreak||0)+1; STATE.accPosStreak=0;
        if(STATE.accNegStreak>=2) STATE.accActive=[];
      }
      if(STATE.accActive && STATE.accActive.includes('glasses')){
        showGlassesWarn('Remove your glasses to continue — your face must be fully visible');
      } else {
        const el=document.getElementById('glasses-warn');
        if(el&&!el.classList.contains('hide')) el.classList.add('hide');
      }
    }

    // ── Guided capture: never photograph the user unannounced ──
    if (!STATE.toneKey) runCaptureCountdown(ctx, results.image, lm, W, H, ox, oy);
  } else {
    pFace.textContent='Face not found - step closer'; pFace.classList.remove('ok');
    pLM.textContent='Landmarks: -'; pLM.classList.remove('ok');
    resetCountdown('Face not detected - centre yourself in the frame');
  }
}

// Low-pass filter for the detection-screen overlay. Same adaptive scheme as
// the step screen: follows real movement, suppresses per-frame jitter, and
// smooths harder the further the head is turned.
// Per-point deadband: movement below this (in normalised units) is treated as
// sensor noise and ignored outright. This is what actually stops the visible
// shimmer - damping alone still lets every point wobble a little each frame.
const LM_DEADBAND = 0.0016;

function smoothLandmarks(prev, lm, turnVis) {
  if (!prev || prev.length!==lm.length) return lm.map(p=>({x:p.x,y:p.y}));
  let maxDelta=0;
  [1,234,454,10,152].forEach(i=>{
    const dx=lm[i].x-prev[i].x, dy=lm[i].y-prev[i].y;
    maxDelta=Math.max(maxDelta, Math.sqrt(dx*dx+dy*dy));
  });
  // Gentle base response, damped further the more the head is turned.
  let A = maxDelta>0.050 ? 0.34 : maxDelta>0.020 ? 0.24 : maxDelta>0.008 ? 0.15 : 0.08;
  A *= 0.40 + 0.60*turnVis;
  return prev.map((s,i)=>{
    const dx=lm[i].x-s.x, dy=lm[i].y-s.y;
    if (Math.abs(dx)<LM_DEADBAND && Math.abs(dy)<LM_DEADBAND) return s;  // hold still
    return {x:s.x+A*dx, y:s.y+A*dy};
  });
}

function smoothDetectLm(lm) {
  STATE.detectLm=smoothLandmarks(STATE.detectLm, lm, turnVisibility(lm));
  return STATE.detectLm;
}

// ─────────────────────────────────────────
//  OCCLUSION CHECK
//  Rejects a face that is partly covered by
//  a hand, mask, hair or object before the
//  photo is taken. Works two ways:
//   1) any key landmark projecting outside
//      the frame → part of the face is off-
//      screen or has been pushed out;
//   2) the bare-skin zones (forehead, both
//      cheeks, nose, chin) should share one
//      tone - a covering makes a zone diverge
//      strongly from the rest.
// ─────────────────────────────────────────
function occlusionCheck(image, lm) {
  try {
    // 0) Trained model takes precedence when installed.
    const occProb=classifyTM('occlusion', image, lm);
    if (occProb!=null)
      return occProb>=0.6
        ? {occluded:true, reason:'Keep your whole face visible'}
        : {occluded:false, reason:''};

    // 1) Core makeup landmarks out of frame. Forehead crown (10) and chin tip
    //    (152) are intentionally excluded - they sit at the top/bottom edge on
    //    a well-framed close-up and are not needed for makeup.
    const key=[234,454,1,4,61,291,133,362];
    for (const i of key){
      const p=lm[i]; if(!p) continue;
      if (p.x<-0.03||p.x>1.03||p.y<-0.03||p.y>1.03)
        return {occluded:true, reason:'Keep your face in view'};
    }

    const vW=image.width||640, vH=image.height||480;
    const c=document.createElement('canvas'); c.width=vW; c.height=vH;
    const cx=c.getContext('2d',{willReadFrequently:true});
    cx.drawImage(image,0,0,vW,vH);
    const rad=Math.max(2, Math.round(Math.abs(lm[454].x-lm[234].x)*vW*0.02));
    const patch=(idxs)=>{
      let r=0,g=0,b=0,n=0;
      idxs.forEach(i=>{
        const p=lm[i]; if(!p) return;
        const px=Math.round(p.x*vW), py=Math.round(p.y*vH);
        const x0=Math.max(0,px-rad), y0=Math.max(0,py-rad);
        const w=Math.min(vW,px+rad+1)-x0, h=Math.min(vH,py+rad+1)-y0;
        if(w<=0||h<=0) return;
        const d=cx.getImageData(x0,y0,w,h).data;
        for(let q=0;q<d.length;q+=4){r+=d[q];g+=d[q+1];b+=d[q+2];n++;}
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

    // Compare zones by CHROMATICITY (hue/colour balance), not brightness.
    // A lamp or window on one side makes a cheek darker than the forehead, but
    // it is still the SAME skin colour - so comparing raw brightness wrongly
    // flagged a shadow as a covering. Normalised r/g/b ratios ignore how bright
    // a zone is and only react to a genuine colour change (a mask, an object,
    // hair), which is what "covered" actually means.
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
      return {occluded:true, reason:`Uncover your ${where} - keep your whole face visible`};
    }
    return {occluded:false, reason:''};
  } catch(e){ return {occluded:false, reason:''}; }
}

// ─────────────────────────────────────────
//  CAPTURE READINESS
//  The reference photo is only taken when
//  the user is actually posed for it, and
//  only after a visible countdown.
// ─────────────────────────────────────────
function assessReadiness(image, lm) {
  // Head must be genuinely straight on for the photo
  if (faceTurnOffset(lm) > TURN_OK_CAPTURE) return {ok:false, reason:'Face the camera straight on'};

  // Distance: face width should occupy a sensible share of the frame. Upper
  // bound is generous - filling the portrait frame is good for a makeup mirror.
  const faceW=Math.abs(lm[454].x-lm[234].x);
  if (faceW < 0.20) return {ok:false, reason:'Move a little closer'};
  if (faceW > 0.95) return {ok:false, reason:'Move back a little'};

  // Centring - loose, since the portrait crop encourages a large, filled frame.
  const nose=lm[1];
  if (Math.abs(nose.x-0.5) > 0.22) return {ok:false, reason:'Centre your face horizontally'};
  if (nose.y < 0.16 || nose.y > 0.86) return {ok:false, reason:'Centre your face vertically'};

  // The MAKEUP features must be inside the frame - eyes, brows, cheeks, nose,
  // lips. The forehead crown and chin tip touching the top/bottom edge is fine
  // (we don't apply makeup there), so they are deliberately NOT required. This
  // is what let a well-framed close-up still be rejected before.
  const coreIdx=[33,263,133,362,105,334,116,345,61,291,0,17,1];
  for (const i of coreIdx){
    const p=lm[i]; if(!p) continue;
    if (p.x<0.03||p.x>0.97||p.y<0.03||p.y>0.97)
      return {ok:false, reason:'Move back a little so your features are in view'};
  }

  // Level head - avoid a tilted reference photo
  const roll=Math.abs(lm[234].y-lm[454].y)/(faceW||0.001);
  if (roll > 0.22) return {ok:false, reason:'Keep your head level'};

  // Face must be UNOBSTRUCTED - reject a hand, mask, hair or object over part
  // of it. All these zones are bare skin before makeup, so they should read as
  // one consistent tone; a covering makes one zone diverge sharply.
  const occ=occlusionCheck(image, lm);
  if (occ.occluded) return {ok:false, reason:occ.reason};

  // Lighting must be usable or the tone reading is worthless
  try {
    const vW=image.width||640, vH=image.height||480;
    const t=document.createElement('canvas'); t.width=48; t.height=36;
    const tx=t.getContext('2d',{willReadFrequently:true});
    tx.drawImage(image,0,0,48,36);
    const d=tx.getImageData(0,0,48,36).data;
    let br=0; const N=d.length/4;
    for(let i=0;i<d.length;i+=4) br+=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
    const avg=br/N;
    if (avg<55)  return {ok:false, reason:'Too dark - turn on your LED strip'};
    if (avg>212) return {ok:false, reason:'Too bright - reduce glare'};
  } catch(e){}

  // Face COVERINGS (mask, hand, object, hair) are caught by occlusionCheck.
  //
  // GLASSES hard-block Capture regardless of whether the trained model is
  // loaded. The pixel heuristic is conservative (needs lens cue + at least one
  // corroborating cue, only runs on near-frontal faces, and requires a 2-frame
  // positive streak), so false positives on a bare face should be rare - and
  // the user explicitly wants no capture path while glasses are detected.
  if (STATE.accActive && STATE.accActive.includes('glasses')){
    return {ok:false, reason:'Remove your glasses to continue - your face must be fully visible'};
  }
  return {ok:true, reason:''};
}

// True only when a trained Teachable Machine glasses model is loaded and ready.
function glassesModelReady() {
  return typeof _tm!=='undefined' && _tm.glasses && _tm.glasses.state==='ready';
}

function resetCountdown(msg) {
  STATE.readyStreak=0;
  STATE.countdownStart=0;
  const sub=document.getElementById('cam-sub');
  if (sub && msg) sub.textContent=msg;
}

const COUNTDOWN_MS = 3000;   // 3 · 2 · 1 once the user presses Capture

// Pressing "Capture Photo" starts the countdown - never the system on its own.
function requestCapture() {
  if (STATE.toneKey) return;
  if (!STATE.captureArmed) return;      // button is only live when you're ready
  STATE.countdownStart=Date.now();
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
      STATE.countdownStart=0;
      if (btn){ btn.disabled=true; btn.textContent='Capture Photo'; }
      if (status){ status.className='capture-status'; status.textContent=`Cancelled - ${r.reason}`; }
      drawCaptureHint(ctx, W, H, ox, oy, r.reason, null);
      return;
    }
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
    // ── Countdown finished: classify tone and freeze the reference frame ──
    const tone=detectToneFromImage(image, lm, W, H);
    if (!tone){
      STATE.countdownStart=0;
      if (status) status.textContent='Could not read your skin tone - try again';
      return;
    }
    STATE.toneKey=tone;
    captureReferenceFrame(image, lm);
    captureBaseline(image, lm);   // bare-face reference for every later step

    const pTone=document.getElementById('pill-tone');
    if (pTone){ pTone.textContent=`Tone: ${formatTone(tone)} ✓`; pTone.classList.add('ok'); }
    if (title)  title.textContent='Analysis complete!';
    if (sub)    sub.textContent='Tap below to see your shade recommendations';
    if (btn)    btn.style.display='none';
    if (status) status.style.display='none';
    const d=document.getElementById('btn-detect');
    if (d){ d.style.display=''; d.textContent='See My Recommendations →'; d.disabled=false; d.onclick=showShades; }
    return;
  }

  // ── Idle: just report whether the user is ready to press Capture ──
  if (title) title.textContent=r.ok?'Ready when you are':'Get into position';
  if (sub)   sub.textContent=r.ok?'Press Capture Photo when you are ready'
                                 :'Adjust your position, then press Capture';
  if (btn)   btn.disabled=!r.ok;
  if (status){
    status.className='capture-status'+(r.ok?' ready':'');
    status.textContent=r.ok?'✓ Good to go. Press Capture Photo'
                           :`Not ready: ${r.reason}`;
  }
  if (!r.ok) drawCaptureHint(ctx, W, H, ox, oy, r.reason, null);
}

// The overlay canvases are CSS-mirrored (transform:scaleX(-1)) so the mirror
// reads naturally. Anything textual must therefore be drawn pre-flipped, or it
// appears backwards to the user. Everything inside this helper is un-mirrored.
function drawMirroredText(ctx, text, cx, cy, font, fill, boxed) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);          // cancel the CSS flip
  ctx.font=font;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  if (boxed){
    const tw=ctx.measureText(text).width;
    ctx.fillStyle='rgba(0,0,0,0.58)';
    ctx.fillRect(-tw/2-14, -16, tw+28, 32);
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
    // Modern countdown: a soft ring with a clean geometric numeral (Jost),
    // lifted off the video with a gentle shadow rather than a heavy outline.
    const rad=Math.min(W,H)*0.16;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx,cy,rad,0,Math.PI*2);
    ctx.fillStyle='rgba(20,12,10,0.42)'; ctx.fill();
    ctx.lineWidth=2.5; ctx.strokeStyle='rgba(232,192,128,0.85)'; ctx.stroke();
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
    // The glasses message is already shown in full on the top-of-camera banner,
    // so re-drawing it as an overlay is redundant AND long enough to clip the
    // narrow phone overlay canvas horizontally. Skip the overlay in that case.
    const isGlassesMsg = message.toLowerCase().indexOf('glasses')>=0;
    if (!isGlassesMsg){
      // Fit-to-width: shrink the font so the boxed background stays inside the
      // canvas on narrow (phone) overlays, same pattern used by the Face-forward
      // hint on the step screen.
      const maxW = Math.max(80, W - 28);
      ctx.save();
      let px = 15;
      ctx.font = `600 ${px}px Jost, sans-serif`;
      let text = message;
      if (ctx.measureText(text).width > maxW){
        px = Math.max(10, Math.floor(15 * maxW / ctx.measureText(text).width));
      }
      ctx.restore();
      drawMirroredText(ctx, text, cx, cy,
        `600 ${px}px Jost, sans-serif`, 'rgba(255,240,225,0.95)', true);
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────
//  WHITE GUIDE - plain open arc
// ─────────────────────────────────────────
// Placement guides are drawn in a bright neutral, never in the product colour.
// Brow and contour shades are dark browns, so a guide stroked in the shade
// disappeared against dark brow hair or a shadowed cheek. White reads on every
// skin tone; the product colour is still used for the soft fill hint.
const BROW_GUIDE    = 'rgba(255,255,255,0.95)';
const CONTOUR_GUIDE = 'rgba(255,255,255,0.95)';

function drawWhiteGuide(ctx, pts, lw) {
  ctx.save();
  ctx.beginPath(); softArcPath(ctx,pts);
  // A fine line traces the lip edge precisely; a heavy one covered the very
  // edge the user is meant to follow.
  ctx.strokeStyle='rgba(255,255,255,0.95)'; ctx.lineWidth=lw*0.8;
  ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
  ctx.restore();
}

// ─────────────────────────────────────────
//  DRAW LIPS
// ─────────────────────────────────────────
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
    // Thin contrast backing + fine coloured line, so the outline reads clearly
    // on any skin tone without smothering the lip edge.
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

// ─────────────────────────────────────────
//  DRAW BROWS - beginner-friendly guide
//  Soft fill + dashed outline + 6 upward
//  hair strokes + gold start dot + tail
//  arrow showing stroke direction.
// ─────────────────────────────────────────
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

    // 2. Dashed outline - boundary to stay within.
    //    Drawn in white over a thin dark backing: the brow shade is a dark
    //    brown, so stroking the guide in the product colour made it invisible
    //    against the user's own (dark) eyebrow hair.
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

// ─────────────────────────────────────────
//  DRAW BLUSH - diagonal sweep guide
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  NOSE CONTOUR GUIDE
//  Two slim dashed lines along the sides
//  of the nose bridge - universal for all
//  face shapes.
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  DRAW CONTOUR - face-shape aware guide
//  Shows nose contour (universal) plus
//  cheek / jaw sweep paths tailored to the
//  detected face shape.
//  Shapes: oval · round · oblong · heart ·
//          diamond · square
// ─────────────────────────────────────────
function drawContour(ctx, lm, W, H, sc, fc, lw) {
  const shape = detectFaceShape(lm);
  const faceH = Math.abs(lm[10].y  - lm[152].y) * H;
  const faceW = Math.abs(lm[234].x - lm[454].x) * W;

  // Per-side visibility, same idea as drawBlush: the receding side of a turned
  // face has landmarks that project onto the wrong anatomy, so the sweep would
  // draw contour on the visible side. Fade each half by how much of it is
  // actually facing the camera; this stops the "wrong side" tracking.
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
    // Soft placement hint. Was lw*9 - a ~36px blurred band that read as one
    // thick smear instead of a line to follow. Now a narrow, fainter cushion.
    if (fc) {
      ctx.save(); ctx.filter='blur(3px)'; ctx.globalAlpha=0.55;
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.quadraticCurveTo(ctrl.x,ctrl.y,p2.x,p2.y);
      ctx.strokeStyle=fc; ctx.lineWidth=lw*3.2; ctx.lineCap='round'; ctx.stroke();
      ctx.restore();
    }
    // Fine white sweep line over a thin dark backing, so it stays legible on a
    // shadowed cheek where the brown product colour vanished.
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

  // ① Nose sides - always shown (nose is centerline, both sides visible when
  // the head is anywhere near frontal).
  drawNoseContourGuide(ctx, lm, W, H, sc, fc, lw);

  // Per-side wrapper: attenuates alpha for the receding half of the face so
  // the sweep on that side fades out instead of jumping to the wrong anatomy.
  // Anything under 0.05 is dropped entirely - a barely-visible ghost still
  // reads as "there is a line on the wrong cheek".
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

// ─────────────────────────────────────────
//  SKIN TONE
// ─────────────────────────────────────────
// ─────────────────────────────────────────
//  NEUTRAL WHITE REFERENCE (sclera)
//  The whites of the eyes are approximately
//  neutral for every person, so any colour
//  tint measured there belongs to the
//  LIGHTING, not the skin. Using it to
//  white-balance the skin sample is what
//  makes the tone reading consistent under
//  a warm bulb, daylight or an LED strip -
//  the lighting sensitivity flagged in the
//  skin-tone literature (Mbatha et al.).
// ─────────────────────────────────────────
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
        // Sclera signature: BRIGHT, and the least saturated thing in the eye
        // region. The tolerance must be loose, because a strong colour cast
        // tints the sclera itself (a warm bulb pushes it to ~0.35) - that tint
        // is exactly the signal we are here to measure, so a tight filter threw
        // the reference away and left no correction at all. The upper bound
        // must also allow 255, or a clipped sclera is discarded in favour of
        // the anti-aliased rim pixels blended with the brown iris.
        if (mx>70 && sat<0.45) cand.push({r,g,b,v:mx,s:sat});
      }
    });
    if (cand.length<8) return null;
    // Of those, keep the least saturated half: skin and iris are far more
    // saturated than sclera under any illuminant, so this rejects them
    // without assuming what the illuminant is.
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
    // Well-lit skin only: cheeks + forehead. Deliberately excludes the nose tip
    // (specular shine) and the bridge/chin (shadow), which skewed the reading.
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
      // 1. Colour cast: per-channel gains that would neutralise the reference
      //    to grey (von Kries adaptation). Removes the warm-bulb / cool-tube
      //    bias that made the undertone read the same for everyone. Skipped if
      //    the reference is clipped, since its colour is then meaningless.
      const clampGain=v=>Math.min(1.6, Math.max(0.625, v));
      if (!white.clipped){
        const wMean=(white.r+white.g+white.b)/3;
        r=Math.min(255,r*clampGain(wMean/Math.max(1,white.r)));
        g=Math.min(255,g*clampGain(wMean/Math.max(1,white.g)));
        b=Math.min(255,b*clampGain(wMean/Math.max(1,white.b)));
      } else {
        // Reference is clipped, so its absolute level is unusable - but the
        // ratios between channels that did NOT clip still carry the cast.
        // Anchor on green (the last channel to blow out) for a partial
        // correction; better than leaving the cast in entirely.
        r=Math.min(255,r*clampGain(white.g/Math.max(1,white.r)));
        b=Math.min(255,b*clampGain(white.g/Math.max(1,white.b)));
      }

    }

    const br=r*.299+g*.587+b*.114;

    // ── Tone level ──
    // Measured as skin brightness RELATIVE to the sclera rather than in
    // absolute terms. Both are lit by the same source, so the ratio cancels the
    // exposure out entirely: the same person reads the same in a dim room, a
    // bright one, or under a lamp. Absolute brightness cannot do that - it is
    // what made a dim room classify everyone as deep.
    let level;
    if (white && !white.clipped){
      const wBr=white.r*.299+white.g*.587+white.b*.114;
      const ratio=br/Math.max(1,wBr);
      // Boundaries sit midway between the reference skin swatches measured
      // against a neutral sclera (light .90, medium .68, deep .42).
      level = ratio>0.785 ? 'light' : ratio>0.545 ? 'medium' : 'dark';
    } else {
      // No usable reference (eyes closed, or highlights blown): fall back to
      // absolute bands, which are exposure-dependent but better than nothing.
      level = br>178 ? 'light' : br>128 ? 'medium' : 'dark';
    }
    // Undertone judged relative to overall brightness, so it isn't just "warm"
    // for everyone (skin is always r>b in absolute terms).
    const undertone = (r-b) > br*0.20 ? 'warm' : 'cool';
    return `${level}_${undertone}`;
  } catch(e){return 'medium_warm';}
}
function formatTone(k){return{light_warm:'Light Warm',light_cool:'Light Cool',medium_warm:'Medium Warm',medium_cool:'Medium Cool',dark_warm:'Deep Warm',dark_cool:'Deep Cool'}[k]||k;}

// ─────────────────────────────────────────
//  SHADE RECOMMENDATIONS
// ─────────────────────────────────────────
function showShades() {
  const toneKey=STATE.toneKey||'medium_warm';
  const tone=STATE.shades?.[toneKey];
  if (!tone){console.error('No shades for',toneKey);return;}
  document.getElementById('shade-tone-label').textContent=`Skin tone: ${formatTone(toneKey)} · Soft & Natural`;
  const map={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const focal=map[STATE.focal]||STATE.focal;
  document.getElementById('focal-badge-label').textContent=STATE.focalData?.[STATE.focal]?.label||STATE.focal;
  const grid=document.getElementById('shade-grid'); grid.innerHTML='';
  STEPS.forEach(step=>{
    const shade=tone[step]; if (!shade) return;
    const isFocal=step===focal;
    const card=document.createElement('div');
    card.className='shade-card'+(isFocal?' focal-highlight':'');
    card.innerHTML=`<div class="shade-swatch" style="background:${shade.hex}"></div><div class="shade-step-label">${STEP_LABELS[step]}${isFocal?'<span class="focal-star"> ★</span>':''}</div><div class="shade-name-txt">${shade.shade}</div><div class="shade-brand-txt">${shade.brand||shade.product||''}</div><div class="shade-slot-badge">Slot ${shade.slot}</div>`;
    grid.appendChild(card);
  });
  goTo('screen-shades');
  prewarmTryOnMesh();
  // Load the quality classifier now, while the user reads their shades,
  // so the first "Check My Placement" is not delayed by it.
  initQualityModel();
}

// ─────────────────────────────────────────
//  PICTURE-BASED REFERENCE GUIDE
//  A still of the user's own face, captured
//  the moment their tone was classified, is
//  re-rendered with the selected style and
//  kept beside the live feed as a stable
//  visual target. Distinct from try-on,
//  which is a live filter.
// ─────────────────────────────────────────
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

// Paints the captured still + the given style onto a target canvas, cropped to
// a portrait frame so the reference sits naturally beside the portrait mirror.
const REF_PORTRAIT = 3/4;   // width:height

function paintReferenceGuide(canvasEl, style) {
  if (!canvasEl || !STATE.captureCanvas || !STATE.captureLm) return false;
  const src=STATE.captureCanvas;
  const W=src.width, H=src.height;

  // 1) Render the complete look at native resolution off-screen.
  const full=document.createElement('canvas'); full.width=W; full.height=H;
  const fctx=full.getContext('2d');
  fctx.drawImage(src,0,0);
  // stepOnly:null is explicit - the reference is always the complete look,
  // even if a per-step try-on happens to be open at the time.
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

// ═════════════════════════════════════════
//  BARE-FACE BASELINE
//
//  The single biggest cause of false
//  "makeup detected" results is that every
//  feature is naturally different from
//  plain skin: brows are darker, lips are
//  redder, cheek hollows are shadowed. A
//  fixed threshold therefore reads a bare
//  face as "product applied".
//
//  So at capture time - before any of the
//  four steps - we record how each zone
//  looks on THIS user. Every later check
//  asks "has this zone changed since your
//  own before photo?" instead of "is this
//  darker than skin?".
// ═════════════════════════════════════════
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

// ─────────────────────────────────────────
//  STYLE VARIATION SCREEN
// ─────────────────────────────────────────
function renderStyleScreen() {
  const grid=document.getElementById('style-grid');
  const sub=document.getElementById('style-sub');
  if (!grid) return;
  grid.innerHTML='';

  const focalLabel=STATE.focalData?.[STATE.focal]?.label||STATE.focal||'your focal point';
  const variations=STATE.styleData?.[STATE.focal];

  if (!Array.isArray(variations)||!variations.length){
    // Missing or unreadable preset file - let the user through rather than
    // trapping them on a dead screen.
    grid.innerHTML='<p class="page-sub" style="grid-column:1/-1;text-align:center">'
      +'Style variations are unavailable right now. Continuing with the standard '
      +'Soft &amp; Natural look.</p>';
    STATE.style=null;
    const nb=document.getElementById('btn-style-next'); if(nb) nb.disabled=false;
    return;
  }

  // Kept short: on a phone a longer line wraps to three rows and pushes the
  // reference guide and Continue button down the page.
  if (sub) sub.textContent=`Same ${focalLabel} shades, three levels of coverage`;

  const focalStep={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'}[STATE.focal]||'lips';

  // Shades are identical across variations (they use the detected tone's
  // recommendation) — so this is the same for every card and reassures the
  // user their tried-on shades won't change.
  const resolved=resolveShades(STATE.toneKey||'medium_warm', null)||{};
  const swatches=STEPS.map(step=>{
    const hex=resolved[step]?.hex||'#555';
    const lead=step===focalStep?' lead':'';
    const title=`${STEP_LABELS[step]}: ${resolved[step]?.shade||'-'}`;
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
    empty.textContent='Reference guide unavailable - your captured photo could not be read. '
      +'You can still continue; the live AR guide is unaffected.';
  }

  const nb=document.getElementById('btn-style-next');
  if (nb) nb.disabled=false;
}

// ─────────────────────────────────────────
//  FOUNDATION CHECKER
//  Recommends a base shade from the detected
//  tone and confirms readiness. It never
//  verifies the shade actually used and
//  provides no AR guide for foundation.
// ─────────────────────────────────────────
function renderFoundationScreen() {
  const toneKey=STATE.toneKey||'medium_warm';
  const f=STATE.foundationData?.[toneKey];
  const set=(id,txt)=>{const el=document.getElementById(id); if(el) el.textContent=txt;};

  if (!f){
    set('found-shade','Unavailable');
    set('found-product','The foundation library could not be loaded.');
    set('found-brand','');
    set('found-slot','');
    const sw=document.getElementById('found-swatch');
    if (sw) sw.style.background='#3a2530';
    return;
  }
  const sw=document.getElementById('found-swatch');
  if (sw) sw.style.background=f.hex;
  set('found-shade',   f.shade);
  set('found-product', f.product||'');
  set('found-brand',   f.brand||'');
  set('found-slot',    `Tray slot ${f.slot}`);
}

function confirmFoundation(applied) {
  STATE.foundationConfirmed=!!applied;
  startMakeupSteps();
}

// ─────────────────────────────────────────
//  MAKEUP STEP LOOP
// ─────────────────────────────────────────
async function startMakeupSteps() {
  stopTryOn();
  stopStream();
  STATE.currentStep=0; STATE.stepResults=[]; STATE.lipSubStep=0;
  renderStep(0); goTo('screen-step');
  const sv=document.getElementById('step-video');
  try {
    STATE.stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});
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

  // Coverage guidance from the chosen variation — tells the user HOW MUCH of
  // the same product to apply for the look they picked.
  const covNote = coverageNote(step);

  if (step==='lips'){
    const sub=LIP_SUBSTEP[STATE.lipSubStep]||LIP_SUBSTEP[0];
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}  ·  ${sub.badge}`;
    document.getElementById('step-name').textContent=`Lips · ${sub.label}`;
    // Coverage applies to the final lip check, not the top/bottom fill sub-steps.
    document.getElementById('step-instruction').textContent=
      sub.instruction + (STATE.lipSubStep>=2 ? covNote : '');
  } else {
    document.getElementById('step-counter').textContent=`Step ${index+1} of ${STEPS.length}`;
    document.getElementById('step-name').textContent=STEP_LABELS[step];
    document.getElementById('step-instruction').textContent=STEP_INSTRUCTIONS[step] + covNote;
  }

  if (shade){
    document.getElementById('ssc-swatch').style.background=shade.hex;
    document.getElementById('ssc-shade').textContent=shade.shade;
    document.getElementById('ssc-brand').textContent=shade.brand||shade.product||'';
    document.getElementById('ssc-slot').textContent=`Tray slot ${shade.slot}`;
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

  STATE.blushLm         = null;
  STATE.blushFrameCount = 0;

  let skipBtn=document.getElementById('btn-skip');
  if (!skipBtn){
    skipBtn=document.createElement('button'); skipBtn.id='btn-skip'; skipBtn.textContent='Skip step →';
    Object.assign(skipBtn.style,{marginTop:'8px',padding:'6px 18px',fontSize:'12px',background:'transparent',color:'rgba(255,255,255,0.45)',border:'1px solid rgba(255,255,255,0.20)',borderRadius:'20px',cursor:'pointer',display:'block',width:'100%',letterSpacing:'0.04em'});
    skipBtn.onmouseenter=()=>skipBtn.style.color='rgba(255,255,255,0.80)';
    skipBtn.onmouseleave=()=>skipBtn.style.color='rgba(255,255,255,0.45)';
    const retryBtn=document.getElementById('btn-retry');
    retryBtn?.parentElement?.insertBefore(skipBtn,retryBtn.nextSibling);
  }
  skipBtn.style.display='block';
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

// ─────────────────────────────────────────
//  STEP FACE MESH
// ─────────────────────────────────────────
function startStepFaceMesh() {
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const video=document.getElementById('step-video');
    const fm=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
    fm.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
    fm.onResults(onStepResults); STATE.faceMesh=fm;
    const cam=new Camera(video,{onFrame:async()=>{if(STATE.faceMesh)await STATE.faceMesh.send({image:video});},width:640,height:480});
    STATE.camera=cam; cam.start();
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
    // Same filter as the detection screen: gentle response, heavier damping
    // when turned, plus a deadband that ignores pure sensor noise.
    STATE.smoothedLm=smoothLandmarks(STATE.smoothedLm, lm, turnVisibility(lm));
  }
  const dlm=STATE.smoothedLm;

  // Guides follow the face at any angle; they dim as the head turns rather
  // than disappearing, because a turned pose is harder to track precisely.
  const turnVis = turnVisibility(lm);

  const fMap={lips:'lips',eyebrows:'eyebrows',cheeks:'blush',contour:'contour'};
  const cs=STEPS[STATE.currentStep];
  const fs=fMap[STATE.focal]||cs;
  const shade=activeShades()?.[cs];
  const hex=shade?.hex||'#e87090';
  // The selected variation sets how strongly this step's guide reads. Kept
  // above 0.55 so a soft preset never renders an unusably faint outline.
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
      // Never snap to 1.0 - a full jump to the raw landmarks on fast motion
      // is what made the blush ellipse judder while turning.
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
  // Step-screen guides fade slightly harder than the detection overlay: on the
  // step screen the user is following a line, so a drifted guide is worse than
  // no guide. turnVis alone bottoms out at 0.35; squaring the fraction above
  // 0.7 doubles the fade rate past a moderate turn without touching frontal.
  const stepFade = turnVis>=0.7 ? turnVis : 0.7 * Math.pow(turnVis/0.7, 1.6);
  ctx.globalAlpha = stepFade;

  const blushCov=cs==='blush'?getBlushCoverage(document.getElementById('step-video'),blm):undefined;

  // The focal step is emphasised with a coloured GLOW on a single pass. It used
  // to be drawn a second time on top, which doubled every line and was a large
  // part of why the guides looked thick.
  ctx.save();
  if (cs===fs && cs!=='lips'){ ctx.shadowColor=hex; ctx.shadowBlur=12; }

  if      (cs==='lips')     drawLips   (ctx,dlm,effW,effH,sc,fc,2.1,true,STATE.lipSubStep);
  else if (cs==='blush')    drawBlush  (ctx,dlm,effW,effH,sc,fc,2.3,blushCov);
  else if (cs==='eyebrows') drawBrows  (ctx,dlm,effW,effH,sc,fc,2.6);
  else if (cs==='contour')  drawContour(ctx,dlm,effW,effH,sc,fc,2.4);
  ctx.restore();

  // Gentle hint when the head is turned far enough that accuracy drops.
  // The overlay canvas can be as narrow as ~180 px on a small phone once the
  // mirror shares the row with the reference panel, so the full sentence gets
  // clipped at both edges. Fit-to-width: shrink the font, and drop to the
  // short form when even that would still overflow the visible box.
  if (turnVis < 0.7){
    ctx.globalAlpha = 1;
    const full  = 'Face forward for the most accurate guide';
    const short = 'Face forward';
    const maxW  = Math.max(80, W - 28);            // 14 px inset each side
    ctx.save();
    let px = 13;
    ctx.font = `600 ${px}px Jost, sans-serif`;
    let text = full;
    if (ctx.measureText(full).width > maxW){
      px = Math.max(10, Math.floor(13 * maxW / ctx.measureText(full).width));
      ctx.font = `600 ${px}px Jost, sans-serif`;
      if (ctx.measureText(full).width > maxW) text = short;
    }
    ctx.restore();
    drawMirroredText(ctx, text,
      W/2+ox, H*0.08+oy, `600 ${px}px Jost, sans-serif`, 'rgba(255,255,255,0.80)', true);
  }
  ctx.restore();
  checkStepLighting(video);
}

// ═════════════════════════════════════════
//  APPLICATION QUALITY FEEDBACK (Objective 9)
//
//  Evaluates a completed step for smudging,
//  unevenness, and excessive/insufficient
//  product, alongside the colour-based
//  placement check.
//
//  Two interchangeable back-ends, same output
//  contract:
//    'model'     - TensorFlow.js MobileNetV2
//                  fine-tuned by transfer
//                  learning on researcher-
//                  collected application
//                  images. Used when
//                  QUALITY_MODEL_URL resolves.
//    'heuristic' - geometric/photometric
//                  analysis of the same ROI.
//                  Used until that model has
//                  been trained and exported.
// ═════════════════════════════════════════
const QUALITY_MODEL_URL = 'models/application-quality/model.json';
const QUALITY_CLASSES   = ['good','smudged','uneven','amount'];
const QUALITY_INPUT     = 224;

let _qModel = null;
let _qState = 'idle';   // idle | loading | ready | absent

async function initQualityModel() {
  if (_qState!=='idle') return _qState;
  if (typeof tf==='undefined'){
    console.warn('[quality] TensorFlow.js not loaded - using analytical fallback.');
    _qState='absent'; return _qState;
  }
  _qState='loading';
  try {
    _qModel=await tf.loadLayersModel(QUALITY_MODEL_URL);
    tf.tidy(()=>_qModel.predict(tf.zeros([1,QUALITY_INPUT,QUALITY_INPUT,3])));  // warm-up
    _qState='ready';
    console.log('[quality] MobileNetV2 classifier ready.');
  } catch(e) {
    _qModel=null; _qState='absent';
    console.warn('[quality] No trained model at '+QUALITY_MODEL_URL+
                 ' - using analytical fallback. ('+e.message+')');
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

// Tolerances per step, derived from the same colour space the placement
// check uses (L1 distance from the user's own forehead skin).
// Bands apply to the BASELINE-RELATIVE amount (product only, anatomy removed),
// so the upper limits are far lower than raw skin deviation would suggest.
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

  // Every feature already differs from plain skin before any product goes on
  // (brows are dark, lips are red, hollows are shadowed). Subtract how much
  // this zone naturally deviated in the user's before photo, so "amount"
  // measures PRODUCT rather than anatomy. Without a baseline, fall back to
  // the raw deviation.
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
  // Shift the acceptable amount window to the coverage the user actually chose,
  // so a deliberately SHEER application is not flagged "too little", and a heavy
  // one on a sheer look is nudged as "too much". Full coverage keeps the base
  // band. cov ~ 0.6 (sheer) .. 1.0 (full).
  const cov = Math.max(0.45, Math.min(1, styleIntensity(step)));
  const minAmount = band.minAmount * (0.35 + 0.65*cov);   // sheer needs less to count
  const maxAmount = band.maxAmount * (0.55 + 0.45*cov);   // sheer flags excess sooner
  const tooLittle=amount<minAmount;
  const tooMuch  =amount>maxAmount;
  const amountOk =!tooLittle && !tooMuch;
  // Smudging and evenness only mean something once there is product to judge.
  // Below the minimum, the ratios are dominated by noise, so they are reported
  // as not-assessed rather than as failures on top of "too little".
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
  if (!q.verdicts.smudge.ok) parts.push(`colour has spread past the guide - tidy the edges of your ${label}`);
  if (!q.verdicts.uneven.ok) parts.push('coverage is patchy - blend until the colour reads the same throughout');
  if (!q.verdicts.amount.ok){
    const t=q.verdicts.amount.text;
    if (t.includes('Too little'))      parts.push('build up a little more product');
    else if (t.includes('Too much'))   parts.push('sheer it out - there is more product than the look needs');
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

// ─────────────────────────────────────────
//  PLACEMENT CHECK
// ─────────────────────────────────────────
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

// One row per step. Retrying a step overwrites its previous result instead of
// appending, so the summary total always equals the number of steps attempted.
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
    // Stay on the final sub-step when quality fails, so Retry re-checks the
    // finished mouth rather than restarting from the top lip.
    if (passed) STATE.lipSubStep=0;
    recordStepResult(step,{passed,message,quality:q||null});
    showFeedback(passed,message,q);
  } else {
    STATE.lipSubStep=next;
    document.getElementById('step-name').textContent=`Lips · ${LIP_SUBSTEP[next].label}`;
    document.getElementById('step-instruction').textContent=LIP_SUBSTEP[next].instruction;
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

// ─────────────────────────────────────────
//  ASYNC MULTI-FRAME LIP ANALYSIS
// ─────────────────────────────────────────
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
  // When a bare-face baseline exists it is AUTHORITATIVE: "has this changed
  // since your own before photo?" is far more reliable than any absolute
  // colour threshold, and it is what the user actually asked for. The old
  // cheek-relative thresholds are only the fallback when no baseline was taken.
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
        'No lipstick detected - your lips look the same as in your before photo. '+
        'Fill fully within the outline in even light, then check again.'};
    // No red/pink shift over the cheek = bare lips → always "natural",
    // never "too sheer" (which wrongly implies thin lipstick was applied).
    const hasColourShift=(redShift>16||pinkShift>18)&&satIncrease>0.06&&devFH>54;
    let msg;
    if(!hasColourShift)
      msg='No lipstick detected - your lips look natural. If you have applied colour, fill fully within the outline in good light and hold still.';
    else if(dev<=46)
      msg='Colour is close to your skin tone. Try the recommended shade for a clearer result.';
    else
      msg='Application looks sheer - build up a little more colour within the outline and check again.';
    return {passed:false,message:msg};
  }

  // Unevenness from the robust spread of the whole region, with glare already
  // excluded - a wet highlight can no longer masquerade as a bare patch.
  if (satIQR>0.26)
    return {passed:false,message:'Application uneven - some areas look bare or patchy. Blend more evenly right to the outline edges, then check again.'};

  const recShade=activeShades()?.lips;
  const shadeHex=recShade?.hex;
  if(!shadeHex||shadeHex.length<7) return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
  const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
  const recBr=sr*0.299+sg*0.587+sb*0.114;
  const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
  const brightDiff=br-recBr;
  if(shadeDist<=70) return{passed:true,warning:false,message:'Lipstick applied and recognized - shade matches your recommendation! Looks beautiful.'};
  let shadeMsg;
  if(brightDiff>45) shadeMsg='Too light - your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
  else if(brightDiff<-45) shadeMsg='Too dark - your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
  else shadeMsg="Wrong shade - the colour doesn't match the recommendation. Try the suggested shade for the best result.";
  return{passed:true,warning:true,message:shadeMsg};
}

// ─────────────────────────────────────────
//  ZONE COLOR ANALYSIS
// ─────────────────────────────────────────
// Minimum change from the user's own bare-face baseline before a step counts
// as "product applied". Tuned per step: brows and lips take pigment densely,
// blush and contour are sheer washes by design.
const BASELINE_MIN = {
  lips:     { delta:34, extra:(c)=>c.redGain>10||c.pinkGain>12||c.satGain>0.07 },
  eyebrows: { delta:26, extra:(c)=>c.darker>9 },
  blush:    { delta:20, extra:(c)=>c.redGain>7||c.pinkGain>8||c.satGain>0.045 },
  contour:  { delta:20, extra:(c)=>c.darker>7 },
};

// Verdict for "has this step actually been applied?", judged against the
// before photo. Returns null when no baseline exists (falls back to the
// older absolute thresholds).
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

    // ── Baseline decision (authoritative when a bare-face reference exists) ──
    // "Has this zone changed since your own before photo?" replaces the old
    // absolute skin-relative thresholds, which read natural brows/hollows as
    // product. Applied → pass; unchanged → clear "no product" message.
    if (step!=='lips' && STATE.baseline){
      const fd=tctx.getImageData(0,0,W,H).data;
      const bv=baselineVerdict(fd, lm, step, W, H);
      if (bv){
        if (!bv.applied){
          const noun={blush:'blush',eyebrows:'brow',contour:'contour'}[step]||step;
          return {passed:false, message:
            `No ${noun} product detected - this area looks the same as your before photo. `+
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
        // The signature of NO lipstick is the absence of a clear red/pink shift
        // over the cheek - bare lips must read as "natural", never as "sheer".
        const hasColourShift=(redShift>16||pinkShift>18)&&satIncrease>0.06;
        let msg;
        if(!hasColourShift)
          msg='No lipstick detected - your lips look natural. If you have applied colour, fill fully within the outline in good light and hold still.';
        else if(dev<=46)
          msg='Colour is close to your skin tone. Try the recommended shade for a clearer result.';
        else
          msg='Application looks sheer - build up a little more colour within the outline and check again.';
        return{passed:false,message:msg};
      }
      const samplePts=sampleOverride||SAMPLE_IDX[step]||[];
      const ptSats=samplePts.map(i=>{const x=Math.round(lm[i].x*W),y=Math.round(lm[i].y*H);if(x<1||x>=W-1||y<1||y>=H-1)return null;let pr=0,pg=0,pb=0,pn=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const d=tctx.getImageData(x+dx,y+dy,1,1).data;pr+=d[0];pg+=d[1];pb+=d[2];pn++;}return pn>0?rgbSat(pr/pn,pg/pn,pb/pn):null;}).filter(v=>v!==null);
      if(ptSats.length>2){const spread=Math.max(...ptSats)-Math.min(...ptSats);if(spread>0.20)return{passed:false,message:'Application uneven - some areas look bare or smudged. Blend more evenly right to the outline edges, then check again.'};}
      const recShade=STATE.shades?.[STATE.toneKey||'medium_warm']?.lips;
      const shadeHex=recShade?.hex;
      if(!shadeHex||shadeHex.length<7)return{passed:true,warning:false,message:'Lipstick applied and recognized! Great coverage.'};
      const sr=parseInt(shadeHex.slice(1,3),16),sg=parseInt(shadeHex.slice(3,5),16),sb=parseInt(shadeHex.slice(5,7),16);
      const recBr=sr*0.299+sg*0.587+sb*0.114;
      const shadeDist=Math.abs(r-sr)+Math.abs(g-sg)+Math.abs(b-sb);
      const brightDiff=br-recBr;
      if(shadeDist<=55)return{passed:true,warning:false,message:'Lipstick applied and recognized - shade matches your recommendation! Looks beautiful.'};
      let shadeMsg;
      if(brightDiff>35) shadeMsg='Too light - your lipstick is lighter than the recommended shade. Try a deeper application or a darker product.';
      else if(brightDiff<-35) shadeMsg='Too dark - your lipstick is darker than the recommended shade. Try a lighter application or a brighter product.';
      else shadeMsg="Wrong shade - the colour doesn't match the recommendation. Try the suggested shade for the best result.";
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
        if(dev<=42||absSat<=0.30) msg='No blush detected - apply colour to the apples of your cheeks within the guide.';
        else if(satIncrease<=0.10) msg='Blush too sheer - build up a little more colour and blend within the outline.';
        else msg='Colour not reading as blush - try a pinker or rosier shade and blend upward along the guide.';
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

// ─────────────────────────────────────────
//  ROBUST REGION SAMPLING
//  Samples every pixel inside a polygon
//  (optionally minus an inner polygon) and
//  reports MEDIAN colour plus a robust
//  spread. Specular highlights - the wet
//  shine that appears when lips are licked -
//  are discarded before any statistic is
//  computed, so gloss no longer flips the
//  verdict from frame to frame.
// ─────────────────────────────────────────
function sampleRegionRobust(frameData, W, H, outerPts, innerPts) {
  // Work inside the region's bounding box only. Masking the whole frame per
  // region was far too slow - a single check builds ~20 of these.
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

function getBlushCoverage(video, lm) {
  try {
    const vW=video.videoWidth||640,vH=video.videoHeight||480;
    const tmp=document.createElement('canvas'); tmp.width=vW; tmp.height=vH;
    const tctx=tmp.getContext('2d'); tctx.drawImage(video,0,0,vW,vH);
    const pts=[123,352,116,345,50,280,205,425];
    let sat=0,n=0;
    pts.forEach(i=>{const x=Math.round(lm[i].x*vW),y=Math.round(lm[i].y*vH);if(x>=1&&x<vW-1&&y>=1&&y<vH-1){const d=tctx.getImageData(x,y,1,1).data;sat+=rgbSat(d[0],d[1],d[2]);n++;}});
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

// ─────────────────────────────────────────
//  SUMMARY
// ─────────────────────────────────────────
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
  const foundNote=STATE.foundationConfirmed===false?' · foundation skipped':'';
  // Label the style explicitly - a bare name here reads as a verdict on the
  // makeup itself (e.g. "Sheer Veil" looked like the system calling it sheer).
  document.getElementById('summary-sub').textContent=
    `${pass} of ${t} steps looked great`+(styleName?` · Style: ${styleName}`:'')+foundNote;
  document.getElementById('summary-overall').textContent=pass===t?'Flawless finish! Your Soft and Natural look is complete.':pass>=t/2?'Great effort! A little more blending and it will be perfect.':'Keep practicing! The guide is here whenever you need it.';
  goTo('screen-summary');
}

// ─────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────
function hexToRgba(hex,a){if(!hex||hex.length<7)return`rgba(200,120,120,${a})`;return`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;}

document.addEventListener('DOMContentLoaded',()=>{loadData();initParticles();initTMModels();});

// ─────────────────────────────────────────
//  VIRTUAL TRY-ON
// ─────────────────────────────────────────
let _toMesh=null, _toStream=null, _toRaf=null, _toLastLm=null, _toStepOnly=null;

// Pre-warms FaceMesh so the wasm model downloads while the user reads
// the shades screen - eliminates lag on first TRY IT ON tap.
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
  if(_toStream){ _toStream.getTracks().forEach(t=>t.stop()); _toStream=null; }
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

  navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}})
  .then(stream=>{
    _toStream=stream;
    video.srcObject=stream;
    return video.play();
  })
  .then(()=>{
    if(loading) loading.style.display='none';
    const canvas=document.getElementById('tryon-canvas');
    let sending=false, fc=0;
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
      if(!sending && fc++%3===0){
        sending=true;
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
  if(_toStream){_toStream.getTracks().forEach(t=>t.stop()); _toStream=null;}
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

// ─────────────────────────────────────────
//  VIRTUAL MAKEUP RENDERER
//  Render order (back→front): contour →
//  blush → eyebrows → lips
// ─────────────────────────────────────────
function drawVirtualMakeup(ctx, lm, W, H, opts) {
  // opts.style    - render a specific variation (reference guide previews);
  //                 omit to use the one the user selected.
  // opts.stepOnly - render only this step (per-step try-on preview).
  const o = opts || {};
  const style = ('style' in o) ? o.style : STATE.style;
  const stepOnly = ('stepOnly' in o) ? o.stepOnly : _toStepOnly;

  const tone=resolveShades(STATE.toneKey||'medium_warm', style);
  if(!tone) return;

  function rgb(hex){
    if(!hex||hex.length<7) return {r:200,g:120,b:120};
    return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
  }

  // Overall face-on factor. The 2D filter only lines up on a fairly frontal,
  // level face; past that it smears across the cheeks/lips. Fade the WHOLE
  // filter out as the head turns or tilts so it never renders a mismatched
  // mess — better to show less makeup than makeup in the wrong place.
  const _clamp=v=>Math.min(1,Math.max(0,v));
  const _off = Math.abs((lm[1].x-lm[234].x)/((lm[454].x-lm[234].x)||0.001) - 0.5);
  const _roll = Math.abs(lm[234].y-lm[454].y)/((Math.abs(lm[234].x-lm[454].x))||0.001);
  const faceOn = _clamp(1 - Math.max(0,(_off-0.14))/0.20 - Math.max(0,(_roll-0.18))/0.25);
  if (faceOn<=0.05) return;   // too turned/tilted to place makeup — draw nothing

  const styleMult = {};
  STEPS.forEach(s=>{ styleMult[s]=styleIntensity(s, style)*faceOn; });   // fade with pose
  const mult = stepOnly
    ? { lips:0, blush:0, eyebrows:0, contour:0, [stepOnly]: styleMult[stepOnly] }
    : styleMult;

  const faceW=Math.abs(lm[234].x-lm[454].x)*W;
  const faceH=Math.abs(lm[10].y -lm[152].y)*H;
  const faceRef=Math.max(faceW,faceH*0.80);
  const nosePx=lm[1].x*W, nosePy=lm[1].y*H;

  // Per-side visibility from the nose-to-ear ratio. When the head turns, one
  // cheek recedes and its landmarks bunch together - without this, the fixed
  // shadow blob concentrates there into an unblended dark patch. Scaling each
  // side's makeup by how face-on it is keeps the filter matched to the face.
  const clamp01=v=>Math.min(1,Math.max(0,v));
  const noseRatio=(lm[1].x-lm[234].x)/((lm[454].x-lm[234].x)||0.001);
  const visL=clamp01((noseRatio-0.12)/0.22);   // 234 side
  const visR=clamp01((0.88-noseRatio)/0.22);   // 454 side

  // ── Contour: cheek hollows + jaw sides + nose sides ──────────
  // Uses pure radial-gradient blobs (no ctx.filter - reliable cross-browser).
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

  // ── Blush: tilted ellipse along the cheekbone (per-side vis) ──
  // Clipped to the face silhouette. Without a clip, the ellipse crosses the
  // jaw/temple edge on a turned face and the coloured halo sits on the dark
  // background, which reads as a bright outline extending past the cheek.
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
      // Tightened: was 0.26/0.15 which crossed the jaw edge on many frames.
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
    const lc=document.createElement('canvas'); lc.width=W; lc.height=H;
    const lx=lc.getContext('2d');
    lx.filter='blur(1px)';
    lx.fillStyle=`rgb(${r},${g},${b})`;
    // Outer lip pulled 4% toward its centre so imperfect landmarks on a close /
    // blurry frame keep the colour inside the lip line instead of bleeding onto
    // the surrounding skin.
    const outerRaw=lmPts(lm,LIP_OUTER_LOOP,W,H);
    const ocx=outerRaw.reduce((s,p)=>s+p.x,0)/outerRaw.length;
    const ocy=outerRaw.reduce((s,p)=>s+p.y,0)/outerRaw.length;
    const outerPts=outerRaw.map(p=>({x:ocx+(p.x-ocx)*0.96, y:ocy+(p.y-ocy)*0.96}));
    lx.beginPath(); softPolyPath(lx,outerPts); lx.fill();

    // Inner punch-out, pulled 18% toward the mouth centre so it removes only
    // the mouth opening and never eats into the coloured lip surface - this
    // was the cause of a chunk of colour looking "missing".
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

    // Two-pass compositing so no part of the lip ever looks uncoloured:
    //   1) a base tint (source-over) guarantees visible colour everywhere,
    //      even on lip areas in shadow where multiply alone washes out;
    //   2) a multiply pass on top restores natural depth and lip texture.
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
