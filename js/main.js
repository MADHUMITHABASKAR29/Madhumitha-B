// js/main.js — SecureExam v2 App Logic

let currentQ       = 0;
let answers        = new Array(QUESTIONS.length).fill(null);
let logEntries     = [];
let timerInterval  = null;
let secondsLeft    = 59 * 60;
let examStartTime  = null;
let violationTotal = 0;
let candidate      = {};
let lastBrightness = 128;

// ── Screen helpers ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function setProgress(pct, msg, detail = '') {
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('load-msg').textContent      = msg;
  document.getElementById('load-detail').textContent   = detail;
}

// ── Start exam ────────────────────────────────────────────────────
async function startExam() {
  const name   = document.getElementById('candidate-name').value.trim();
  const examId = document.getElementById('exam-id').value.trim();
  if (!name || !examId) { alert('Please enter your name and Exam ID.'); return; }
  candidate = { name, examId };

  showScreen('loading-screen');

  try {
    setProgress(5, 'Requesting camera & microphone…', '');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width      : { ideal: 1280 },
        height     : { ideal: 720 },
        facingMode : 'user',
        frameRate  : { ideal: 30 },
      },
      audio: true,
    });

    setProgress(10, 'Camera ready. Loading AI model…', 'MediaPipe FaceMesh with 468 landmarks');

    const video  = document.getElementById('video');
    const canvas = document.getElementById('overlay');
    await Proctor.init(video, canvas);
    registerCallbacks();

    await Proctor.loadModels((pct, msg) => setProgress(pct, msg, ''));

    setProgress(100, 'Starting exam…', '');
    await Proctor.start(stream);

  } catch (e) {
    console.error(e);
    alert('Could not start proctoring:\n\n' + e.message +
      '\n\nMake sure:\n• You allow camera & microphone\n• You run via Live Server (not file://)');
    showScreen('setup-screen');
    return;
  }

  examStartTime = new Date();
  document.getElementById('tb-name').textContent = candidate.name;
  document.getElementById('tb-exam').textContent = candidate.examId;
  loadQuestion(0);
  buildDots();
  startTimer();
  showScreen('exam-screen');
  addLog('info', '🚀', 'Exam started — MediaPipe proctoring active');
}

// ── Proctor callbacks ─────────────────────────────────────────────
function registerCallbacks() {

  Proctor.on('violation', ({ type, level, msg }) => {
    violationTotal++;
    updateStats();
    updateRisk();
    addLog(level === 'danger' ? 'danger' : 'warning', level === 'danger' ? '🚨' : '⚠️', msg);
    showAlert(level === 'danger' ? '🚨' : '⚠️',
              level === 'danger' ? 'Critical Violation' : 'Warning', msg);
    const c = Proctor.getCounts();
    document.getElementById('ms-away').textContent  = c.lookAway + c.headTurn;
    document.getElementById('ms-noise').textContent = c.noise;
  });

  Proctor.on('faceStatus', ({ count }) => {
    document.getElementById('ms-faces').textContent = count;
  });

  Proctor.on('lmCount', n => {
    document.getElementById('pill-lm').textContent = `● ${n} pts`;
    document.getElementById('pill-lm').className   = `pill ${n > 0 ? 'ok' : 'dim'}`;
  });

  Proctor.on('badge', updates => {
    const labels = {
      face: { ok:'✔ Face OK', warn:'⚠ No Face', danger:'🚨 No Face!' },
      head: { ok:'📐 Head OK', warn:'📐 Head Turned', danger:'📐 Head Away!' },
      gaze: { ok:'👀 Gaze OK', warn:'👀 Gaze Away', danger:'👀 Off Screen' },
    };
    for (const [key, status] of Object.entries(updates)) {
      const el = document.getElementById(`pill-${key}`);
      if (el) { el.className = `pill ${status}`; el.textContent = labels[key]?.[status] || status; }
    }
  });

  Proctor.on('noise', db => {
    const pct  = Math.min(100, db / 90 * 100);
    const fill = document.getElementById('noise-bar');
    fill.style.width      = pct + '%';
    fill.style.background = db > 70 ? '#ef4444' : db > 55 ? '#f59e0b' : '#22c55e';
    document.getElementById('noise-db').textContent = db + ' dB';
  });

  Proctor.on('brightness', lum => {
    lastBrightness = lum;
    const advisory = document.getElementById('light-advisory');
    if (lum < 50) advisory.classList.remove('hidden');
    else          advisory.classList.add('hidden');
  });

  Proctor.on('log', ({ type, msg }) => addLog(type, 'ℹ️', msg));
}

// ── Risk level ────────────────────────────────────────────────────
function updateRisk() {
  const b = document.getElementById('risk-badge');
  if (violationTotal >= 10) { b.textContent = 'HIGH';   b.className = 'rbadge high'; }
  else if (violationTotal >= 4) { b.textContent = 'MEDIUM'; b.className = 'rbadge medium'; }
  else { b.textContent = 'LOW'; b.className = 'rbadge low'; }
}

