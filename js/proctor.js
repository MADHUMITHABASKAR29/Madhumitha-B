// ═══════════════════════════════════════════════════════════════════
//  proctor.js  —  SecureExam v2 Proctoring Engine
//  Engine: MediaPipe FaceMesh (468 3D landmarks, WASM backend)
//  Low-light fix: Real-time canvas brightness/contrast boost
//  Low-webcam fix: Adaptive thresholds + frame-smoothing
// ═══════════════════════════════════════════════════════════════════

const Proctor = (() => {

  // ── Configuration ────────────────────────────────────────────────
  const CFG = {
    // MediaPipe options — maxFaces=1 for speed, refine for iris
    maxNumFaces         : 2,
    refineLandmarks     : true,          // enables iris landmarks (468→478 pts)
    minDetectionConf    : 0.35,          // lower = catches dark/blurry faces
    minTrackingConf     : 0.25,

    // Preprocessing for low-light / bad webcam
    brightness          : 1.7,           // canvas filter brightness multiplier
    contrast            : 1.4,           // canvas filter contrast multiplier
    sharpen             : true,          // apply unsharp-mask kernel

    // Thresholds
    headYawLimit        : 0.32,          // radians approx, flag if exceeded
    headPitchLimit      : 0.28,
    gazeDeviationLimit  : 0.22,          // normalised iris deviation
    noiseThresholdDb    : 60,
    alertCooldownMs     : 9000,

    // Anti-spam: require N consecutive bad frames before alerting
    streakNeeded        : 6,

    // Timing
    detectionFps        : 10,            // target frames per second for detection
  };

  // ── State ────────────────────────────────────────────────────────
  let faceMesh    = null;
  let video       = null;
  let overlayCanvas = null;
  let overlayCtx  = null;
  let offCanvas   = null;     // hidden canvas for preprocessing
  let offCtx      = null;
  let sharpenCvs  = null;
  let sharpenCtx  = null;

  let running     = false;
  let rafId       = null;
  let lastDetTime = 0;
  let detInterval = 1000 / CFG.detectionFps;

  let noiseLoop   = null;
  let audioCtx    = null;
  let analyser    = null;
  let callbacks   = {};

  // Rolling streak counters (consecutive bad frames)
  const streak = {
    noFace    : 0,
    headTurn  : 0,
    gazeAway  : 0,
    multiFace : 0,
  };

  const counts = {
    lookAway  : 0,
    noFace    : 0,
    multiFace : 0,
    noise     : 0,
    headTurn  : 0,
    talking   : 0,
  };

  const lastAlertTs = {};
  let startedAt     = 0;
  const WARMUP_MS   = 3500;

  // ── Helpers ──────────────────────────────────────────────────────
  const canAlert = key => {
    const now = Date.now();
    if (!lastAlertTs[key] || now - lastAlertTs[key] > CFG.alertCooldownMs) {
      lastAlertTs[key] = now; return true;
    }
    return false;
  };

  const emit = (ev, data) => { if (callbacks[ev]) callbacks[ev](data); };

  const warmingUp = () => Date.now() - startedAt < WARMUP_MS;

  // ── Preprocessing ─────────────────────────────────────────────────
  // Returns an ImageBitmap-like source that MediaPipe can consume,
  // after applying brightness, contrast, and optional sharpening.
  function preprocess() {
    const w = video.videoWidth  || 640;
    const h = video.videoHeight || 480;

    offCanvas.width  = w;
    offCanvas.height = h;

    // Step 1: brightness + contrast via CSS filter
    offCtx.filter = `brightness(${CFG.brightness}) contrast(${CFG.contrast})`;
    offCtx.drawImage(video, 0, 0, w, h);
    offCtx.filter = 'none';

    if (!CFG.sharpen) return offCanvas;

    // Step 2: simple unsharp-mask (3×3 laplacian-like kernel)
    // — sharpens blurry webcam output so edge features are clearer
    sharpenCvs.width  = w;
    sharpenCvs.height = h;
    sharpenCtx.drawImage(offCanvas, 0, 0);

    const imgData = sharpenCtx.getImageData(0, 0, w, h);
    const d = imgData.data;

    // Convolution kernel: sharpen
    // [ 0, -1,  0 ]
    // [-1,  5, -1 ]
    // [ 0, -1,  0 ]
    const copy = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const val =
            5 * copy[i + c]
            - copy[((y-1)*w + x) * 4 + c]
            - copy[((y+1)*w + x) * 4 + c]
            - copy[(y*w + (x-1)) * 4 + c]
            - copy[(y*w + (x+1)) * 4 + c];
          d[i + c] = Math.max(0, Math.min(255, val));
        }
      }
    }
    sharpenCtx.putImageData(imgData, 0, 0);
    return sharpenCvs;
  }

  // ── Lighting analysis ─────────────────────────────────────────────
  function measureBrightness() {
    const w = 80, h = 60;
    offCanvas.width  = w;
    offCanvas.height = h;
    offCtx.drawImage(video, 0, 0, w, h);
    const d = offCtx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4)
      sum += 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    return sum / (w * h);   // 0–255
  }

  // ── Head Pose from MediaPipe 468-point mesh ───────────────────────
  // Uses 6 stable anchor points to estimate yaw, pitch, roll
  function estimateHeadPose(lm) {
    // Indices: nose tip=1, chin=152, left eye corner=33,
    //          right eye corner=263, left mouth=61, right mouth=291
    const nose   = lm[1];
    const chin   = lm[152];
    const lEye   = lm[33];
    const rEye   = lm[263];
    const lMouth = lm[61];
    const rMouth = lm[291];

    // Yaw: horizontal eye-nose relationship
    const eyeMidX   = (lEye.x + rEye.x) / 2;
    const eyeWidth  = Math.abs(rEye.x - lEye.x);
    const yaw       = eyeWidth > 0.001 ? (nose.x - eyeMidX) / eyeWidth : 0;

    // Pitch: vertical nose-vs-chin relationship
    const faceH   = Math.abs(chin.y - lm[10].y); // forehead to chin
    const noseMid = (lEye.y + rEye.y) / 2;
    const pitch   = faceH > 0.001 ? ((nose.y - noseMid) / faceH - 0.38) * 2.5 : 0;

    // Roll: eye tilt
    const roll = eyeWidth > 0.001 ? (rEye.y - lEye.y) / eyeWidth : 0;

    return { yaw, pitch, roll };
  }

  // ── Gaze from iris landmarks (refined=true gives pts 468-477) ────
  function estimateGaze(lm) {
    if (lm.length < 478) {
      // Fallback: use eye centre vs face centre
      const lEye = lm[33], rEye = lm[263];
      const nose  = lm[1];
      const eyeMidX = (lEye.x + rEye.x) / 2;
      const dev = nose.x - eyeMidX;
      return { gazeX: dev * 3, gazeY: 0, method: 'fallback' };
    }

    // Left iris centre = average of pts 468–472
    // Right iris centre = average of pts 473–477
    const liris = lm.slice(468, 473);
    const riris = lm.slice(473, 478);

    const lirisC = {
      x: liris.reduce((s,p)=>s+p.x,0)/5,
      y: liris.reduce((s,p)=>s+p.y,0)/5,
    };
    const ririsC = {
      x: riris.reduce((s,p)=>s+p.x,0)/5,
      y: riris.reduce((s,p)=>s+p.y,0)/5,
    };

    // Eye corners
    const lEyeL = lm[33],  lEyeR = lm[133];
    const rEyeL = lm[362], rEyeR = lm[263];

    // Iris position within eye socket (0=far left, 1=far right)
    const lEyeW = Math.abs(lEyeR.x - lEyeL.x);
    const rEyeW = Math.abs(rEyeR.x - rEyeL.x);

    const lGaze = lEyeW > 0.001 ? (lirisC.x - lEyeL.x) / lEyeW - 0.5 : 0;
    const rGaze = rEyeW > 0.001 ? (ririsC.x - rEyeL.x) / rEyeW - 0.5 : 0;

    const gazeX = (lGaze + rGaze) / 2;
    const gazeY = (lirisC.y + ririsC.y) / 2 - (lm[33].y + lm[263].y) / 2;

    return { gazeX, gazeY, method: 'iris' };
  }

  // ── Draw overlay ──────────────────────────────────────────────────
  const MESH_CONNECTIONS = [
    // Jawline
    [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],
    [454,323],[323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],
    [400,377],[377,152],[152,148],[148,176],[176,149],[149,150],[150,136],[136,172],
    [172,58],[58,132],[132,93],[93,234],[234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10],
    // Left eye
    [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],
    [33,246],[246,161],[161,160],[160,159],[159,158],[158,157],[157,173],[173,133],
    // Right eye
    [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],
    [362,398],[398,384],[384,385],[385,386],[386,387],[387,388],[388,466],[466,263],
    // Nose
    [1,2],[2,98],[98,97],[97,2],[2,326],[326,327],[327,2],
    // Lips
    [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],
    [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],[375,291],
  ];

  function drawOverlay(multiFaceLandmarks) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!multiFaceLandmarks || !multiFaceLandmarks.length) return;

    const W = overlayCanvas.width;
    const H = overlayCanvas.height;

    multiFaceLandmarks.forEach((lm, fi) => {
      const primary = fi === 0;
      const baseColor = primary ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)';
      const dotColor  = primary ? 'rgba(59,130,246,0.5)' : 'rgba(239,68,68,0.5)';

      // Draw mesh connections
      overlayCtx.strokeStyle = baseColor;
      overlayCtx.lineWidth   = 0.8;
      for (const [a, b] of MESH_CONNECTIONS) {
        if (!lm[a] || !lm[b]) continue;
        overlayCtx.beginPath();
        overlayCtx.moveTo(lm[a].x * W, lm[a].y * H);
        overlayCtx.lineTo(lm[b].x * W, lm[b].y * H);
        overlayCtx.stroke();
      }

      // Draw landmark dots (subsample to avoid clutter)
      overlayCtx.fillStyle = dotColor;
      for (let i = 0; i < lm.length; i += 4) {
        overlayCtx.beginPath();
        overlayCtx.arc(lm[i].x * W, lm[i].y * H, 1.2, 0, Math.PI * 2);
        overlayCtx.fill();
      }

      // Draw iris circles if refined
      if (lm.length >= 478) {
        const iris = (start, end) => {
          const pts = lm.slice(start, end);
          const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length * W;
          const cy = pts.reduce((s,p)=>s+p.y,0)/pts.length * H;
          const r  = Math.abs(pts[0].x - pts[2].x) * W * 0.5;
          overlayCtx.strokeStyle = 'rgba(6,182,212,0.8)';
          overlayCtx.lineWidth   = 1.5;
          overlayCtx.beginPath();
          overlayCtx.arc(cx, cy, r || 4, 0, Math.PI * 2);
          overlayCtx.stroke();
        };
        iris(468, 473);
        iris(473, 478);
      }

      // Multi-face warning label
      if (!primary) {
        const nose = lm[1];
        overlayCtx.fillStyle = '#ef4444';
        overlayCtx.font      = 'bold 12px monospace';
        overlayCtx.fillText('⚠ EXTRA FACE', nose.x * W - 40, nose.y * H - 20);
      }
    });
  }

  // ── Detection callback (called by MediaPipe on each frame) ────────
  function onResults(results) {
    const lmList = results.multiFaceLandmarks || [];

    // Sync canvas to video display size
    const rect = video.getBoundingClientRect();
    if (rect.width > 0 && overlayCanvas.width !== Math.round(rect.width)) {
      overlayCanvas.width  = Math.round(rect.width);
      overlayCanvas.height = Math.round(rect.height);
    }

    drawOverlay(lmList);

    // ── No face ────────────────────────────────────────────────────
    if (lmList.length === 0) {
      streak.noFace++;
      emit('faceStatus', { count: 0 });
      emit('badge', { face: streak.noFace > 3 ? 'danger' : 'warn' });
      emit('lmCount', 0);
      if (!warmingUp() && streak.noFace >= CFG.streakNeeded && canAlert('noFace')) {
        counts.noFace++;
        emit('violation', { type:'noFace', level:'danger',
          msg:'No face detected! Please keep your face visible to the camera.' });
      }
      return;
    }

    streak.noFace = 0;
    emit('lmCount', lmList[0].length);

    // ── Multiple faces ─────────────────────────────────────────────
    if (lmList.length > 1) {
      streak.multiFace++;
      emit('faceStatus', { count: lmList.length });
      if (streak.multiFace >= CFG.streakNeeded && canAlert('multiFace')) {
        counts.multiFace++;
        emit('violation', { type:'multiFace', level:'danger',
          msg:`${lmList.length} faces detected in frame! Only the candidate is allowed.` });
      }
      emit('badge', { face:'danger' });
    } else {
      streak.multiFace = 0;
      emit('faceStatus', { count: 1 });
      emit('badge', { face:'ok' });
    }

    const lm = lmList[0];

    // ── Head Pose ──────────────────────────────────────────────────
    const pose = estimateHeadPose(lm);
    const headBad = Math.abs(pose.yaw) > CFG.headYawLimit || Math.abs(pose.pitch) > CFG.headPitchLimit;

    if (headBad) {
      streak.headTurn++;
      emit('badge', { head:'warn' });
      if (streak.headTurn >= CFG.streakNeeded && canAlert('headTurn')) {
        counts.headTurn++;
        const dir = Math.abs(pose.yaw) > Math.abs(pose.pitch)
          ? (pose.yaw > 0 ? 'left' : 'right')
          : (pose.pitch > 0 ? 'down' : 'up');
        emit('violation', { type:'headTurn', level:'warning',
          msg:`Head turned ${dir}. Please face the screen directly.` });
      }
    } else {
      streak.headTurn = 0;
      emit('badge', { head:'ok' });
    }

    // ── Gaze / Iris ────────────────────────────────────────────────
    const gaze = estimateGaze(lm);
    const gazeBad = Math.abs(gaze.gazeX) > CFG.gazeDeviationLimit ||
                    Math.abs(gaze.gazeY) > CFG.gazeDeviationLimit * 1.5;

    if (gazeBad) {
      streak.gazeAway++;
      emit('badge', { gaze:'warn' });
      if (streak.gazeAway >= CFG.streakNeeded && canAlert('gaze')) {
        counts.lookAway++;
        const dir = Math.abs(gaze.gazeX) > Math.abs(gaze.gazeY)
          ? (gaze.gazeX > 0 ? 'right' : 'left')
          : (gaze.gazeY > 0 ? 'down'  : 'up');
        emit('violation', { type:'gaze', level:'warning',
          msg:`Gaze directed ${dir} — please look at the screen.` });
      }
    } else {
      streak.gazeAway = 0;
      emit('badge', { gaze:'ok' });
    }

    // ── Talking / lip movement ─────────────────────────────────────
    // Distance between upper and lower lip centres
    const upperLip = lm[13];
    const lowerLip = lm[14];
    const lipDist  = Math.abs(lowerLip.y - upperLip.y);
    if (lipDist > 0.04 && canAlert('talking')) {
      counts.talking++;
      emit('violation', { type:'talking', level:'warning',
        msg:'Lip movement / talking detected during exam.' });
    }

    // ── Lighting check ─────────────────────────────────────────────
    const brightness = measureBrightness();
    emit('brightness', brightness);

    emit('status', { pose, gaze, counts, brightness });
  }

  // ── Render loop ────────────────────────────────────────────────────
  function renderLoop(now) {
    if (!running) return;
    rafId = requestAnimationFrame(renderLoop);

    if (now - lastDetTime < detInterval) return;
    if (video.readyState < 2) return;
    lastDetTime = now;

    // Send preprocessed frame to MediaPipe
    try {
      const src = preprocess();
      faceMesh.send({ image: src });
    } catch(e) {
      console.warn('[Proctor] send error:', e);
    }
  }

  // ── Noise Monitor ──────────────────────────────────────────────────
  async function startNoise(stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser  = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      noiseLoop = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a,b)=>a+b,0) / buf.length;
        const db  = Math.round(avg * 90 / 255);
        emit('noise', db);
        if (db > CFG.noiseThresholdDb && canAlert('noise')) {
          counts.noise++;
          emit('violation', { type:'noise', level:'warning',
            msg:`Excessive noise detected (${db} dB). Please stay quiet.` });
        }
      }, 200);
    } catch(e) {
      emit('log', { type:'info', msg:'Noise monitoring unavailable: ' + e.message });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────
  async function init(videoEl, canvasEl) {
    video         = videoEl;
    overlayCanvas = canvasEl;
    overlayCtx    = canvasEl.getContext('2d');

    // Hidden preprocessing canvases
    offCanvas = document.createElement('canvas');
    offCtx    = offCanvas.getContext('2d');
    offCanvas.style.display = 'none';
    document.body.appendChild(offCanvas);

    sharpenCvs = document.createElement('canvas');
    sharpenCtx = sharpenCvs.getContext('2d', { willReadFrequently: true });
    sharpenCvs.style.display = 'none';
    document.body.appendChild(sharpenCvs);
  }

  async function loadModels(onProgress) {
    onProgress(5, 'Initialising MediaPipe FaceMesh…');
    console.log('[Proctor] Creating FaceMesh...');

    faceMesh = new FaceMesh({
      locateFile: file => {
        console.log('[Proctor] Locating:', file);
        return `libs/mediapipe_fm_${file}`;
      }
    });

    faceMesh.setOptions({
      maxNumFaces      : CFG.maxNumFaces,
      refineLandmarks  : CFG.refineLandmarks,
      minDetectionConfidence : CFG.minDetectionConf,
      minTrackingConfidence  : CFG.minTrackingConf,
    });

    faceMesh.onResults(onResults);

    onProgress(40, 'Loading FaceMesh WASM model…');

    // Warm up by sending a blank frame — this forces WASM compilation
    const dummy = document.createElement('canvas');
    dummy.width = dummy.height = 64;
    dummy.getContext('2d').fillRect(0, 0, 64, 64);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Model warm-up timeout')), 30000);
      faceMesh.onResults(() => { clearTimeout(timeout); resolve(); });
      faceMesh.send({ image: dummy }).catch(reject);
    });

    // Restore real callback
    faceMesh.onResults(onResults);

    onProgress(100, 'MediaPipe ready! Starting camera…');
    console.log('[Proctor] FaceMesh ready ✓');
  }

  async function start(stream) {
    video.srcObject = stream;
    await new Promise(r => {
      video.onloadedmetadata = () => video.play().then(r).catch(r);
    });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    overlayCanvas.width  = video.videoWidth  || 320;
    overlayCanvas.height = video.videoHeight || 240;
    console.log('[Proctor] Video:', overlayCanvas.width + 'x' + overlayCanvas.height);

    startedAt = Date.now();
    running   = true;
    await startNoise(stream);
    requestAnimationFrame(renderLoop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    clearInterval(noiseLoop);
    if (audioCtx) audioCtx.close();
    if (faceMesh) faceMesh.close();
    [offCanvas, sharpenCvs].forEach(c => c?.parentNode?.removeChild(c));
    if (video?.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
  }

  function on(ev, fn)  { callbacks[ev] = fn; }
  function getCounts() { return { ...counts }; }

  return { init, loadModels, start, stop, on, getCounts };
})();
