/* ============================================================
   Lev · Eguchi absolute-pitch trainer
   Local-first v1. Storage isolated in Store{} so a sync
   backend (Firebase) can be dropped in later with no rewrite.
   ============================================================ */

/* ---------- Card data (introduction order) ---------- */
const CARDS = [
  { id:'apple',  emoji:'🍎', he:'תפוח',  tr:'Tapuach', notes:['C4','E4','G4'], color:'#e53935', ink:'#fff' },
  { id:'banana', emoji:'🍌', he:'בננה',  tr:'Banana',  notes:['C4','F4','A4'], color:'#ffd400', ink:'#1a1a1a' },
  { id:'fish',   emoji:'🐟', he:'דג',    tr:'Dag',     notes:['B3','D4','G4'], color:'#1e88e5', ink:'#fff' },
  { id:'cat',    emoji:'🐱', he:'חתול',  tr:'Chatul',  notes:['A3','C4','F4'], color:'#1c1c1c', ink:'#fff' },
  { id:'leaf',   emoji:'🍃', he:'עלה',   tr:'Aleh',    notes:['D4','G4','B4'], color:'#2e9e4f', ink:'#fff' },
  { id:'orange', emoji:'🍊', he:'תפוז',  tr:'Tapuz',   notes:['E4','G4','C5'], color:'#fb8c00', ink:'#1a1a1a' },
  { id:'grapes', emoji:'🍇', he:'ענבים', tr:'Anavim',  notes:['F4','A4','C5'], color:'#8e2dc4', ink:'#fff' },
  { id:'flower', emoji:'🌸', he:'פרח',   tr:'Perach',  notes:['G4','B4','D5'], color:'#ff5fa2', ink:'#1a1a1a' },
  { id:'bear',   emoji:'🐻', he:'דוב',   tr:'Dov',     notes:['G4','C5','E5'], color:'#6d4c41', ink:'#fff' },
];
const byId = id => CARDS.find(c => c.id === id);
const SLOTS = ['Breakfast','Nap','Dinner','Bath','Bed'];
const SLOT_ICON = ['🥣','😴','🍽️','🛁','🌙'];
const READY_WINDOW = 10, READY_PASS = 8, SPACING_DAYS = 14;

/* ============================================================
   Storage = append-only EVENT LOG (merges cleanly across phones)
   - state.events: session/test events, each with a unique id
   - state.added : map cardId -> first-unlocked date (drives unlocked)
   - user / speak: per-device prefs, never synced
   Derived for the UI: state.sessions, state.tests, state.unlocked
   Firestore (when configured) syncs events + added; the union of
   two devices' logs is the same on both, so no double counting.
   ============================================================ */
const KEY = 'lev_eguchi_v1';
const EVENT_CAP = 1200;
let deviceId = localStorage.getItem('lev_device') ||
  (localStorage.setItem('lev_device', 'd' + Date.now().toString(36) +
    Math.floor(Math.random() * 1e6).toString(36)), localStorage.getItem('lev_device'));
const uid = () => deviceId + '-' + Date.now().toString(36) + '-' +
  Math.floor(Math.random() * 1e9).toString(36);

function freshState() {
  const today = todayStr();
  return { user: 'Amit', speak: false, events: [],
           added: { apple: today, banana: today },
           sessions: [], tests: [], unlocked: [] };
}
function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!s) return freshState();
  // migrate v1 (sessions/tests arrays) -> event log
  if (!s.events) {
    s.events = [];
    (s.sessions || []).forEach(x => s.events.push({ kind: 'session', id: uid(),
      date: x.date, user: x.user, type: x.type, ts: x.ts || Date.now() }));
    (s.tests || []).forEach(x => s.events.push({ kind: 'test', id: uid(),
      date: x.date, user: x.user, cardId: x.cardId, correct: x.correct, ts: x.ts || Date.now() }));
  }
  if (!s.added) s.added = { apple: todayStr(), banana: todayStr() };
  if (!s.user) s.user = 'Amit';
  return s;
}
let state = loadState();