function updateStats() {
  document.getElementById('ms-viol').textContent = violationTotal;
}

// ── Alert queue ───────────────────────────────────────────────────
const alertQ = [];
let alertOpen = false;

function showAlert(ico, title, msg) {
  alertQ.push({ ico, title, msg });
  if (!alertOpen) nextAlert();
}
function nextAlert() {
  if (!alertQ.length) { alertOpen = false; return; }
  alertOpen = true;
  const { ico, title, msg } = alertQ.shift();
  document.getElementById('alert-ico').textContent   = ico;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-msg').textContent   = msg;
  document.getElementById('alert-overlay').classList.remove('hidden');
}
function dismissAlert() {
  document.getElementById('alert-overlay').classList.add('hidden');
  setTimeout(nextAlert, 350);
}

// ── Activity log ──────────────────────────────────────────────────
function addLog(type, icon, msg) {
  const time = new Date().toLocaleTimeString('en-GB');
  logEntries.push({ type, icon, msg, time });

  const body = document.getElementById('log');
  const el   = document.createElement('div');
  el.className = `log-item ${type}`;
  el.innerHTML = `<span class="log-ico">${icon}</span>
    <div style="flex:1"><div class="log-msg">${msg}</div><div class="log-time">${time}</div></div>`;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;

  document.getElementById('log-cnt').textContent = logEntries.length;
}

// ── Timer ─────────────────────────────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    secondsLeft--;
    const m = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
    const s = String(secondsLeft % 60).padStart(2, '0');
    const el = document.getElementById('timer');
    el.textContent = `${m}:${s}`;
    if (secondsLeft <= 300) el.style.color = '#f59e0b';
    if (secondsLeft <= 60)  el.style.color = '#ef4444';
    if (secondsLeft <= 0)   endExam();
  }, 1000);
}

// ── Questions ─────────────────────────────────────────────────────
function loadQuestion(idx) {
  currentQ = idx;
  const q  = QUESTIONS[idx];
  const letters = ['A','B','C','D','E'];

  document.getElementById('q-num').textContent       = `Q ${idx+1} / ${QUESTIONS.length}`;
  document.getElementById('q-topic-tag').textContent = q.topic;
  document.getElementById('q-text').textContent      = q.text;

  const opts = document.getElementById('options');
  opts.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'opt' + (answers[idx] === i ? ' selected' : '');
    btn.innerHTML = `<span class="opt-ltr">${letters[i]}</span>${opt}`;
    btn.onclick   = () => { answers[idx] = i; loadQuestion(idx); addLog('info','✏️',`Q${idx+1} answered`); };
    opts.appendChild(btn);
  });
  updateDots();
}

function prevQ() { if (currentQ > 0) loadQuestion(currentQ - 1); }
function nextQ() { if (currentQ < QUESTIONS.length - 1) loadQuestion(currentQ + 1); }

function buildDots() {
  const row = document.getElementById('q-dots');
  row.innerHTML = '';
  QUESTIONS.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'qdot';
    d.onclick   = () => loadQuestion(i);
    row.appendChild(d);
  });
  updateDots();
}
function updateDots() {
  document.querySelectorAll('.qdot').forEach((d, i) => {
    d.className = 'qdot' + (i === currentQ ? ' cur' : answers[i] !== null ? ' done' : '');
  });
}

// ── End exam ──────────────────────────────────────────────────────
function endExam() {
  if (!examStartTime) return;
  clearInterval(timerInterval);
  Proctor.stop();
  addLog('info', '🏁', 'Exam ended.');
  buildReport();
  showScreen('report-screen');
}

