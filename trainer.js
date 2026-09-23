// ═════════════════════════════════════════
//  MODEL TRAINER + EVALUATION  (trainer.html?slot=…)
//
//  Transfer learning in the browser, the recipe Teachable Machine uses: a
//  frozen MobileNetV2 (alpha 0.35) turns each crop into 1280 numbers, and a
//  small dense head learns the labels from those numbers. The finished model
//  (MobileNet + head, 224x224 input scaled to [-1,1]) matches the contract of
//  the app slot it is installed into:
//
//    glasses    face crop      softmax ['glasses','no_glasses']     TM_MODELS.glasses
//    occlusion  face crop      softmax ['covered','clear']          TM_MODELS.occlusion
//    quality    makeup zone    sigmoid QUALITY_CLASSES              QUALITY_MODEL_URL
//
//  Crops come from the app's own functions (faceCropCanvas, zoneShapes +
//  shapesBBox), so a model is trained on exactly what the app shows it.
//
//  Evaluation: samples recorded into the TEST set are also judged, at record
//  time, by the app's production heuristics (checkAccessories, occlusionCheck,
//  analyzeQualityHeuristic - app.js is loaded as a library). Both are then
//  scored against the true labels on the same samples.
// ═════════════════════════════════════════
(()=>{
const BASE_URL='https://storage.googleapis.com/teachable-machine-models/mobilenet_v2_weights_tf_dim_ordering_tf_kernels_0.35_224_no_top/model.json';
const INPUT=224, SAMPLE_MS=180, EPOCHS=40;
const STEP_NAMES={lips:'Lips', blush:'Blush', eyebrows:'Eyebrows', contour:'Contour'};

const SLOTS = {
  glasses:{
    title:'Glasses Detection', folder:'models/glasses/', fileUrl:TM_MODELS.glasses.url,
    labels:['glasses','no_glasses'], names:['Wearing glasses','No glasses'],
    positive:'glasses', threshold:0.6, min:40, good:150,
    turnMax:TURN_OK_ACCESSORY,
    tips:'Tap a button to record and tap again to stop. Record several people, moving slightly and changing distance. '
        +'<b>Glasses:</b> different frames, clear lenses, thin metal rims. '
        +'<b>No glasses:</b> dark eyebrows, bangs, deep-set eyes.',
    heuristic:(img,lm)=>({glasses:checkAccessories(img,lm).includes('glasses')}),
  },
  occlusion:{
    title:'Face Covered Detection', folder:'models/occlusion/', fileUrl:TM_MODELS.occlusion.url,
    labels:['covered','clear'], names:['Face covered','Face clear'],
    positive:'covered', threshold:0.6, min:40, good:150,
    turnMax:TURN_OK_CAPTURE,
    tips:'<b>Covered:</b> a hand on the cheek or mouth, a face mask, hair across the face, a phone or cup in front. '
        +'<b>Clear:</b> the whole face visible, including under uneven light, since shadows fooled the old check.',
    heuristic:(img,lm)=>({covered:occlusionCheck(img,lm).occluded}),
  },
  quality:{
    title:'Makeup Quality', folder:'models/application-quality/', fileUrl:QUALITY_MODEL_URL,
    labels:QUALITY_CLASSES, multi:true, threshold:0.5, min:40, good:200,
    names:{good:'Good', smudged:'Smudged', uneven:'Uneven', amount:'Too much / too little'},
    turnMax:0.22,
    tips:'Choose the makeup step and what is true of it right now, then record while moving slightly. '
        +'<b>Good</b> excludes the others; the problems can be combined. Record with your real products, and include '
        +'a bare face as <b>Too much / too little</b>.',
    heuristic:(img,lm,video,step)=>{
      const q=analyzeQualityHeuristic(video,lm,step);
      return { smudged:q.issues.includes('smudged'), uneven:q.issues.includes('uneven'),
               amount:q.issues.includes('too little')||q.issues.includes('too much') };
    },
  },
};

const slotName=(new URLSearchParams(location.search).get('slot')||'glasses').toLowerCase();
const S=SLOTS[slotName]||SLOTS.glasses;
const SLOT=SLOTS[slotName]?slotName:'glasses';
const NL=S.labels.length;
const posIdx=S.multi?-1:S.labels.indexOf(S.positive);

const T = {
  stream:null, mesh:null, busy:false, lastT:-1,
  recording:false, recClass:-1, mode:'train', lastSample:0, working:false,
  step:'lips', qLabels:new Set(['good']),
  train:[], test:[],          // {y, group, step, emb, flip} (+ heur, inst for test)
  embed:null, dim:0, head:null, full:null, installed:null, frame:0,
  crop:document.createElement('canvas'), results:null,
};
const $=id=>document.getElementById(id);

// ── Setup ───────────────────────────────
async function loadBase() {
  const mobilenet=await tf.loadLayersModel(BASE_URL);
  const trunc=tf.model({inputs:mobilenet.inputs, outputs:mobilenet.getLayer('out_relu').output});
  T.embed=tf.sequential();
  T.embed.add(trunc);
  T.embed.add(tf.layers.globalAveragePooling2d({}));
  T.dim=T.embed.outputs[0].shape[1];
  tf.tidy(()=>T.embed.predict(tf.zeros([1,INPUT,INPUT,3])));
  $('tg-train-status').textContent='Base model ready. Record samples, then train.';
  refreshUi();
}

// The model the app would use right now (this browser first, then the folder),
// so the test set can score it even before anything is trained in this session.
async function loadInstalled() {
  for (const url of [localModelKey(SLOT), S.fileUrl]){
    try {
      const m=await tf.loadLayersModel(url);
      let labels=S.labels;
      if (!S.multi){
        if (url===S.fileUrl){
          const meta=await fetch(url.replace(/model\.json$/,'metadata.json')).then(r=>r.ok?r.json():null).catch(()=>null);
          labels=meta?.labels||labels;
        } else {
          try { labels=JSON.parse(localStorage.getItem(localLabelsKey(SLOT))||'null')||labels; } catch(_){}
        }
      }
      T.installed={m, labels, where:url===S.fileUrl?S.folder:'this browser'};
      refreshUi();
      return;
    } catch(_){}
  }
}

async function startCamera() {
  try {
    T.stream=await navigator.mediaDevices.getUserMedia({video:{
      width:{ideal:640}, height:{ideal:480}, facingMode:'user', frameRate:{ideal:30}}});
  } catch(e){ $('tg-status').textContent='Camera unavailable - allow camera access and reload.'; return; }
  const video=$('tg-video');
  video.srcObject=T.stream;
  T.mesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`});
  T.mesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.6,minTrackingConfidence:.6});
  T.mesh.onResults(onResults);
  $('tg-status').textContent='Loading face tracking…';
  (function tick(){
    requestAnimationFrame(tick);
    if (T.busy || video.readyState<2 || video.currentTime===T.lastT) return;
    T.lastT=video.currentTime; T.busy=true;
    T.mesh.send({image:video}).catch(()=>{}).finally(()=>{ T.busy=false; });
  })();
}

// ── Crops ───────────────────────────────
function cropFor(image, lm, step) {
  if (!S.multi) return faceCropCanvas(image, lm, INPUT, T.crop);
  // Same box as analyzeQualityModel: the step's zone, padded 30%.
  const W=image.width||image.videoWidth||640, H=image.height||image.videoHeight||480;
  const box=shapesBBox(zoneShapes(lm,step,W,H), W, H, 0.30);
  if (!box) return null;
  T.crop.width=INPUT; T.crop.height=INPUT;
  T.crop.getContext('2d').drawImage(image, box.x,box.y,box.w,box.h, 0,0,INPUT,INPUT);
  return T.crop;
}
function cropBox(lm, W, H) {
  if (!S.multi){
    let x0=1,y0=1,x1=0,y1=0;
    [10,152,234,454].forEach(i=>{ const p=lm[i];
      x0=Math.min(x0,p.x); y0=Math.min(y0,p.y); x1=Math.max(x1,p.x); y1=Math.max(y1,p.y); });
    return {x:(x0-.18)*W, y:(y0-.18)*H, w:(x1-x0+.36)*W, h:(y1-y0+.36)*H};
  }
  return shapesBBox(zoneShapes(lm,T.step,W,H), W, H, 0.30);
}
const toInput=c=>tf.browser.fromPixels(c).toFloat().div(127.5).sub(1);

// ── Frames ──────────────────────────────
function onResults(results) {
  const canvas=$('tg-overlay'), video=$('tg-video');
  const r=video.getBoundingClientRect();
  canvas.width=Math.round(r.width); canvas.height=Math.round(r.height);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const lm=results.multiFaceLandmarks?.[0];
  if (!lm){ $('tg-status').textContent='No face - step into view'; showLive(null); return; }

  const frontal=faceTurnOffset(lm)<=S.turnMax;
  drawBox(ctx, lm, video, canvas, frontal);

  if (T.recording){
    if (!frontal) $('tg-status').textContent='Face the mirror a little more - not recording this angle';
    else {
      $('tg-status').textContent=`Recording into the ${T.mode==='test'?'TEST':'training'} set: ${currentLabelText()}`;
      const now=performance.now();
      if (now-T.lastSample>=SAMPLE_MS && !T.working){
        T.lastSample=now;
        addSample(results.image, lm, video);
      }
    }
  } else $('tg-status').textContent=frontal?'Face found ✓':'Face the mirror a little more';

  if (T.full && frontal && (T.frame++%4===0)){
    const crop=cropFor(results.image, lm, T.step);
    if (crop) showLive(tf.tidy(()=>Array.from(T.full.predict(toInput(crop).expandDims(0)).dataSync())));
  } else if (T.full && !frontal) showLive(null);
}

// Drawn in the video's cover-fit space; the canvas is CSS-mirrored like the video.
function drawBox(ctx, lm, video, canvas, ok) {
  const vW=video.videoWidth||640, vH=video.videoHeight||480;
  const sc=Math.max(canvas.width/vW, canvas.height/vH);
  const ox=(vW*sc-canvas.width)/2, oy=(vH*sc-canvas.height)/2;
  const b=cropBox(lm, vW, vH); if (!b) return;
  const rec=T.recording&&ok;
  ctx.strokeStyle=rec ? (T.mode==='test'?'#7a3cff':'#ff0a7a') : ok ? 'rgba(255,255,255,.9)' : 'rgba(255,190,60,.9)';
  ctx.lineWidth=rec?5:3;
  ctx.strokeRect(b.x*sc-ox, b.y*sc-oy, b.w*sc, b.h*sc);
}

// Label vector for the sample being recorded now.
function currentY() {
  if (!S.multi) return S.labels.map((_,i)=>i===T.recClass?1:0);
  return S.labels.map(l=>T.qLabels.has(l)?1:0);
}
function currentLabelText() {
  if (!S.multi) return S.names[T.recClass];
  return `${STEP_NAMES[T.step]} - ${[...T.qLabels].map(l=>S.names[l]).join(' + ')}`;
}

// Stores the crop's feature vector and its mirror image (free augmentation).
// Test samples are also judged by the heuristic and the installed model NOW,
// while the frame's pixels exist - no image is kept afterwards.
async function addSample(image, lm, video) {
  if (!T.embed) return;
  const step=T.step, y=currentY();
  const crop=cropFor(image, lm, step);
  if (!crop) return;
  T.working=true;
  try {
    const out=tf.tidy(()=>{ const x=toInput(crop); return T.embed.predict(tf.stack([x, x.reverse(1)])); });
    let inst=null;
    if (T.mode==='test' && T.installed){
      inst=tf.tidy(()=>Array.from(T.installed.m.predict(toInput(crop).expandDims(0)).dataSync()));
      if (!S.multi){                    // re-order to this slot's label order
        const p=inst[positiveLabelIndex(T.installed.labels, S.positive)];
        inst=S.labels.map((_,i)=>i===posIdx?p:1-p);
      }
    }
    let heur=null;
    if (T.mode==='test'){ try { heur=S.heuristic(image, lm, video, step); } catch(_){ heur=null; } }
    const d=await out.data(); out.dispose();
    const s={y, step, group:`${step}|${y.join('')}`, emb:d.slice(0,T.dim), flip:d.slice(T.dim)};
    if (T.mode==='test'){ s.heur=heur; s.inst=inst; T.test.push(s); }
    else T.train.push(s);
  } finally { T.working=false; }
  refreshUi();
}

// ── Recording controls ──────────────────
function buildControls() {
  $('tg-title').textContent=S.title;
  document.querySelectorAll('#tg-tabs a').forEach(a=>
    a.classList.toggle('on', a.getAttribute('href')===`?slot=${SLOT}`));
  $('tg-tips').innerHTML=S.tips;
  const row=$('tg-rec-row');
  if (!S.multi){
    row.innerHTML=S.names.map((n,i)=>
      `<button class="tg-rec" data-cls="${i}"><span class="tg-rec-label">${n}</span><span class="tg-count" id="tg-count-${i}">0</span></button>`).join('');
    row.querySelectorAll('.tg-rec').forEach(b=>b.onclick=()=>toggleRecording(+b.dataset.cls));
  } else {
    $('tg-quality-controls').hidden=false;
    $('tg-step-row').innerHTML=Object.entries(STEP_NAMES).map(([k,n])=>
      `<button class="tg-chip" data-step="${k}">${n}</button>`).join('');
    $('tg-label-row').innerHTML=S.labels.map(l=>
      `<button class="tg-chip" data-label="${l}">${S.names[l]}</button>`).join('');
    $('tg-step-row').querySelectorAll('.tg-chip').forEach(b=>b.onclick=()=>{ T.step=b.dataset.step; refreshUi(); });
    $('tg-label-row').querySelectorAll('.tg-chip').forEach(b=>b.onclick=()=>{
      const l=b.dataset.label;
      if (l==='good') T.qLabels=new Set(['good']);
      else {
        T.qLabels.delete('good');
        T.qLabels.has(l) ? T.qLabels.delete(l) : T.qLabels.add(l);
        if (!T.qLabels.size) T.qLabels.add('good');
      }
      refreshUi();
    });
    row.innerHTML=`<button class="tg-rec" data-cls="0"><span class="tg-rec-label">Record</span><span class="tg-count" id="tg-count-q">0</span></button>`;
    row.querySelector('.tg-rec').onclick=()=>toggleRecording(0);
  }
  $('tg-mode-train').onclick=()=>setMode('train');
  $('tg-mode-test').onclick=()=>setMode('test');
}

function toggleRecording(cls) {
  const same=T.recording && T.recClass===cls;
  T.recording=!same; T.recClass=same?-1:cls;
  refreshUi();
}
function stopRecording(){ T.recording=false; T.recClass=-1; refreshUi(); }
function setMode(m){ T.mode=m; stopRecording(); }

const positives=(list,i)=>list.reduce((n,s)=>n+s.y[i],0);

function refreshUi() {
  // Recording buttons / chips
  document.querySelectorAll('#tg-rec-row .tg-rec').forEach(b=>
    b.classList.toggle('on', T.recording && T.recClass===+b.dataset.cls));
  document.querySelectorAll('#tg-rec-row .tg-rec').forEach(b=>b.classList.toggle('test', T.mode==='test'));
  $('tg-mode-train').classList.toggle('on', T.mode==='train');
  $('tg-mode-test').classList.toggle('on', T.mode==='test');
  $('tg-mode-note').textContent = T.mode==='test'
    ? 'TEST set: use people who were NOT recorded for training. These samples are only used to measure accuracy.'
    : 'Training set: these samples teach the model.';
  const list=T.mode==='test'?T.test:T.train;
  if (!S.multi){
    S.labels.forEach((_,i)=>{ const el=$(`tg-count-${i}`); if (el) el.textContent=positives(list,i); });
  } else {
    document.querySelectorAll('#tg-step-row .tg-chip').forEach(b=>b.classList.toggle('on', b.dataset.step===T.step));
    document.querySelectorAll('#tg-label-row .tg-chip').forEach(b=>b.classList.toggle('on', T.qLabels.has(b.dataset.label)));
    const el=$('tg-count-q'); if (el) el.textContent=list.length;
  }
  $('tg-counts').innerHTML = 'Training set: '
    + S.labels.map((l,i)=>`${S.multi?S.names[l]:S.names[i]} <b>${positives(T.train,i)}</b>`).join(' · ')
    + (S.multi ? '<br/>By step: '+Object.entries(STEP_NAMES).map(([k,n])=>`${n} ${T.train.filter(s=>s.step===k).length}`).join(' · ') : '');

  // Training readiness
  const counts=S.labels.map((_,i)=>positives(T.train,i));
  const enough=S.multi
    ? counts[0]>=S.min && counts.slice(1).some(c=>c>=20)
    : counts.every(c=>c>=S.min);
  $('tg-train').disabled=!enough || !T.embed || T.training;
  if (T.embed && !T.training && !T.full){
    $('tg-train-status').textContent = enough
      ? (Math.min(...(S.multi?[counts[0]]:counts))<S.good
          ? `Ready to train. ${S.good}+ per class from several people gives a more reliable model.`
          : 'Ready to train.')
      : S.multi
        ? `Need ${S.min}+ Good samples and 20+ of at least one problem to train.`
        : `Need at least ${S.min} of each to train (${S.good}+ recommended).`;
  }

  // Evaluation readiness
  const tn=T.test.length;
  $('tg-test-count').innerHTML = `Test set: <b>${tn}</b> samples`
    + (tn ? ' ('+S.labels.map((l,i)=>`${S.multi?S.names[l]:S.names[i]} ${positives(T.test,i)}`).join(' · ')+')' : '')
    + (T.head ? ' - scored against the model trained above.'
       : T.installed ? ` - scored against the installed model (${T.installed.where}).`
       : ' - train or install a model to compare it with the pixel rules.');
  $('tg-eval').disabled=!tn;
}

// ── Training ────────────────────────────
async function train() {
  stopRecording();
  T.training=true; refreshUi();
  const status=$('tg-train-status'), fill=$('tg-bar-fill');
  // Hold out the most recent 15% of every label group for validation.
  // Neighbouring frames are near-duplicates, so a random split would flatter
  // the score; the last recordings are usually a different person or pose.
  const groups={};
  T.train.forEach(s=>(groups[s.group]=groups[s.group]||[]).push(s));
  const tr=[], va=[];
  Object.values(groups).forEach(g=>{
    const cut=Math.max(1, Math.floor(g.length*0.85));
    g.forEach((s,i)=>(i<cut?tr:va).push(s));
  });
  const X=a=>tf.tensor2d(a.flatMap(s=>[...s.emb, ...s.flip]), [a.length*2, T.dim]);
  const Y=a=>tf.tensor2d(a.flatMap(s=>[...s.y, ...s.y]), [a.length*2, NL]);
  const xs=X(tr), ys=Y(tr);
  const val=va.length ? [X(va), Y(va)] : null;

  if (T.head) T.head.dispose();
  T.head=tf.sequential({layers:[
    tf.layers.dense({inputShape:[T.dim], units:64, activation:'relu',
                     kernelRegularizer:tf.regularizers.l2({l2:1e-3})}),
    tf.layers.dropout({rate:0.3}),
    tf.layers.dense({units:NL, activation:S.multi?'sigmoid':'softmax'}),
  ]});
  T.head.compile({optimizer:tf.train.adam(1e-3),
    loss:S.multi?'binaryCrossentropy':'categoricalCrossentropy', metrics:['accuracy']});
  const fitOpts={ epochs:EPOCHS, batchSize:32, shuffle:true,
    callbacks:{ onEpochEnd:(e)=>{
      fill.style.width=`${Math.round((e+1)/EPOCHS*100)}%`;
      status.textContent=`Training… epoch ${e+1}/${EPOCHS}`;
    }}};
  if (val) fitOpts.validationData=val;
  if (!S.multi){                              // balance uneven recordings
    const n=S.labels.map((_,i)=>positives(tr,i)), tot=n.reduce((a,b)=>a+b,0);
    fitOpts.classWeight=Object.fromEntries(n.map((c,i)=>[i, tot/(NL*Math.max(1,c))]));
  }
  await T.head.fit(xs, ys, fitOpts);

  // Held-out score, measured the same way the app decides.
  let msg='Done.';
  if (val){
    const probs=await T.head.predict(val[0]).array();
    const truth=va.flatMap(s=>[s.y, s.y]);
    msg+=' '+heldOutSummary(probs, truth);
  }
  tf.dispose([xs,ys,...(val||[])]);

  T.full=tf.sequential();
  T.full.add(T.embed);
  T.full.add(T.head);
  status.textContent=msg+' Test it live, then install.';
  T.training=false;
  $('tg-install').disabled=false; $('tg-download').disabled=false;
  refreshUi();
}

function heldOutSummary(probs, truth) {
  const tasks=evalTasks();
  return 'Held-out accuracy: '+tasks.map(t=>{
    let ok=0; probs.forEach((p,i)=>{ if (t.model(p)===t.truth(truth[i])) ok++; });
    return `${t.name} ${Math.round(ok/probs.length*100)}%`;
  }).join(' · ')+'.';
}

// ── Live readout ────────────────────────
function showLive(p) {
  const box=$('tg-live');
  if (!T.full){ box.innerHTML='<span class="tg-test-label">Train first</span>'; return; }
  if (!p){ box.innerHTML='<span class="tg-test-label">Face the mirror to test</span>'; return; }
  if (!S.multi){
    const pp=p[posIdx], hit=pp>=S.threshold;
    box.innerHTML=`<span class="tg-test-label">${hit?S.names[posIdx]:S.names[1-posIdx]} (${Math.round((hit?pp:1-pp)*100)}%)</span>`
      +`<div class="tg-bar tg-bar-lg"><i class="${hit?'hit':''}" style="width:${Math.round(pp*100)}%"></i></div>`;
  } else {
    box.innerHTML=`<span class="tg-test-label">${STEP_NAMES[T.step]}</span>`+S.labels.map((l,i)=>
      `<div class="tg-qrow"><span>${S.names[l]}</span><div class="tg-bar"><i class="${i>0&&p[i]>=S.threshold?'hit':''}" style="width:${Math.round(p[i]*100)}%"></i></div><b>${Math.round(p[i]*100)}%</b></div>`).join('');
  }
}

// ── Install / export ────────────────────
async function install() {
  const st=$('tg-install-status');
  try {
    await T.full.save(localModelKey(SLOT));
    localStorage.setItem(localLabelsKey(SLOT), JSON.stringify(S.labels));
    st.textContent='Installed ✓ The mirror uses this model from the next time the app loads.';
    loadInstalled();
  } catch(e){ st.textContent='Could not install: '+e.message; }
}

async function download() {
  await T.full.save('downloads://model');
  saveText('metadata.json', JSON.stringify({labels:S.labels, imageSize:INPUT, slot:SLOT,
    trainedWith:'trainer.html', date:new Date().toISOString()}, null, 2), 'application/json');
  $('tg-install-status').textContent=`Downloaded model.json, model.weights.bin and metadata.json. Put all three in ${S.folder} to use this model on other computers.`;
}

async function removeInstalled() {
  try { await tf.io.removeModel(localModelKey(SLOT)); } catch(_){}
  localStorage.removeItem(localLabelsKey(SLOT));
  T.installed=null;
  $('tg-install-status').textContent=`Removed. The app goes back to ${S.folder}, or to the built-in pixel rules.`;
  loadInstalled();
}

function saveText(name, text, type) {
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text], {type}));
  a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}

// ── Evaluation ──────────────────────────
// Each task is a yes/no question with a truth, a model and a heuristic answer.
function evalTasks() {
  if (!S.multi) return [{
    name:S.names[posIdx], key:S.positive,
    truth:y=>y[posIdx]===1,
    model:p=>p[posIdx]>=S.threshold,
    heur:h=>!!h[S.positive],
  }];
  const issue=(key,i)=>({ name:S.names[key], key,
    truth:y=>y[i]===1, model:p=>p[i]>=S.threshold, heur:h=>!!h[key] });
  return [
    issue('smudged',1), issue('uneven',2), issue('amount',3),
    { name:'Needs correction (any issue)', key:'any',
      truth:y=>y[0]===0,
      model:p=>p.slice(1).some(v=>v>=S.threshold),
      heur:h=>!!(h.smudged||h.uneven||h.amount) },
  ];
}

function scores(pairs) {
  let tp=0,fp=0,fn=0,tn=0;
  pairs.forEach(([t,p])=>{ if(t&&p)tp++; else if(!t&&p)fp++; else if(t&&!p)fn++; else tn++; });
  const n=pairs.length||1, prec=tp+fp?tp/(tp+fp):0, rec=tp+fn?tp/(tp+fn):0;
  return {n:pairs.length, tp,fp,fn,tn, acc:(tp+tn)/n, prec, rec, f1:prec+rec?2*prec*rec/(prec+rec):0};
}

async function modelProbsForTest() {
  if (T.head){
    const x=tf.tensor2d(T.test.flatMap(s=>[...s.emb]), [T.test.length, T.dim]);
    const p=await T.head.predict(x).array(); x.dispose();
    return {probs:p, source:'Model trained in this session'};
  }
  if (T.test.every(s=>s.inst)) return {probs:T.test.map(s=>s.inst), source:`Installed model (${T.installed?.where||'this browser'})`};
  return {probs:null, source:null};
}

async function evaluate() {
  const {probs, source}=await modelProbsForTest();
  const rows=[];
  evalTasks().forEach(t=>{
    const withHeur=T.test.filter(s=>s.heur);
    rows.push({task:t.name, method:'Pixel rules (current app)', ...scores(withHeur.map(s=>[t.truth(s.y), t.heur(s.heur)]))});
    if (probs) rows.push({task:t.name, method:source, ...scores(T.test.map((s,i)=>[t.truth(s.y), t.model(probs[i])]))});
  });
  T.lastEval={rows, probs, source};
  const pct=v=>`${Math.round(v*100)}%`;
  $('tg-results').innerHTML=`<table class="tg-table"><thead><tr><th>Task</th><th>Method</th><th>N</th><th>Accuracy</th><th>Precision</th><th>Recall</th><th>F1</th><th>TP / FP / FN / TN</th></tr></thead><tbody>`
    +rows.map(r=>`<tr><td>${r.task}</td><td>${r.method}</td><td>${r.n}</td><td><b>${pct(r.acc)}</b></td><td>${pct(r.prec)}</td><td>${pct(r.rec)}</td><td>${pct(r.f1)}</td><td>${r.tp} / ${r.fp} / ${r.fn} / ${r.tn}</td></tr>`).join('')
    +`</tbody></table>`
    +(probs?'':'<p class="tg-note">No model to compare yet - train one above, or install one, then record the test set again.</p>')
    +`<p class="tg-note">Precision: of the samples it flagged, how many were right. Recall: of the true cases, how many it caught.</p>`;
  $('tg-eval-csv').disabled=false;
}

function downloadCsv() {
  const E=T.lastEval; if (!E) return;
  const q=v=>`"${String(v).replace(/"/g,'""')}"`;
  const lines=['# Summary', 'task,method,n,accuracy,precision,recall,f1,tp,fp,fn,tn',
    ...E.rows.map(r=>[q(r.task),q(r.method),r.n,r.acc.toFixed(4),r.prec.toFixed(4),r.rec.toFixed(4),r.f1.toFixed(4),r.tp,r.fp,r.fn,r.tn].join(',')),
    '', '# Per sample',
    ['sample', ...(S.multi?['step']:[]), ...S.labels.map(l=>`truth_${l}`),
     ...evalTasks().filter(t=>t.key!=='any').map(t=>`rules_${t.key}`),
     ...S.labels.map(l=>`model_p_${l}`)].join(',')];
  T.test.forEach((s,i)=>{
    lines.push([i+1, ...(S.multi?[s.step]:[]), ...s.y,
      ...evalTasks().filter(t=>t.key!=='any').map(t=>s.heur?+t.heur(s.heur):''),
      ...(E.probs?E.probs[i].map(v=>v.toFixed(4)):S.labels.map(()=>''))].join(','));
  });
  saveText(`evaluation-${SLOT}-${new Date().toISOString().slice(0,10)}.csv`, lines.join('\n'), 'text/csv');
}

// ── Wire up ─────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  document.title=`${S.title} Trainer`;
  buildControls();
  $('tg-clear').onclick=()=>{ T.train=[]; stopRecording(); };
  $('tg-test-clear').onclick=()=>{ T.test=[]; T.lastEval=null; $('tg-results').innerHTML=''; $('tg-eval-csv').disabled=true; stopRecording(); };
  $('tg-train').onclick=train;
  $('tg-install').onclick=install;
  $('tg-download').onclick=download;
  $('tg-remove').onclick=removeInstalled;
  $('tg-eval').onclick=evaluate;
  $('tg-eval-csv').onclick=downloadCsv;
  refreshUi();
  loadBase().catch(e=>{ $('tg-train-status').textContent='Could not load the base model (needs internet): '+e.message; });
  loadInstalled();
  startCamera();
});

// Handle for automated testing only.
window.__trainer={T, S, addSample, train, evaluate, install, removeInstalled, cropFor, evalTasks, scores};
})();