function recompute() {
  const ev = state.events;
  state.sessions = ev.filter(e => e.kind === 'session')
    .map(e => ({ id: e.id, date: e.date, user: e.user, type: e.type, ts: e.ts }))
    .sort((a, b) => a.ts - b.ts);
  state.tests = ev.filter(e => e.kind === 'test')
    .map(e => ({ id: e.id, date: e.date, user: e.user, cardId: e.cardId, correct: e.correct, ts: e.ts }))
    .sort((a, b) => a.ts - b.ts);
  state.unlocked = CARDS.map(c => c.id).filter(id => state.added[id]);
}
function persist() {
  // keep all unlock info (in `added`) but cap the event log to recent activity
  if (state.events.length > EVENT_CAP + 200)
    state.events = state.events.slice(-EVENT_CAP);
  localStorage.setItem(KEY, JSON.stringify({
    user: state.user, speak: state.speak, events: state.events, added: state.added }));
}

/* Create a logged event (session/test). Persists locally + pushes to sync. */
function addEvent(ev) {
  ev.id = ev.id || uid();
  ev.ts = ev.ts || Date.now();
  state.events.push(ev);
  recompute(); persist();
  Sync.writeEvent(ev);
}
function unlockCard(id) {
  if (state.added[id]) return;
  state.added[id] = todayStr();
  recompute(); persist();
  Sync.writeAdded(id, state.added[id]);
}
function removeCardLocal(id) {
  delete state.added[id];
  recompute(); persist();
  Sync.removeAdded(id);
}
recompute();

/* Re-render whatever screen is open (used when remote data arrives) */
function currentScreen() {
  const s = document.querySelector('.screen:not(.hidden)');
  return s ? s.id.replace('screen-', '') : 'home';
}
function refreshCurrentScreen() {
  const n = currentScreen();
  if (n === 'home') renderHome();
  else if (n === 'progress') renderProgress();
  else if (n === 'settings') renderSettings();
  else if (n === 'test') updateTestScore();
}

/* ============================================================
   Sync layer — Firestore. Inert until sync-config.js has an apiKey.
   ============================================================ */
const Sync = {
  enabled: false, status: 'local', db: null, famRef: null, evRef: null,
  cfg: (window.SYNC_CONFIG || {}),
  async init() {
    const fb = this.cfg.firebase;
    if (!fb || !fb.apiKey || !window.firebase) { this.setStatus('local'); return; }
    try {
      firebase.initializeApp(fb);
      this.db = firebase.firestore();
      try { await this.db.enablePersistence({ synchronizeTabs: true }); } catch (e) {}
      this.famRef = this.db.collection('families').doc(this.cfg.familyId);
      this.evRef = this.famRef.collection('events');
      this.enabled = true; this.setStatus('connecting');
      await this.backfill();                       // upload anything local-only
      this.famRef.onSnapshot(snap => {             // shared "added" map
        const d = snap.data() || {};
        this.setStatus(snap.metadata.fromCache ? 'offline' : 'live');
        if (d.added) {
          let changed = false;
          Object.keys(d.added).forEach(id => {
            if (!state.added[id] || d.added[id] < state.added[id]) { state.added[id] = d.added[id]; changed = true; }
          });
          if (changed) { recompute(); persist(); refreshCurrentScreen(); }
        }
      }, () => this.setStatus('offline'));
      this.evRef.orderBy('ts', 'desc').limit(1500).onSnapshot(snap => {  // shared events
        const have = new Set(state.events.map(e => e.id));
        let changed = false;
        snap.forEach(doc => {
          const e = doc.data();
          if (e && e.id && !have.has(e.id)) { state.events.push(e); have.add(e.id); changed = true; }
        });
        if (changed) { recompute(); persist(); refreshCurrentScreen(); }
      }, () => {});
    } catch (e) { this.enabled = false; this.setStatus('local'); }
  },
  async backfill() {
    try {
      state.events.forEach(e => this.evRef.doc(e.id).set(e));
      const added = {};
      Object.keys(state.added).forEach(id => added[id] = state.added[id]);
      this.famRef.set({ added }, { merge: true });
    } catch (e) {}
  },
  writeEvent(ev) { if (this.enabled) try { this.evRef.doc(ev.id).set(ev); } catch (e) {} },
  writeAdded(id, date) { if (this.enabled) try { this.famRef.set({ added: { [id]: date } }, { merge: true }); } catch (e) {} },
  removeAdded(id) {
    if (this.enabled) try {
      this.famRef.set({ added: { [id]: firebase.firestore.FieldValue.delete() } }, { merge: true });
    } catch (e) {}
  },
  setStatus(s) { this.status = s; renderSyncBadge(); },
};
function renderSyncBadge() {
  const el = document.getElementById('syncBadge'); if (!el) return;
  const map = { local: ['•', 'on this phone only'], connecting: ['◌', 'connecting…'],
                live: ['☁︎', 'synced with Jonathan'], offline: ['⌁', 'offline · will sync'] };
  const [icon, label] = map[Sync.status] || map.local;
  el.textContent = `${icon} ${label}`;
  el.className = 'sync-badge ' + Sync.status;
}