// ── Report ────────────────────────────────────────────────────────
function buildReport() {
  const endTime  = new Date();
  const durSecs  = Math.floor((endTime - examStartTime) / 1000);
  const c        = Proctor.getCounts();
  const answered = answers.filter(a => a !== null).length;
  const correct  = answers.filter((a, i) => a === QUESTIONS[i].answer).length;
  const score    = Math.round(correct / QUESTIONS.length * 100);
  const risk     = violationTotal >= 10 ? 'HIGH' : violationTotal >= 4 ? 'MEDIUM' : 'LOW';
  const verdict  = violationTotal >= 10 ? 'flagged' : violationTotal >= 4 ? 'moderate' : 'clean';
  const vText    = { clean:'✅ CLEAN — No significant malpractice detected.', moderate:'⚠️ MODERATE RISK — Review flagged events.', flagged:'🚨 FLAGGED — High violation count. Manual review required.' }[verdict];

  const vlogs = logEntries.filter(e=>e.type!=='info')
    .map(e=>`<div class="${e.type==='danger'?'md':'mw'}">[${e.time}] ${e.msg}</div>`)
    .join('') || '<div>No violations.</div>';

  document.getElementById('report-body').innerHTML = `
    <div class="r-section">
      <h4>Candidate</h4>
      <div class="r-row"><span class="lbl">Name</span><span class="val">${candidate.name}</span></div>
      <div class="r-row"><span class="lbl">Exam ID</span><span class="val">${candidate.examId}</span></div>
      <div class="r-row"><span class="lbl">Date</span><span class="val">${examStartTime.toLocaleDateString()}</span></div>
      <div class="r-row"><span class="lbl">Start</span><span class="val">${examStartTime.toLocaleTimeString()}</span></div>
      <div class="r-row"><span class="lbl">Duration</span><span class="val">${Math.floor(durSecs/60)}m ${durSecs%60}s</span></div>
    </div>
    <div class="r-section">
      <h4>Score</h4>
      <div class="r-row"><span class="lbl">Answered</span><span class="val">${answered}/${QUESTIONS.length}</span></div>
      <div class="r-row"><span class="lbl">Correct</span><span class="val ${score>=60?'ok':'danger'}">${correct}/${QUESTIONS.length}</span></div>
      <div class="r-row"><span class="lbl">Score</span><span class="val ${score>=60?'ok':'danger'}">${score}%</span></div>
    </div>
    <div class="r-section">
      <h4>Proctoring</h4>
      <div class="r-row"><span class="lbl">Engine</span><span class="val">MediaPipe FaceMesh 468-pt</span></div>
      <div class="r-row"><span class="lbl">Risk Level</span><span class="val ${risk==='LOW'?'ok':risk==='MEDIUM'?'warn':'danger'}">${risk}</span></div>
      <div class="r-row"><span class="lbl">Total Violations</span><span class="val ${violationTotal>0?(violationTotal>=4?'danger':'warn'):'ok'}">${violationTotal}</span></div>
      <div class="r-row"><span class="lbl">No-Face Events</span><span class="val">${c.noFace}</span></div>
      <div class="r-row"><span class="lbl">Multiple Persons</span><span class="val">${c.multiFace}</span></div>
      <div class="r-row"><span class="lbl">Gaze Off-Screen</span><span class="val">${c.lookAway}</span></div>
      <div class="r-row"><span class="lbl">Head Turns</span><span class="val">${c.headTurn}</span></div>
      <div class="r-row"><span class="lbl">Noise Alerts</span><span class="val">${c.noise}</span></div>
      <div class="r-row"><span class="lbl">Talking Events</span><span class="val">${c.talking}</span></div>
    </div>
    <div class="verdict ${verdict}">${vText}</div>
    <div class="r-section"><h4>Violation Log</h4><div class="mini-vlog">${vlogs}</div></div>`;
}

function downloadReport() {
  const c = Proctor.getCounts();
  const lines = [
    '=== SecureExam v2 Proctoring Report ===',
    `Engine     : MediaPipe FaceMesh (468 landmarks + iris)`,
    `Candidate  : ${candidate.name}`,
    `Exam ID    : ${candidate.examId}`,
    `Date       : ${examStartTime?.toLocaleDateString()}`,
    `Start Time : ${examStartTime?.toLocaleTimeString()}`,
    '',
    '--- Violations ---',
    `Total      : ${violationTotal}`,
    `No Face    : ${c.noFace}`,
    `Multi-Face : ${c.multiFace}`,
    `Gaze Away  : ${c.lookAway}`,
    `Head Turns : ${c.headTurn}`,
    `Noise      : ${c.noise}`,
    `Talking    : ${c.talking}`,
    '',
    '--- Event Log ---',
    ...logEntries.map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`)
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `ProctorReport_${candidate.examId}_${Date.now()}.txt`,
  });
  a.click();
}

// ── Anti-cheat browser events ─────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden && examStartTime) {
    violationTotal++;
    updateStats(); updateRisk();
    addLog('danger', '🚨', 'Tab switched / window minimised!');
    showAlert('🚨', 'Tab Switch Detected', 'Switching tabs during the exam is a violation and has been recorded.');
  }
});
document.addEventListener('contextmenu',  e => { if (examStartTime) e.preventDefault(); });
document.addEventListener('copy',  () => { if (examStartTime) addLog('warning','⚠️','Copy attempt detected.'); });
document.addEventListener('paste', () => { if (examStartTime) addLog('warning','⚠️','Paste attempt detected.'); });
document.addEventListener('keydown', e => {
  if (!examStartTime) return;
  if (e.key === 'PrintScreen') addLog('danger','🚨','Screenshot key detected!');
  if (e.ctrlKey && ['c','v','a','s','p'].includes(e.key)) addLog('warning','⚠️',`Ctrl+${e.key.toUpperCase()} detected.`);
});