/* ---------- Date helpers ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((new Date(todayStr()) - new Date(iso)) / 86400000);
}
function sessionsToday() {
  const t = todayStr();
  return state.sessions.filter(s => s.date === t);
}

/* ---------- Audio (Web Audio, always in tune) ----------
   iOS notes:
   - Safari silences Web Audio when the side MUTE switch is on unless
     we declare a "playback" audio session (Safari 16.4+).
   - The context must be created + resumed inside a user gesture, and
     "unlocked" by playing a silent buffer once.                       */
let actx = null, audioUnlocked = false;
function setPlaybackSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
}
function ensureAudio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    setPlaybackSession();
  }
  if (actx.state === 'suspended') actx.resume();
  if (!audioUnlocked) {
    // play a 1-sample silent buffer to flip iOS out of its muted state
    try {
      const buf = actx.createBuffer(1, 1, 22050);
      const src = actx.createBufferSource();
      src.buffer = buf; src.connect(actx.destination); src.start(0);
      audioUnlocked = true;
    } catch (e) {}
  }
  return actx;
}
// Resume/unlock on the very first touch anywhere, so the first chord is never swallowed.
['pointerdown', 'touchend', 'click'].forEach(evt =>
  document.addEventListener(evt, () => { setPlaybackSession(); ensureAudio(); }, { passive: true }));
function noteFreq(name) {
  const m = name.match(/^([A-G])(#?)(\d)$/);
  const semis = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  const midi = (parseInt(m[3]) + 1) * 12 + semis[m[1]] + (m[2] ? 1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function playChord(notes) {
  const ctx = ensureAudio();
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 4200;
  filt.connect(master); master.connect(ctx.destination);
  const dur = 1.9;
  notes.forEach((n, i) => {
    const f = noteFreq(n);
    const start = t0 + i * 0.012;           // tiny roll, like fingers landing
    [1, 2, 3, 4].forEach((h, hi) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * h;
      osc.detune.value = (Math.random() - 0.5) * 4;
      const g = ctx.createGain();
      const peak = [0.5, 0.22, 0.12, 0.06][hi];
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g); g.connect(filt);
      osc.start(start); osc.stop(start + dur + 0.05);
    });
  });
}

/* ---------- Hebrew voice ---------- */
function speak(text) {
  if (!state.speak || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'he-IL'; u.rate = 0.85;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

/* ---------- Tiny utilities ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1900);
}

/* ---------- Navigation ---------- */
function go(name) {
  $$('.screen').forEach(s => s.classList.add('hidden'));
  $('#screen-' + name).classList.remove('hidden');
  if (name === 'home') renderHome();
  if (name === 'teach') startTeach();
  if (name === 'test') startTest();
  if (name === 'progress') renderProgress();
  if (name === 'settings') renderSettings();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (!g) return;
  if (g.dataset.go !== 'home') ensureAudio(); // unlock audio on user gesture
  go(g.dataset.go);
});

/* ---------- HOME ---------- */
function renderHome() {
  const d = new Date();
  $('#todayLabel').textContent = d.toLocaleDateString(undefined,
    { weekday:'long', month:'long', day:'numeric' });
  const done = sessionsToday().length;
  $('#sessionDone').textContent = done;
  $('#slots').innerHTML = SLOTS.map((s, i) => `
    <div class="slot ${i < done ? 'done' : ''}">
      <div class="dot">${i < done ? '✓' : SLOT_ICON[i]}</div>${s}
    </div>`).join('');
  $('#activeCards').innerHTML = state.unlocked.map(id => {
    const c = byId(id);
    return `<div class="mini-card" style="background:${c.color}">${c.emoji}</div>`;
  }).join('');
  $$('#whoToggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.user === state.user));
  renderSyncBadge();
}
$('#whoToggle').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.user = b.dataset.user; persist(); renderHome();
});

/* ---------- TEACH ---------- */
let teach = null;
function buildQueue(target) {
  const ids = state.unlocked;
  const q = [];
  while (q.length < target) {
    const batch = shuffle(ids);
    // avoid immediate repeat across batch boundary
    if (q.length && batch[0] === q[q.length - 1] && batch.length > 1)
      [batch[0], batch[1]] = [batch[1], batch[0]];
    q.push(...batch);
  }
  return q.slice(0, target);
}
function startTeach() {
  teach = { queue: buildQueue(22), i: 0, revealed: false, reveals: 0, logged: false };
  showTeachCard();
}
function showTeachCard() {
  const el = $('#teachCard');
  $('#teachRep').textContent = teach.i + 1;
  if (!teach.revealed) {
    el.className = 'card-display empty';
    el.style.background = '';
    el.innerHTML = `<div class="hide-prompt">♪ Play the chord,<br>then reveal</div>`;
    $('#teachReveal').disabled = false;
    $('#teachNext').disabled = true;
  }
}
function revealTeachCard() {
  const c = byId(teach.queue[teach.i]);
  const el = $('#teachCard');
  el.className = 'card-display';
  el.style.background = c.color;
  el.style.color = c.ink;
  el.innerHTML =
    `<div class="emoji">${c.emoji}</div>
     <div class="heb">${c.he}</div>
     <div class="translit">${c.tr}!</div>`;
  teach.revealed = true;
  teach.reveals++;
  $('#teachReveal').disabled = true;
  $('#teachNext').disabled = false;
  speak(c.he);
}
$('#teachPlay').addEventListener('click', () => playChord(byId(teach.queue[teach.i]).notes));
$('#teachReveal').addEventListener('click', revealTeachCard);
$('#teachNext').addEventListener('click', () => {
  teach.i++;
  if (teach.i >= teach.queue.length) { finishTeach(true); return; }
  teach.revealed = false;
  showTeachCard();
});
function finishTeach(complete) {
  if (!teach.logged && teach.reveals >= (complete ? 1 : 8)) {
    addEvent({ kind: 'session', date: todayStr(), user: state.user, type: 'teach' });
    teach.logged = true;
    toast(`Teach session logged · ${sessionsToday().length}/5 today`);
  }
}

/* ---------- TEST ---------- */
let test = null;
function startTest() {
  test = { current: null, correct: 0, total: 0, logged: false };
  renderTestChoices();
  nextTest();
  updateTestScore();
}
function renderTestChoices() {
  $('#testChoices').innerHTML = shuffle(state.unlocked).map(id => {
    const c = byId(id);
    return `<button class="choice" data-card="${id}" style="background:${c.color};color:${c.ink}">
      ${c.emoji}<span class="clabel">${c.he}</span></button>`;
  }).join('');
}
function nextTest() {
  let pool = state.unlocked;
  if (test.current && pool.length > 1) pool = pool.filter(id => id !== test.current);
  test.current = shuffle(pool)[0];
  setTimeout(() => playChord(byId(test.current).notes), 250);
}
$('#testPlay').addEventListener('click', () => { if (test.current) playChord(byId(test.current).notes); });
$('#testChoices').addEventListener('click', e => {
  const b = e.target.closest('.choice'); if (!b || !test.current) return;
  const chosen = b.dataset.card;
  const correct = chosen === test.current;
  addEvent({ kind: 'test', date: todayStr(), user: state.user, cardId: test.current, correct });
  test.total++; if (correct) test.correct++;
  // visual feedback
  b.classList.add(correct ? 'correct-flash' : 'wrong-flash');
  if (!correct) {
    const right = $(`.choice[data-card="${test.current}"]`);
    if (right) right.classList.add('correct-flash');
  }
  maybeLogTest();
  updateTestScore();
  setTimeout(() => { renderTestChoices(); nextTest(); }, 900);
});
function maybeLogTest() {
  if (!test.logged && test.total >= 5) {
    addEvent({ kind: 'session', date: todayStr(), user: state.user, type: 'test' });
    test.logged = true;
    toast(`Test session logged · ${sessionsToday().length}/5 today`);
  }
}
function updateTestScore() {
  const last = state.tests.slice(-READY_WINDOW);
  const c = last.filter(t => t.correct).length;
  $('#testScore').textContent = last.length ? `${c}/${last.length}` : '–';
  $('#testSession').textContent = `${test.correct}/${test.total}`;
}

/* ---------- Readiness math ---------- */
function cardReadiness(id) {
  const hist = state.tests.filter(t => t.cardId === id).slice(-READY_WINDOW);
  const correct = hist.filter(t => t.correct).length;
  return { correct, total: hist.length,
           met: hist.length >= READY_WINDOW && correct >= READY_PASS };
}
function setReadyToAdd() {
  // all unlocked cards met + spacing satisfied since last addition
  const allMet = state.unlocked.every(id => cardReadiness(id).met);
  const lastAdd = Math.max(...state.unlocked.map(id => daysSince(state.added[id] || null)
    .toString() === 'Infinity' ? -1 : daysSince(state.added[id])));
  const spaced = state.unlocked.every(id => daysSince(state.added[id]) >= SPACING_DAYS);
  return allMet && spaced;
}

/* ---------- PROGRESS ---------- */
function renderProgress() {
  $('#readiness').innerHTML = state.unlocked.map(id => {
    const c = byId(id), r = cardReadiness(id);
    const pct = r.total ? Math.round(100 * r.correct / r.total) : 0;
    return `<div class="ready-row ${r.met ? 'met' : ''}">
      <div class="swatch" style="background:${c.color}">${c.emoji}</div>
      <div class="rinfo">
        <div class="rname">${c.he} <small>${c.tr}</small></div>
        <div class="rbar"><i style="width:${pct}%"></i></div>
        <div class="rpct">${r.total ? `${r.correct}/${r.total} of last ${r.total}` : 'no test data yet'}${r.met ? ' · ready ✓' : ''}</div>
      </div></div>`;
  }).join('');

  const nextId = CARDS.find(c => !state.unlocked.includes(c.id))?.id;
  const canAdd = setReadyToAdd();
  $('#roadmap').innerHTML = CARDS.map(c => {
    const active = state.unlocked.includes(c.id);
    const isNext = c.id === nextId;
    const cls = active ? '' : 'locked';
    let tag = active ? '<span class="tag active">active</span>'
            : isNext ? `<span class="tag next">next${canAdd ? ' · ready' : ''}</span>`
            : '<span class="tag locked">locked</span>';
    const add = (isNext)
      ? `<button class="link-btn" data-add="${c.id}" style="color:var(--test)">+ Add</button>` : '';
    const chord = c.notes.join('–');
    return `<div class="road-item ${cls}">
      <div class="swatch" style="background:${c.color}">${c.emoji}</div>
      <div class="rmeta"><b>${c.he}</b> <small>${c.tr}</small><span>${chord}</span></div>
      ${add}${tag}</div>`;
  }).join('');
}
$('#roadmap')?.addEventListener('click', e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  const id = b.dataset.add;
  if (!setReadyToAdd() &&
      !confirm('Readiness/spacing not fully met. Add this card anyway? (Adults make the call.)')) return;
  addCard(id);
});
function addCard(id) {
  if (state.unlocked.includes(id)) return;
  unlockCard(id);
  toast(`Added ${byId(id).he} (${byId(id).tr})`);
  renderProgress();
}

/* ---------- SETTINGS ---------- */
function renderSettings() {
  $('#settingsCards').innerHTML = CARDS.map(c => {
    const on = state.unlocked.includes(c.id);
    return `<button class="set-card ${on ? 'on' : 'off'}" data-toggle="${c.id}"
       style="background:${c.color};color:${c.ink}">
       ${c.emoji}<span class="slabel">${c.tr}</span></button>`;
  }).join('');
  $('#speakToggle').classList.toggle('on', state.speak);
  $('#speakToggle').textContent = 'Hebrew voice: ' + (state.speak ? 'ON' : 'off');
}
$('#settingsCards').addEventListener('click', e => {
  const b = e.target.closest('[data-toggle]'); if (!b) return;
  const id = b.dataset.toggle;
  if (state.unlocked.includes(id)) {
    if (state.unlocked.length <= 1) { toast('Keep at least one card'); return; }
    removeCardLocal(id);
  } else {
    unlockCard(id);
  }
  renderSettings();
});
$('#speakToggle').addEventListener('click', () => {
  state.speak = !state.speak; persist(); renderSettings();
  if (state.speak) speak('שלום');
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Erase all sessions, test results, and progress on THIS device?' +
    (Sync.enabled ? '\n\n(Sync is on — data still on the cloud/other phone will flow back. To wipe everything, reset on both phones.)' : ''))) return;
  localStorage.removeItem(KEY);
  state = freshState(); recompute(); persist();
  toast('Reset'); go('home');
});

/* ---------- Leave-screen logging ---------- */
$$('#screen-teach .back').forEach(b => b.addEventListener('click', () => finishTeach(false)));
$$('#screen-test .back').forEach(b => b.addEventListener('click', maybeLogTest));

/* ---------- Service worker (installable / offline) ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{}));
}

/* ---------- Boot ---------- */
go('home');
Sync.init();
