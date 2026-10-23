import { PHASES, Clock, fmt, fmtShort, fmtTenths, buildRoundPhases, buildCronoPhases, Sequence, TempoRunner } from './engine.js';
import * as db from './storage.js';
import { WorkRecorder, cameraSupported, videoStore } from './recorder.js';
import { encodeLink, decodeLink, isIosBrowser } from './share.js';
import { seriesFor, chartSvg, formatValue, resultLine, coachMessage, stats, groupResults, dateLabel, dateTimeLabel, kgLabel } from './report.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = v => Math.max(0, parseInt(v, 10) || 0);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const safeImg = u => (/^(https?:\/\/|data:image\/)/i.test(u || '') ? u : '');
const cssUrl = u => `url("${u.replace(/["\\\s()]/g, c => encodeURIComponent(c))}")`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7.5 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12a7 7 0 1 0 2.05-4.95"/><path d="M5 4.5V9h4.5"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l8 6-8 6z"/><path d="M18 6v12"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" rx="2.5"/><path d="M9 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9.5 11h5M9.5 15h5"/></svg>',
  playSmall: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
};

// Conferma dentro l'app, al posto della finestra del browser. Risolve con true se si conferma.
function ask(text, { ok = 'Conferma', danger = false } = {}) {
  return new Promise(resolve => {
    const box = $('ask'), yes = $('ask-yes'), no = $('ask-no');
    $('ask-text').textContent = text;
    yes.textContent = ok;
    yes.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
    box.hidden = false;
    const done = v => {
      box.hidden = true;
      yes.onclick = no.onclick = box.onclick = null;
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    box.onclick = e => { if (e.target === box) done(false); };
    yes.focus();
  });
}

const WORDMARK = `<span class="wordmark" role="img" aria-label="Tempro">Tempr<svg aria-hidden="true" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="36" fill="none" stroke="#2A2D34" stroke-width="22"/>
  <circle cx="50" cy="50" r="36" fill="none" stroke="#C6F432" stroke-width="22" stroke-linecap="round" stroke-dasharray="170 227" transform="rotate(-90 50 50)"/>
</svg></span>`;

// Nomi brevi delle fasi per i riquadri "Poi"
const SHORT = {
  prepara: 'Prepara', lavoro: 'Lavoro', riposo: 'Riposo', riposoCicli: 'Recupero',
  rinfrescati: 'Rinfrescati', cronometro: 'Cronometro', timer: 'Timer', fine: 'Fine',
};

// Campi del modulo di modifica per ciascun tipo: [chiave, tipo campo, etichetta]
const FIELDS = {
  round: [
    ['prepara', 'dur', 'Prepara'],
    ['lavoro', 'dur', 'Lavoro'],
    ['riposo', 'dur', 'Riposo'],
    ['roundPerCiclo', 'num', 'Round per ciclo'],
    ['cicli', 'num', 'Cicli'],
    ['riposoTraCicli', 'dur', 'Riposo tra i cicli'],
    ['rinfrescati', 'dur', 'Rinfrescati'],
  ],
  tempo: [
    ['prepara', 'dur', 'Prepara'],
    ['tempoTotale', 'dur', 'Tempo totale'],
    ['unita', 'unit', 'Obiettivo in'],
    ['obiettivo', 'num', 'Obiettivo (ripetizioni o secondi)'],
    ['riposo', 'dur', 'Riposo dopo ogni serie'],
  ],
  cronometro: [
    ['direzione', 'dir', 'Modalità'],
    ['prepara', 'dur', 'Prepara'],
    ['durata', 'dur', 'Durata (conto alla rovescia)'],
  ],
};
const MIN = { lavoro: 1, roundPerCiclo: 1, cicli: 1, tempoTotale: 1, obiettivo: 1, durata: 1 };

// Entro il tempo: l'obiettivo può essere in ripetizioni o in secondi (es. plank).
const inSec = t => t.unita === 'secondi';
const amount = (t, n) => (inSec(t) ? fmtShort(n) : String(n));
const signed = (t, n) => (n > 0 ? '+' : n < 0 ? '−' : '') + amount(t, Math.abs(n));

const RING = 2 * Math.PI * 136;   // circonferenza dell'anello (r=136 nel viewBox 300)
const APP_VERSION = '13';          // da aggiornare insieme a VERSION in sw.js

let settings = db.getSettings();
let mode;            // 'round' | 'tempo' | 'cronometro' | 'sessioni' | 'andamento'
let tpl;             // modello in uso
let runner;          // Sequence | TempoRunner
let laps = [];       // cronometro: istanti (s) dei giri
let lastIdx = -1;    // ultima fase annunciata (Sequence)
let beepKey = null, beepSec = null;
let sheetKind = null, sheetDismiss = null;
let phaseType = null;
let view = null;     // ultimo modello di vista disegnato

const cam = new WorkRecorder();
let facing = 'user';       // fotocamera scelta nell'inquadratura
let videoUrl = null;       // anteprima del video nel pannello di salvataggio

// Pannelli in attesa (valutazione, video…): si aprono uno alla volta quando non ce n'è un altro.
const queue = [];
let reportTab = 'miei';    // Andamento: 'miei' | 'atleti'
let reportAtleta = null;

// Scheda eseguita in sequenza: { scheda, ids, idx, results, cam, skipPrep }
let schedaRun = null;
// Riposo tra un allenamento e il successivo della scheda: { clock, dur }
let transition = null;
const TYPE_SHORT = { round: 'Round', tempo: 'A tempo', cronometro: 'Crono' };

// --- Suoni, voce, vibrazione, schermo acceso -------------------------------

const audio = {
  ctx: null,
  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx && AC) this.ctx = new AC();
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  },
  beep(freq = 880, dur = 0.15, vol = 0.6) {
    if (!settings.suoni || !this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
};

let speechReady = false;
// iOS sblocca audio e sintesi vocale solo dentro un gesto dell'utente.
function unlockMedia() {
  audio.unlock();
  if (!speechReady && 'speechSynthesis' in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    speechReady = true;
  }
}

function announce(type) {
  audio.beep(type === 'fine' ? 660 : 1320, 0.5);
  if (settings.vibrazione) navigator.vibrate?.(type === 'fine' ? [300, 100, 300] : 250);
  if (settings.voce && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(PHASES[type]?.voce ?? '');
    u.lang = 'it-IT';
    speechSynthesis.speak(u);
  }
}

// Bip negli ultimi 3 secondi di ogni conto alla rovescia.
function countdown(key, remaining) {
  if (!Number.isFinite(remaining)) return;
  const sec = Math.ceil(remaining - 1e-6);
  if (key !== beepKey) { beepKey = key; beepSec = sec; return; }
  if (sec !== beepSec) {
    beepSec = sec;
    if (sec >= 1 && sec <= 3) audio.beep(880, 0.15);
  }
}

let wakeLock = null;
let wakeChain = Promise.resolve();
// Le richieste si eseguono in ordine: un "spegni" seguito subito da un "accendi" non si perdono.
function keepAwake(on) {
  wakeChain = wakeChain.then(() => setWake(on));
  return wakeChain;
}
async function setWake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* non supportato o negato */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRunning()) { keepAwake(true); audio.unlock(); }
});

// --- Stato del timer --------------------------------------------------------

function isActive() {
  if (!runner) return false;
  if (tpl.tipo === 'tempo') return runner.stato !== 'idle' && runner.stato !== 'fine';
  return runner.clock.ms > 0 && !runner.state().done;
}

function isRunning() {
  if (!runner) return false;
  if (tpl.tipo === 'tempo') return isActive() && !runner.paused;
  return runner.clock.running;
}

async function confirmStop() {
  if (schedaRun) {
    if (!(await ask(`Uscire dalla scheda "${schedaRun.scheda.nome}"? Quanto fatto finora resta nello storico.`, { ok: 'Esci', danger: true }))) return false;
    exitScheda();
    return true;
  }
  return !isActive() || ask("Interrompere l'allenamento in corso? Quanto fatto finora resta nello storico.", { ok: 'Interrompi', danger: true });
}

function setPhase(type) {
  if (type === phaseType) return;
  phaseType = type;
  document.documentElement.style.setProperty('--phase', `var(--c-${type})`);
}

function loadMode(m) {
  keepAwake(false);
  stopSession();
  mode = m;
  db.setTab(m);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === m));
  const timer = !!db.TYPES[m];
  $('timer-view').hidden = !timer;
  $('sessions-view').hidden = m !== 'sessioni';
  $('report-view').hidden = m !== 'andamento';
  if (!timer) {
    runner = null;
    setPhase('info');
    if (m === 'sessioni') renderSessions(); else renderReport();
    return;
  }
  tpl = db.getTemplate(db.getSelected(m)) ?? db.newTemplate(m);
  updateMedia();
  resetRunner();
}

// Chiude l'allenamento in corso: salva il risultato (se c'è stato lavoro), ferma la ripresa.
function stopSession() {
  if (sheetKind === 'reps' || sheetKind === 'summary') closeSheet();
  if (!$('camera').hidden) { closeFraming(); cam.closeStream(); }
  if (runner) finishSession(sessionComplete());
  endRecording();
}

function resetRunner() {
  stopSession();
  laps = [];
  lastIdx = -1;
  beepKey = null;
  // In una scheda, dopo il riposo tra gli allenamenti la "Prepara" non serve.
  const t = schedaRun?.skipPrep ? { ...tpl, prepara: 0 } : tpl;
  if (t.tipo === 'round') runner = new Sequence(buildRoundPhases(t));
  else if (t.tipo === 'tempo') runner = new TempoRunner(t);
  else runner = new Sequence(buildCronoPhases(t));
  runner.tpl = tpl;
  keepAwake(false);
  render();
}

function tick() {
  if (!runner) return;
  if (transition) {
    const rem = transition.dur - transition.clock.ms / 1000;
    countdown(`tr${schedaRun.idx}`, rem);
    if (rem <= 0) { transition = null; startTimer(); }
    if (cam.active) cam.setWorking(false);
    render();
    return;
  }
  if (tpl.tipo === 'tempo') {
    const r = runner;
    for (const e of r.update()) {
      if (e === 'fine') onTempoFine();
      else announce(e);
    }
    if (!r.paused) {
      if (r.stato === 'prepara') countdown('p', r.prepRemaining);
      else if (r.stato === 'riposo') countdown(`r${r.serie.length}`, r.restRemaining);
      else if (r.stato === 'lavoro') countdown(`l${r.serie.length}`, r.totRemaining);
    }
  } else if (runner.clock.running) {
    const s = runner.state();
    if (s.done) {
      runner.clock.pause();
      announce('fine');
      keepAwake(false);
      finishSession(true);
      if (schedaRun) advanceScheda();
      else endRecording();
    } else {
      if (s.idx !== lastIdx) { lastIdx = s.idx; announce(s.phase.type); }
      countdown(s.idx, s.phaseRemaining);
    }
  }
  if (cam.active) cam.setWorking(isWorking());
  render();
}

// Fasi in cui si registra il video: solo il lavoro vero e proprio.
function isWorking() {
  if (!runner) return false;
  if (tpl.tipo === 'tempo') return runner.stato === 'lavoro' && !runner.paused;
  if (!runner.clock.running) return false;
  const s = runner.state();
  return !s.done && ['lavoro', 'cronometro', 'timer'].includes(s.phase.type);
}

function notStarted() {
  return tpl.tipo === 'tempo' ? runner.stato === 'idle' : runner.clock.ms === 0;
}

function startTimer() {
  runner.startedAt = new Date().toISOString();
  if (tpl.tipo === 'tempo') {
    runner.start();
    announce(runner.stato);
  } else {
    const s = runner.state();
    lastIdx = s.idx;
    announce(s.phase.type);
    runner.clock.start();
  }
  keepAwake(true);
  render();
}

function onMain() {
  unlockMedia();
  if (transition) {
    if (transition.clock.running) { transition.clock.pause(); keepAwake(false); }
    else { transition.clock.start(); keepAwake(true); }
    render();
    return;
  }
  if (notStarted()) {
    // In una scheda l'inquadratura si chiede solo all'inizio: il video prosegue per tutta la scheda.
    const wantsCam = schedaRun ? schedaRun.cam && !cam.active : tpl.registra;
    if (wantsCam && cameraSupported()) openFraming();
    else startTimer();
    return;
  }
  if (tpl.tipo === 'tempo') {
    const r = runner;
    if (r.stato === 'fine') resetRunner();
    else if (r.paused) { r.resume(); keepAwake(true); }
    else if (r.stato === 'lavoro') {
      const i = r.fatto();
      if (i >= 0) { announce(r.stato); openReps(i); }
    } else { r.pause(); keepAwake(false); }
  } else {
    const s = runner.state();
    if (s.done) resetRunner();
    else if (runner.clock.running) { runner.clock.pause(); keepAwake(false); }
    else { runner.clock.start(); keepAwake(true); }
  }
  render();
}

// Pulsanti ai lati del principale: ognuno porta l'azione da eseguire (vedi i modelli di vista).
async function onSide(act) {
  unlockMedia();
  switch (act) {
    case 'pause':   // Entro il tempo: pausa durante il lavoro (il principale è "Fine serie")
      runner.pause();
      keepAwake(false);
      break;
    case 'lap': {   // Cronometro in avanti: giro
      const s = runner.state();
      if (runner.clock.running && !s.done && s.phase.type === 'cronometro') { laps.push(s.phaseElapsed); audio.beep(1200, 0.06); }
      break;
    }
    case 'skip':    // Round: salta fase
      runner.skip();
      break;
    case 'skip-rest':   // Scheda: salta il riposo tra gli allenamenti
      transition = null;
      startTimer();
      return;
    case 'next':    // Scheda: il cronometro in avanti passa al prossimo allenamento
      runner.clock.pause();
      finishSession(true);
      advanceScheda();
      return;
    case 'reset':   // In pausa: azzera
      if (await ask('Azzerare il timer? Quanto fatto finora resta nello storico.', { ok: 'Azzera', danger: true })) resetRunner();
      return;
  }
  render();
}

function onTempoFine() {
  announce('fine');
  keepAwake(false);
  finishSession(true);
  endRecording();
  // Se l'utente sta già inserendo le esecuzioni, il riepilogo arriva dopo il salvataggio.
  if (sheetKind !== 'reps') continueFine();
}

function continueFine() {
  const i = runner.serie.findIndex(s => s.reps === null);
  if (i >= 0) openReps(i);
  else if (schedaRun) advanceScheda();   // nella scheda si va avanti: i risultati sono in Andamento
  else openSummary();
}

// --- Scheda in sequenza -----------------------------------------------------

async function startScheda(s) {
  const ids = s.modelli.filter(id => db.getTemplate(id));
  if (!ids.length) { alert('La scheda non contiene allenamenti.'); return; }
  if (!(await confirmStop())) return;
  schedaRun = { scheda: s, ids, idx: 0, results: [], cam: ids.some(id => db.getTemplate(id).registra), skipPrep: false };
  transition = null;
  showRunModel();
}

function showRunModel() {
  const t = db.getTemplate(schedaRun.ids[schedaRun.idx]);
  db.setSelected(t.tipo, t.id);
  loadMode(t.tipo);
}

// Allenamento concluso: riposo del modello appena finito, poi parte il successivo da solo.
function advanceScheda() {
  const run = schedaRun, done = tpl;
  run.idx++;
  while (run.idx < run.ids.length && !db.getTemplate(run.ids[run.idx])) run.idx++;
  if (run.idx >= run.ids.length) { finishScheda(); return; }
  const rest = done.tipo === 'cronometro' ? 0 : done.riposo;
  run.skipPrep = rest > 0;
  showRunModel();
  if (rest > 0) {
    transition = { clock: new Clock(), dur: rest };
    transition.clock.start();
    announce('riposo');
    keepAwake(true);
    render();
  } else startTimer();
}

function finishScheda() {
  const run = schedaRun;
  schedaRun = null;
  transition = null;
  endRecording();
  if (run.results.length) enqueue(() => openFeedback(run.results, run.scheda.nome));
  if (runner) render();
}

// Uscita anticipata: si salva quanto fatto finora.
function exitScheda() {
  if (!schedaRun) return;
  if (runner && !transition) finishSession(sessionComplete());
  finishScheda();
}

// --- Risultati --------------------------------------------------------------

function sessionComplete() {
  const t = runner.tpl;
  if (t.tipo === 'tempo') return runner.stato === 'fine';
  if (t.tipo === 'cronometro' && t.direzione !== 'indietro') return true;   // il cronometro non ha una fine
  return runner.state().done;
}

// Risultato dell'allenamento a partire dallo stato del timer.
function buildResult(r, completo) {
  const t = r.tpl, sch = schedaRun?.scheda ?? db.schedaOf(t.id);
  const res = {
    id: r.resultId ??= db.uid(), data: r.startedAt ?? new Date().toISOString(), tipo: t.tipo,
    modello: db.templateKey(t), nome: t.nome, scheda: sch?.id ?? null, schedaNome: sch?.nome ?? '', completo,
    peso: t.peso || null,
  };
  if (t.tipo === 'tempo') {
    return {
      ...res, unita: inSec(t) ? 'secondi' : null, fatte: r.totale, obiettivo: t.obiettivo, tempoTotale: t.tempoTotale,
      raggiuntoAl: r.obiettivoRaggiuntoAl(), serie: r.serie.map(s => s.reps ?? 0),
      serieInizio: r.serie.map(s => Math.round(s.inizio)), serieFine: r.serie.map(s => Math.round(s.fine)),
    };
  }
  const el = Math.min(r.clock.ms / 1000, r.total);
  if (t.tipo === 'round') {
    let start = 0, fatti = 0, totali = 0, lavoro = 0;
    r.phases.forEach((p, i) => {
      const end = r.ends[i];
      if (p.type === 'lavoro') {
        totali++;
        if (el >= end) fatti++;
        lavoro += Math.max(0, Math.min(el, end) - start);
      }
      start = end;
    });
    const prepR = r.phases[0]?.type === 'prepara' ? r.phases[0].duration : 0;
    return { ...res, roundFatti: fatti, roundTotali: totali, lavoroSec: Math.round(lavoro), durataSec: Math.round(Math.max(0, el - prepR)) };
  }
  const prep = r.phases[0].type === 'prepara' ? r.phases[0].duration : 0;
  const durs = laps.map((x, i) => x - (laps[i - 1] ?? 0));
  return {
    ...res, durataSec: Math.round(Math.max(0, el - prep)), giri: durs.length || null,
    giroMigliore: durs.length ? Math.round(Math.min(...durs) * 10) / 10 : null,
    giriTempi: durs.map(d => Math.round(d * 10) / 10),
  };
}

const hasWork = res => (res.tipo === 'tempo' ? res.serie.length > 0 : res.tipo === 'round' ? res.lavoroSec > 0 : res.durataSec > 0);

// Salva il risultato dell'allenamento appena concluso e propone la valutazione.
function finishSession(completo) {
  const r = runner;
  if (!r || r.recorded || !r.startedAt) return;
  const res = buildResult(r, completo);
  if (!hasWork(res)) return;
  r.recorded = true;
  try { db.saveResult(db.compact(res)); } catch { return; }
  // In una scheda la valutazione si chiede una volta sola, alla fine.
  if (schedaRun) schedaRun.results.push(res.id);
  else enqueue(() => openFeedback([res.id]));
}

// Dopo una correzione delle serie (Entro il tempo) il risultato salvato si aggiorna.
function refreshResult(r) {
  if (!r.recorded) return;
  const old = db.getStorico().find(x => x.id === r.resultId);
  if (old) try { db.saveResult(db.compact({ ...old, ...buildResult(r, r.stato === 'fine') })); } catch { /* non critico */ }
}

function enqueue(open) {
  queue.push(open);
  runQueue();
}

function runQueue() {
  setTimeout(() => { if (!sheetKind && queue.length) queue.shift()(); }, 0);
}

// Valutazione di uno o più risultati (più risultati: una scheda intera).
function openFeedback(ids, schedaNome = '') {
  const storico = db.getStorico();
  const list = ids.map(id => storico.find(x => x.id === id)).filter(Boolean);
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
  const fromCoach = list.some(r => r.scheda && db.getScheda(r.scheda)?.ricevuta);
  const askReps = one && one.tipo !== 'tempo';
  const intro = one
    ? `<p><b>${esc(one.nome)}</b> — ${esc(resultLine(one))}</p>`
    : `<p><b>Scheda ${esc(schedaNome)}</b> · ${list.length} allenamenti</p>
       ${list.map(r => `<div class="kv"><span>${esc(r.nome)}</span></div><p class="sum">${esc(resultLine(r))}</p>`).join('')}`;
  openSheet('feedback', `
    <h2>Com'è andata?</h2>
    ${intro}
    <h3>Fatica (1 = facile, 10 = al limite)</h3>
    <div class="scale">${Array.from({ length: 10 }, (_, i) => `<button class="btn" data-f="${i + 1}" aria-pressed="${one?.fatica === i + 1}">${i + 1}</button>`).join('')}</div>
    ${askReps ? `<label class="field"><span>Ripetizioni totali (se le hai contate)</span><input type="number" inputmode="numeric" min="0" name="rip" value="${one.ripetizioni ?? ''}"></label>` : ''}
    ${one ? `<label class="field"><span>Peso usato (kg)</span><input type="number" inputmode="decimal" min="0" step="0.5" name="peso" value="${one.peso ?? ''}" placeholder="Facoltativo"></label>` : ''}
    <label class="field"><span>Nota</span><input type="text" name="nota" maxlength="200" placeholder="Facoltativa" value="${esc(one?.nota ?? '')}"></label>
    <div class="row">
      <button class="btn" data-act="skip">Salta</button>
      <button class="btn${fromCoach ? '' : ' primary'}" data-act="save">Salva</button>
    </div>
    <button class="btn block${fromCoach ? ' primary' : ''}" data-act="coach">Salva e invia al coach</button>`, panel => {
    let fatica = one?.fatica ?? null;
    panel.querySelectorAll('[data-f]').forEach(b => {
      b.onclick = () => {
        fatica = Number(b.dataset.f);
        panel.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      };
    });
    const save = () => {
      const rip = panel.querySelector('[name=rip]')?.value;
      const nota = panel.querySelector('[name=nota]').value.trim();
      const peso = panel.querySelector('[name=peso]');
      const out = list.map(res => {
        const extra = askReps ? { ripetizioni: rip === '' || rip == null ? null : rip } : {};
        if (peso) extra.peso = peso.value;
        const upd = db.cleanResult({ ...res, fatica, nota, ...extra });
        if (upd) try { db.saveResult(upd); } catch { /* non critico */ }
        return upd ?? res;
      });
      if (mode === 'andamento') renderReport();
      return out;
    };
    panel.querySelector('[data-act=skip]').onclick = closeSheet;
    panel.querySelector('[data-act=save]').onclick = () => { save(); closeSheet(); };
    panel.querySelector('[data-act=coach]').onclick = () => { const rs = save(); closeSheet(); sendToCoach(rs); };
  });
}

// --- Condivisione -----------------------------------------------------------

// Menu di condivisione del telefono; se non disponibile o bloccato, un pannello con WhatsApp e Copia.
async function shareMessage(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  openSheet('share', `
    <h2>Invia</h2>
    <p>Scegli come inviare il messaggio.</p>
    <textarea class="share-text" readonly>${esc(text)}</textarea>
    <div class="row">
      <button class="btn" data-act="copy">Copia</button>
      <a class="btn primary" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp</a>
    </div>
    ${navigator.share ? '<button class="btn block" data-act="share">Altre app…</button>' : ''}
    <button class="btn block" data-act="close">Chiudi</button>`, panel => {
    panel.querySelector('[data-act=copy]').onclick = async e => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copiato'; } catch {
        panel.querySelector('textarea').select();
      }
    };
    const more = panel.querySelector('[data-act=share]');
    if (more) more.onclick = () => navigator.share({ text }).catch(() => {});
  });
}

async function sendToCoach(results) {
  if (!results.length) return;
  if (!settings.nomeAtleta && !settings.nomeChiesto) {
    const nome = (prompt('Il tuo nome per il coach (facoltativo, puoi cambiarlo nelle Impostazioni):', '') || '').trim().slice(0, 40);
    settings = { ...settings, nomeAtleta: nome, nomeChiesto: true };
    db.saveSettings(settings);
  }
  const atleta = settings.nomeAtleta;
  const link = await encodeLink('risultati', { v: 1, atleta, risultati: results.slice(-60) });
  await shareMessage(`${coachMessage(results, atleta)}\n\nApri in Tempro: ${link}`);
}

// --- Modello di vista per ciascuna modalità ---------------------------------
// { type, name, time, sub, frac, total, stats[3], icon, label, left, aux }

const runLabel = (run, started) => ({ icon: run ? 'pause' : 'play', label: run ? 'Pausa' : started ? 'Riprendi' : 'Avvia' });

function vmRound() {
  const s = runner.state(), started = runner.clock.ms > 0, t = tpl;
  const aux = { icon: 'skip', label: 'Salta fase', act: 'skip', disabled: !started || s.done };
  if (s.done) {
    return {
      type: 'fine', name: 'FINE', time: fmt(0), sub: `Totale ${fmt(runner.total)}`, frac: 1, total: 'Completato',
      stats: [
        { k: 'Round', v: String(t.roundPerCiclo), of: `/${t.roundPerCiclo}` },
        { k: 'Ciclo', v: String(t.cicli), of: `/${t.cicli}` },
        { k: 'Poi', v: 'Fine' },
      ],
      icon: 'replay', label: 'Ricomincia', left: null, aux,
    };
  }
  const p = s.phase, n = s.next;
  const last = p.type === 'rinfrescati';
  return {
    type: p.type, name: PHASES[p.type].label,
    time: fmt(s.phaseRemaining, { ceil: true }),
    sub: `di ${fmt(p.duration)}`,
    frac: s.phaseRemaining / p.duration,
    total: `Totale rimasto ${fmt(s.totalRemaining, { ceil: true })}`,
    stats: [
      { k: 'Round', v: String(p.round ?? (last ? t.roundPerCiclo : 1)), of: `/${t.roundPerCiclo}` },
      { k: 'Ciclo', v: String(p.ciclo ?? (last ? t.cicli : 1)), of: `/${t.cicli}` },
      n ? { k: `Poi: ${SHORT[n.type]}`, v: fmtShort(n.duration), type: n.type } : { k: 'Poi', v: 'Fine' },
    ],
    ...runLabel(runner.clock.running, started), left: null, aux,
  };
}

function vmTempo() {
  const r = runner, t = tpl, T = t.tempoTotale, tot = r.totale, diff = tot - t.obiettivo;
  const fatte = { k: inSec(t) ? 'Fatti' : 'Fatte', v: amount(t, tot), tap: r.serie.length ? openSeries : null };
  const manca = diff < 0 ? { k: 'Mancano', v: amount(t, -diff) } : { k: 'Oltre', v: signed(t, diff), type: 'lavoro' };
  const obiettivo = { k: 'Obiettivo', v: amount(t, t.obiettivo) };
  const riposo = { k: 'Riposo', v: fmtShort(t.riposo), type: 'riposo' };
  const base = { total: `Tempo rimasto ${fmt(r.totRemaining, { ceil: true })}`, left: null, aux: null };
  const pausable = { icon: r.paused ? 'play' : 'pause', label: r.paused ? 'Riprendi' : 'Pausa' };
  switch (r.stato) {
    case 'idle':
      return {
        ...base, type: t.prepara > 0 ? 'prepara' : 'lavoro', name: t.prepara > 0 ? 'PREPARA' : 'LAVORA',
        time: fmt(t.prepara > 0 ? t.prepara : T), sub: goalText(t), frac: 1,
        stats: [fatte, obiettivo, riposo], icon: 'play', label: 'Avvia',
      };
    case 'prepara':
      return {
        ...base, ...pausable, type: 'prepara', name: 'PREPARA',
        time: fmt(r.prepRemaining, { ceil: true }), sub: r.paused ? 'In pausa' : 'Si parte tra poco',
        frac: r.prepRemaining / t.prepara, stats: [fatte, obiettivo, riposo],
      };
    case 'lavoro':
      return {
        ...base, type: 'lavoro', name: 'LAVORA',
        time: fmt(r.totRemaining, { ceil: true }), sub: r.paused ? 'In pausa' : "Tocca l'anello a fine serie",
        frac: r.totRemaining / T,
        stats: [fatte, manca, { k: `Serie ${r.serie.length + 1}`, v: fmtShort(r.serieElapsed) }],
        icon: r.paused ? 'play' : 'check', label: r.paused ? 'Riprendi' : `Fine serie ${r.serie.length + 1}`,
        text: r.paused ? null : `Fine serie ${r.serie.length + 1}`,
        left: r.paused ? null : { icon: 'pause', label: 'Pausa', act: 'pause' },
      };
    case 'riposo':
      return {
        ...base, ...pausable, type: 'riposo', name: 'RIPOSA',
        time: fmt(r.restRemaining, { ceil: true }), sub: `Tempo rimasto ${fmt(r.totRemaining, { ceil: true })}`,
        frac: r.restRemaining / t.riposo,
        stats: [fatte, manca, { k: 'Poi', v: 'Lavoro', type: 'lavoro' }],
      };
    default:
      return {
        ...base, total: 'Completato', type: diff >= 0 ? 'lavoro' : 'riposo', name: diff >= 0 ? 'OBIETTIVO OK' : 'FINE',
        time: diff ? signed(t, diff) : '0', sub: `${amount(t, tot)} su ${amount(t, t.obiettivo)} in ${fmt(T)}`,
        frac: Math.min(1, tot / t.obiettivo),
        stats: [fatte, manca, { k: 'Serie', v: String(r.serie.length), tap: r.serie.length ? openSummary : null }],
        icon: 'replay', label: 'Ricomincia',
      };
  }
}

function vmCrono() {
  const s = runner.state(), run = runner.clock.running, started = runner.clock.ms > 0, t = tpl;
  // In una scheda il cronometro in avanti non finisce da solo: si passa al prossimo a mano.
  const next = schedaRun && t.direzione !== 'indietro' ? { icon: 'skip', label: 'Prossimo allenamento', act: 'next', disabled: !started } : null;
  const base = { left: null, aux: next, ...runLabel(run, started) };
  const prepara = !s.done && s.phase.type === 'prepara';
  const prep = prepara
    ? { type: 'prepara', name: 'PREPARA', time: fmt(s.phaseRemaining, { ceil: true }), sub: run || !started ? 'Si parte tra poco' : 'In pausa', frac: s.phaseRemaining / s.phase.duration }
    : null;

  if (t.direzione !== 'indietro') {
    const el = prepara ? 0 : s.phaseElapsed;
    const durs = laps.map((x, i) => x - (laps[i - 1] ?? 0));
    const v = {
      ...base,
      total: started && !prepara ? `Trascorso ${fmt(el)}` : 'Cronometro',
      stats: [
        { k: 'Giri', v: String(laps.length), tap: laps.length ? openLaps : null },
        { k: 'Ultimo giro', v: durs.length ? fmtTenths(durs.at(-1)) : '–' },
        { k: 'Migliore', v: durs.length ? fmtTenths(Math.min(...durs)) : '–', type: durs.length ? 'lavoro' : null },
      ],
      left: { icon: 'flag', label: 'Giro', act: 'lap', disabled: !(run && !prepara) },
    };
    if (prep) return { ...v, ...prep };
    return {
      ...v, type: 'cronometro', name: 'CRONOMETRO', time: fmt(el),
      sub: `Giro ${laps.length + 1} · ${fmtTenths(el - (laps.at(-1) ?? 0))}`, frac: (el % 60) / 60,
    };
  }

  const durata = t.durata;
  const stats = (trascorso, fine) => [
    { k: 'Durata', v: fmtShort(durata) },
    { k: 'Trascorso', v: fmtShort(trascorso) },
    { k: 'Fine alle', v: fine },
  ];
  if (s.done) {
    return {
      ...base, type: 'fine', name: 'FINE', time: fmt(0), sub: `Durata ${fmt(durata)}`, frac: 1,
      total: 'Completato', stats: stats(durata, '–'), icon: 'replay', label: 'Ricomincia',
    };
  }
  if (prep) return { ...base, ...prep, total: `Durata ${fmt(durata)}`, stats: stats(0, '–') };
  const rem = s.phaseRemaining;
  const fine = run ? new Date(Date.now() + rem * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '–';
  return {
    ...base, type: 'timer', name: 'TIMER', time: fmt(rem, { ceil: true }), sub: `di ${fmt(durata)}`, frac: rem / durata,
    total: `Rimasto ${fmt(rem, { ceil: true })}`, stats: stats(durata - rem, fine),
  };
}

function vmTransition() {
  const rem = Math.max(0, transition.dur - transition.clock.ms / 1000), run = transition.clock.running;
  return {
    type: 'riposo', name: 'RIPOSA', time: fmt(rem, { ceil: true }), sub: `Poi: ${tpl.nome}`,
    frac: rem / transition.dur, total: 'Riposo tra gli allenamenti',
    stats: [
      { k: 'Prossimo', v: String(schedaRun.idx + 1), of: `/${schedaRun.ids.length}` },
      { k: 'Tipo', v: TYPE_SHORT[tpl.tipo] },
      { k: 'Riposo', v: fmtShort(transition.dur), type: 'riposo' },
    ],
    icon: run ? 'pause' : 'play', label: run ? 'Pausa' : 'Riprendi',
    left: null, aux: { icon: 'skip', label: 'Inizia subito', act: 'skip-rest' },
  };
}

// --- Rendering --------------------------------------------------------------

const setText = (id, text) => { const e = $(id); if (e.textContent !== text) e.textContent = text; };
function setIcon(node, name) {
  if (node.dataset.icon !== name) { node.innerHTML = ICONS[name] ?? ''; node.dataset.icon = name; }
}

function renderStat(i, st) {
  setText(`stat-${i}-k`, st.k);
  setText(`stat-${i}-v`, st.v);
  setText(`stat-${i}-of`, st.of ?? '');
  const v = $(`stat-${i}-v`);
  v.style.color = st.type ? `var(--c-${st.type})` : '';
  v.parentElement.classList.toggle('small', (st.v + (st.of ?? '')).length > 5);
  $(`stat-${i}`).classList.toggle('tappable', !!st.tap);
}

// Un pulsante non disponibile si nasconde (resta il suo spazio, così il principale non si sposta).
function renderSide(id, b) {
  const node = $(id);
  const show = b && !b.disabled;
  node.style.visibility = show ? '' : 'hidden';
  node.disabled = !show;
  if (!show) return;
  setIcon(node, b.icon);
  node.dataset.act = b.act;
  node.setAttribute('aria-label', b.label);
}

function render() {
  if (!runner) return;
  const v = view = transition ? vmTransition() : tpl.tipo === 'round' ? vmRound() : tpl.tipo === 'tempo' ? vmTempo() : vmCrono();
  $('run-bar').hidden = !schedaRun;
  if (schedaRun) {
    const n = schedaRun.ids.length, i = schedaRun.idx, next = db.getTemplate(schedaRun.ids[i + 1] ?? '');
    setText('run-text', `${schedaRun.scheda.nome} · ${i + 1} di ${n}${next ? ` · poi: ${next.nome}` : ' · ultimo'}`);
  }
  setPhase(v.type);
  setText('tpl-name', tpl.peso ? `${tpl.nome} · ${kgLabel(tpl.peso)}` : tpl.nome);
  setText('total-time', v.total);
  setText('phase-label', v.name);
  setText('phase-time', v.time);
  $('phase-time').classList.toggle('long', v.time.length > 5);
  setText('phase-sub', v.sub);
  const frac = Math.min(1, Math.max(0, v.frac || 0));
  const arc = $('ring-arc');
  arc.setAttribute('stroke-dasharray', `${(RING * frac).toFixed(1)} ${RING.toFixed(1)}`);
  arc.style.opacity = frac > 0.002 ? '1' : '0';
  v.stats.forEach((st, i) => renderStat(i + 1, st));
  const main = $('btn-main'), key = `${v.icon}|${v.text ?? ''}`;
  if (main.dataset.key !== key) {
    main.innerHTML = (ICONS[v.icon] ?? '') + (v.text ? `<span>${esc(v.text)}</span>` : '');
    main.dataset.key = key;
    main.classList.toggle('wide', !!v.text);
  }
  main.setAttribute('aria-label', v.label);
  // Il tocco sull'anello fa l'azione principale, tranne a fine allenamento (non deve ricominciare per sbaglio).
  $('ring').setAttribute('aria-label', v.icon === 'replay' ? `${v.name} ${v.time}` : `${v.label} — ${v.name} ${v.time}`);
  // Azzera compare a sinistra solo con il timer in pausa a metà allenamento.
  const left = !transition && isActive() && !isRunning() ? { icon: 'reset', label: 'Azzera', act: 'reset' } : v.left;
  renderSide('btn-left', left);
  renderSide('btn-aux', v.aux);
  if (cam.active) {
    setText('rec-time', fmt(cam.recordedSec));
    $('rec').classList.toggle('paused', !cam.recording);
  }
}

// Foto e video dell'esercizio: pulsante nell'intestazione, visibile solo se il modello li ha.
function updateMedia() {
  const has = !!(safeImg(tpl.immagine) || safeUrl(tpl.video));
  const b = $('btn-media');
  b.style.visibility = has ? '' : 'hidden';
  b.disabled = !has;
}

// --- Pannelli (sheet) -------------------------------------------------------

function openSheet(kind, html, mount, { dismissable = true } = {}) {
  sheetKind = kind;
  sheetDismiss = dismissable;
  const panel = $('sheet-panel');
  // I pannelli che si possono chiudere hanno sempre la ✕ in alto, raggiungibile anche se sono lunghi.
  panel.innerHTML = (dismissable ? `<button class="sheet-x" data-act="close" aria-label="Chiudi">${ICONS.close}</button>` : '') + html;
  panel.scrollTop = 0;
  $('sheet').hidden = false;
  panel.querySelectorAll('[data-act=close]').forEach(b => { b.onclick = closeSheet; });
  mount?.(panel);
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-panel').innerHTML = '';
  sheetKind = null;
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
  if (queue.length) runQueue();
}

// --- Ripresa video ----------------------------------------------------------

async function startPreview() {
  const msg = $('cam-msg'), go = $('cam-go'), flip = $('cam-flip'), audio = $('cam-audio');
  // Durante l'avvio niente altri comandi, per non aprire due fotocamere insieme.
  go.disabled = flip.disabled = audio.disabled = true;
  msg.textContent = 'Avvio della fotocamera…';
  try {
    const stream = await cam.open({ facing, audio: $('cam-audio').checked });
    for (const id of ['cam-full', 'cam-small']) {
      const v = $(id);
      v.srcObject = stream;
      v.classList.toggle('mirror', facing === 'user');
      v.play?.().catch(() => {});
    }
    msg.textContent = "Appoggia il telefono e controlla l'inquadratura. Verranno registrate solo le fasi di lavoro.";
    go.disabled = false;
  } catch (e) {
    msg.textContent = e.name === 'NotAllowedError'
      ? 'Permesso negato. Consenti la fotocamera per questo sito nelle impostazioni del browser, oppure continua senza video.'
      : 'Fotocamera non disponibile. Puoi continuare senza video.';
  } finally {
    flip.disabled = audio.disabled = false;
  }
}

function openFraming() {
  facing = tpl.fotocamera === 'environment' ? 'environment' : 'user';
  $('cam-audio').checked = tpl.audio !== false;
  $('camera').hidden = false;
  startPreview();
}

function closeFraming() {
  $('camera').hidden = true;
  $('cam-full').srcObject = null;
}

$('cam-flip').addEventListener('click', () => { facing = facing === 'user' ? 'environment' : 'user'; startPreview(); });
$('cam-audio').addEventListener('change', startPreview);
$('cam-skip').addEventListener('click', () => {
  cam.closeStream();
  closeFraming();
  startTimer();
});
$('cam-go').addEventListener('click', () => {
  // Le scelte fatte qui diventano quelle predefinite del modello.
  const audio = $('cam-audio').checked;
  if ((tpl.fotocamera !== facing || tpl.audio !== audio) && db.getTemplate(tpl.id)) {
    tpl = { ...tpl, fotocamera: facing, audio };
    try { db.saveTemplate(tpl); } catch { /* non critico */ }
  }
  closeFraming();
  cam.begin(schedaRun ? schedaRun.scheda.nome : tpl.nome);
  $('rec-time').textContent = '00:00';
  $('cam-mini').hidden = false;
  startTimer();
});

async function endRecording() {
  if (!cam.active || schedaRun) return;   // in una scheda il video prosegue fino alla fine
  $('cam-mini').hidden = true;
  $('cam-small').srcObject = null;
  try {
    const meta = await cam.finish();
    if (meta) enqueue(() => openVideoSheet(meta));
  } catch {
    alert('Non è stato possibile completare il video: memoria del telefono piena?');
  }
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function openVideoSheet(meta) {
  openSheet('video', '<h2>Video dei lavori</h2><p>Preparazione del video…</p>', null, { dismissable: false });
  let blob;
  try { blob = await videoStore.blob(meta); } catch { blob = null; }
  if (sheetKind !== 'video') return;
  if (!blob?.size) {
    await videoStore.remove(meta.id).catch(() => {});
    openSheet('video', '<h2>Video dei lavori</h2><p>Non è stato registrato nulla.</p><button class="btn block primary" data-act="close">Chiudi</button>');
    return;
  }
  const ext = meta.mime.includes('mp4') ? 'mp4' : 'webm';
  const slug = meta.nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'allenamento';
  const file = new File([blob], `tempro-${slug}-${meta.creato.slice(0, 10)}.${ext}`, { type: blob.type || `video/${ext}` });
  videoUrl = URL.createObjectURL(blob);
  const when = new Date(meta.creato).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  openSheet('video', `
    <h2>Video dei lavori</h2>
    <video class="media-video" src="${videoUrl}" controls playsinline></video>
    <div class="kv"><span>${esc(meta.nome)} · ${when}</span><b>${fmt(meta.durata)} · ${Math.max(1, Math.round(blob.size / 1048576))} MB</b></div>
    <p id="vid-msg">Il video non resta nell'app: salvalo nel Rullino o condividilo prima di chiudere.</p>
    <div class="row">
      <button class="btn danger" data-act="discard">Scarta</button>
      <button class="btn primary" data-act="save">Salva</button>
    </div>`, panel => {
    const msg = panel.querySelector('#vid-msg');
    const saved = () => {
      msg.textContent = 'Salvato. Puoi salvarlo di nuovo o chiudere: chiudendo viene tolto dalla memoria dell\'app.';
      const discard = panel.querySelector('[data-act=discard]');
      discard.textContent = 'Chiudi';
      discard.className = 'btn';
      discard.onclick = async () => { await videoStore.remove(meta.id).catch(() => {}); closeSheet(); };
    };
    panel.querySelector('[data-act=save]').onclick = async () => {
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); saved(); return; } catch (e) {
          if (e.name === 'AbortError') return;
        }
      }
      download(file);
      saved();
    };
    panel.querySelector('[data-act=discard]').onclick = async () => {
      if (!(await ask('Eliminare il video? Non potrà essere recuperato.', { ok: 'Elimina', danger: true }))) return;
      await videoStore.remove(meta.id).catch(() => {});
      closeSheet();
    };
  }, { dismissable: false });
}

function openReps(i) {
  const r = runner;
  const fine = r.stato === 'fine';
  const sec = inSec(r.tpl);
  const prev = r.serie.slice(0, i).reverse().find(s => s.reps !== null);
  // In secondi si propone la durata cronometrata della serie; in ripetizioni il valore della serie prima.
  const measured = Math.round(r.serie[i].fine - r.serie[i].inizio);
  const val = r.serie[i].reps ?? (sec ? measured : prev?.reps ?? 0);
  openSheet('reps', `
    <div class="reps">
      <h2>Serie ${i + 1}</h2>
      <p>${sec ? `Quanti secondi hai tenuto? Cronometrati: ${fmtShort(measured)}.` : 'Quante esecuzioni hai fatto?'}${fine ? '' : ' Il riposo è già partito.'}</p>
      <input id="reps-val" class="reps-num" type="number" inputmode="numeric" min="0" value="${val}" aria-label="${sec ? 'Secondi' : 'Esecuzioni'}">
      ${sec ? '<p>secondi</p>' : ''}
      <div class="reps-btns">
        <button class="btn" data-d="-5">−5</button><button class="btn" data-d="-1">−1</button>
        <button class="btn" data-d="1">+1</button><button class="btn" data-d="5">+5</button>
      </div>
      <div class="row">
        <button class="btn" data-act="later">${fine ? 'Nessuna (0)' : 'Dopo'}</button>
        <button class="btn primary" data-act="save">Salva</button>
      </div>
    </div>`, panel => {
    const inp = panel.querySelector('#reps-val');
    panel.querySelectorAll('[data-d]').forEach(b => {
      b.onclick = () => { inp.value = Math.max(0, int(inp.value) + Number(b.dataset.d)); };
    });
    const done = reps => {
      if (r !== runner) return closeSheet();
      if (reps !== null) r.serie[i].reps = reps;
      refreshResult(r);
      closeSheet();
      if (r.stato === 'fine') continueFine();
      render();
    };
    panel.querySelector('[data-act=save]').onclick = () => done(int(inp.value));
    panel.querySelector('[data-act=later]').onclick = () => done(fine ? 0 : null);
  }, { dismissable: !fine });
}

function serieTable(r) {
  const t = r.tpl;
  const rows = r.serie.map((s, i) => `
    <tr data-i="${i}"><td>${i + 1}</td><td>${s.reps == null ? '–' : amount(t, s.reps)}</td><td>${fmt(s.fine - s.inizio)}</td><td>${fmt(s.fine)}</td></tr>`).join('');
  return `<table class="serie"><tr><th>Serie</th><th>${inSec(t) ? 'Tenuti' : 'Esecuzioni'}</th><th>Durata</th><th>Al minuto</th></tr>${rows}</table>
    <p>Tocca una serie per correggerla.</p>`;
}

function bindSerieRows(panel) {
  panel.querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => openReps(Number(tr.dataset.i)); });
}

function openSeries() {
  const r = runner;
  if (r.stato === 'fine') return openSummary();
  openSheet('series', `<h2>Serie</h2>${serieTable(r)}<button class="btn block primary" data-act="close">Chiudi</button>`, bindSerieRows);
}

function openSummary() {
  const r = runner, t = tpl, tot = r.totale, diff = tot - t.obiettivo;
  const al = r.obiettivoRaggiuntoAl();
  const res = diff > 0 ? `${signed(t, diff)} oltre l'obiettivo` : diff === 0 ? 'Obiettivo centrato' : `${amount(t, -diff)} in meno`;
  const mean = r.serie.length ? tot / r.serie.length : 0;
  const media = inSec(t) ? fmtShort(mean) : mean.toFixed(1).replace('.', ',');
  openSheet('summary', `
    <h2>Risultato · ${esc(t.nome)}</h2>
    <div class="result ${diff >= 0 ? 'ok' : 'ko'}">${res}</div>
    <div class="kv"><span>${inSec(t) ? 'Tempo di esercizio' : 'Esecuzioni fatte'}</span><b>${amount(t, tot)}</b></div>
    <div class="kv"><span>Obiettivo</span><b>${amount(t, t.obiettivo)} in ${fmt(t.tempoTotale)}</b></div>
    ${al !== null ? `<div class="kv"><span>Obiettivo raggiunto a</span><b>${fmt(al)}</b></div>` : ''}
    <div class="kv"><span>Serie</span><b>${r.serie.length}</b></div>
    <div class="kv"><span>Media per serie</span><b>${media}</b></div>
    <h3>Serie</h3>
    ${serieTable(r)}
    <button class="btn block primary" data-act="close">Chiudi</button>`, bindSerieRows);
}

function openLaps() {
  const rows = laps.map((t, i) => `<tr><td>${i + 1}</td><td>${fmtTenths(t - (laps[i - 1] ?? 0))}</td><td>${fmtTenths(t)}</td></tr>`).join('');
  openSheet('laps', `
    <h2>Giri</h2>
    <table class="serie"><tr><th>Giro</th><th>Tempo giro</th><th>Totale</th></tr>${rows}</table>
    <button class="btn block primary" data-act="close">Chiudi</button>`);
}

function youtubeId(u) {
  const m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m?.[1] ?? null;
}

function openMedia() {
  const img = safeImg(tpl.immagine), vid = safeUrl(tpl.video);
  let html = `<h2>${esc(tpl.nome)}</h2>`;
  if (img) html += `<img class="media-img" src="${esc(img)}" alt="Esercizio">`;
  if (vid) {
    const yt = youtubeId(vid);
    if (yt) html += `<iframe class="media-video" src="https://www.youtube-nocookie.com/embed/${yt}?playsinline=1" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    else if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(vid)) html += `<video class="media-video" src="${esc(vid)}" controls playsinline></video>`;
    html += `<div class="row"><a class="btn" href="${esc(vid)}" target="_blank" rel="noopener">Apri video ↗</a></div>`;
  }
  html += '<button class="btn block primary" data-act="close">Chiudi</button>';
  openSheet('media', html);
}

function goalText(t) {
  return inSec(t) ? `${fmtShort(t.obiettivo)} di esercizio in ${fmt(t.tempoTotale)}` : `${t.obiettivo} esecuzioni in ${fmt(t.tempoTotale)}`;
}

function summary(t) {
  const s = baseSummary(t);
  return t.peso ? `${s} · ${kgLabel(t.peso)}` : s;
}

function baseSummary(t) {
  if (t.tipo === 'round') {
    const total = buildRoundPhases(t).reduce((a, p) => a + p.duration, 0);
    return `Lavoro ${fmtShort(t.lavoro)} · Riposo ${fmtShort(t.riposo)} · ${t.roundPerCiclo} round × ${t.cicli} ${t.cicli === 1 ? 'ciclo' : 'cicli'} · Totale ${fmt(total)}`;
  }
  if (t.tipo === 'tempo') return `${goalText(t)} · Riposo ${fmtShort(t.riposo)}`;
  return t.direzione === 'indietro' ? `Conto alla rovescia ${fmt(t.durata)}` : 'Cronometro in avanti con giri';
}

function openPicker() {
  if (!tpl) return;
  const list = db.getTemplates(tpl.tipo);
  const items = list.map(t => {
    const sch = db.schedaOf(t.id);
    return `
    <button class="card${t.id === tpl.id ? ' current' : ''}" data-id="${esc(t.id)}">
      <span class="info"><span class="name" style="display:block">${esc(t.nome)}</span><span class="sum" style="display:block">${sch ? `Scheda ${esc(sch.nome)} · ` : ''}${esc(summary(t))}</span></span>
    </button>`;
  }).join('') || '<div class="empty">Nessun modello salvato.</div>';
  openSheet('picker', `
    <h2>${db.TYPES[tpl.tipo].nome}</h2>
    ${items}
    <div class="row">
      <button class="btn" data-act="edit">Modifica questo</button>
      <button class="btn primary" data-act="new">+ Nuovo</button>
    </div>`, panel => {
    panel.querySelectorAll('.card[data-id]').forEach(b => {
      b.onclick = async () => {
        if (!(await confirmStop())) return;
        closeSheet();
        db.setSelected(tpl.tipo, b.dataset.id);
        loadMode(mode);
      };
    });
    panel.querySelector('[data-act=new]').onclick = () => openEditor(db.newTemplate(tpl.tipo), true);
    panel.querySelector('[data-act=edit]').onclick = () => openEditor(tpl, !db.getTemplate(tpl.id));
  });
}

// --- Modifica modello -------------------------------------------------------

function fileToDataURL(file, max = 800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Immagine non leggibile')); };
    img.src = url;
  });
}

function fieldHtml([k, kind, label], t) {
  if (kind === 'dur') {
    return `<label class="field"><span>${label}</span><span class="dur">
      <input type="number" inputmode="numeric" min="0" name="${k}_m" value="${Math.floor(t[k] / 60)}">min
      <input type="number" inputmode="numeric" min="0" max="59" name="${k}_s" value="${t[k] % 60}">s</span></label>`;
  }
  if (kind === 'num') {
    return `<label class="field"><span>${label}</span><input type="number" inputmode="numeric" min="${MIN[k] ?? 0}" name="${k}" value="${t[k]}"></label>`;
  }
  if (kind === 'unit') {
    return `<label class="field"><span>${label}</span><select name="${k}">
      <option value="ripetizioni"${t[k] !== 'secondi' ? ' selected' : ''}>Ripetizioni</option>
      <option value="secondi"${t[k] === 'secondi' ? ' selected' : ''}>Secondi</option>
    </select></label>`;
  }
  return `<label class="field"><span>${label}</span><select name="${k}">
      <option value="avanti"${t[k] === 'avanti' ? ' selected' : ''}>In avanti (con giri)</option>
      <option value="indietro"${t[k] === 'indietro' ? ' selected' : ''}>Conto alla rovescia</option>
    </select></label>`;
}

function openEditor(t, isNew) {
  let immagine = t.immagine || '';
  const urlImg = immagine.startsWith('data:') ? '' : immagine;
  openSheet('editor', `
    <h2>${isNew ? 'Nuovo modello' : 'Modifica'} · ${db.TYPES[t.tipo].nome}</h2>
    <form id="ed" novalidate>
      <label class="field"><span>Nome</span><input type="text" name="nome" value="${esc(t.nome)}" maxlength="40"></label>
      <label class="field"><span>Peso da usare (kg)</span><input type="number" inputmode="decimal" min="0" step="0.5" name="peso" value="${t.peso || ''}" placeholder="Facoltativo"></label>
      ${FIELDS[t.tipo].map(f => fieldHtml(f, t)).join('')}
      <h3>Esercizio (facoltativo)</h3>
      <label class="field"><span>Link video</span><input type="url" name="video" value="${esc(t.video)}" placeholder="https://youtube.com/…"></label>
      <label class="field"><span>Link immagine</span><input type="url" name="immagineUrl" value="${esc(urlImg)}" placeholder="https://…"></label>
      <div class="row">
        <label class="btn">Scegli foto<input type="file" accept="image/*" name="foto" hidden></label>
        <button type="button" class="btn danger" data-act="noimg">Rimuovi immagine</button>
      </div>
      <img id="ed-prev" class="img-preview" alt="">
      <h3>Video</h3>
      ${cameraSupported() ? '' : '<p>Questo browser non permette di registrare video.</p>'}
      <label class="field toggle"><span>Registra le fasi di lavoro</span><input type="checkbox" name="registra"${t.registra ? ' checked' : ''}></label>
      <label class="field"><span>Fotocamera</span><select name="fotocamera">
        <option value="user"${t.fotocamera !== 'environment' ? ' selected' : ''}>Frontale</option>
        <option value="environment"${t.fotocamera === 'environment' ? ' selected' : ''}>Posteriore</option>
      </select></label>
      <label class="field toggle"><span>Registra l'audio</span><input type="checkbox" name="audio"${t.audio !== false ? ' checked' : ''}></label>
      <div id="ed-err" class="error"></div>
      <div class="row">
        <button type="button" class="btn" data-act="close">Annulla</button>
        <button type="submit" class="btn primary">Salva</button>
      </div>
    </form>`, panel => {
    const form = panel.querySelector('#ed'), prev = panel.querySelector('#ed-prev'), err = panel.querySelector('#ed-err');
    const showPrev = () => {
      const src = safeImg(immagine);
      prev.hidden = !src;
      if (src) prev.src = src; else prev.removeAttribute('src');
    };
    showPrev();
    form.immagineUrl.oninput = () => { immagine = form.immagineUrl.value.trim(); showPrev(); };
    form.foto.onchange = async () => {
      const file = form.foto.files[0];
      if (!file) return;
      try {
        immagine = await fileToDataURL(file);
        form.immagineUrl.value = '';
        showPrev();
      } catch (e) { err.textContent = e.message; }
    };
    panel.querySelector('[data-act=noimg]').onclick = () => { immagine = ''; form.immagineUrl.value = ''; showPrev(); };

    form.onsubmit = e => {
      e.preventDefault();
      err.textContent = '';
      const fd = new FormData(form);
      const out = { ...t, nome: String(fd.get('nome')).trim() || db.TYPES[t.tipo].nome };
      for (const [k, kind, label] of FIELDS[t.tipo]) {
        if (kind === 'dur') out[k] = int(fd.get(`${k}_m`)) * 60 + int(fd.get(`${k}_s`));
        else if (kind === 'num') out[k] = int(fd.get(k));
        else out[k] = fd.get(k);
        const skip = k === 'durata' && out.direzione !== 'indietro';
        if (!skip && MIN[k] && out[k] < MIN[k]) {
          err.textContent = `"${label}" deve essere almeno ${MIN[k]}${kind === 'dur' ? ' secondo' : ''}.`;
          return;
        }
      }
      const video = String(fd.get('video')).trim();
      if (video && !safeUrl(video)) { err.textContent = 'Il link video deve iniziare con https://'; return; }
      if (immagine && !safeImg(immagine)) { err.textContent = 'Il link immagine deve iniziare con https://'; return; }
      out.video = video;
      out.immagine = immagine;
      out.peso = db.cleanKg(fd.get('peso'));
      out.registra = fd.get('registra') === 'on';
      out.fotocamera = fd.get('fotocamera') === 'environment' ? 'environment' : 'user';
      out.audio = fd.get('audio') === 'on';
      try { db.saveTemplate(out); } catch {
        err.textContent = "Spazio esaurito sul telefono: usa un'immagine più piccola o un link.";
        return;
      }
      closeSheet();
      if (mode === 'sessioni') renderSessions();
      else {
        if (isNew) db.setSelected(out.tipo, out.id);
        if (!isActive()) loadMode(mode);
      }
    };
  });
}

// --- Elenco modelli ---------------------------------------------------------

let modelsFilter = 'tutti';   // Modelli: 'tutti' | 'schede' | tipo di modello

// Scheda di un modello: un tocco sul nome apre la modifica; restano in vista solo Avvia e ⋯.
function templateCard(t, { compact = false, n = 0 } = {}) {
  const img = safeImg(t.immagine);
  const id = esc(t.id);
  const extra = `${t.video ? ' · video esercizio' : ''}${t.registra ? ' · ripresa dei lavori' : ''}`;
  return `<div class="card${compact ? ' sub' : ''}">
    ${img ? `<div class="thumb" style="background-image:${esc(cssUrl(img))}"></div>` : ''}
    <div class="info">
      <button class="card-main" data-act="edit" data-id="${id}" aria-label="Modifica ${esc(t.nome)}">
        <span class="name">${n ? `${n}. ` : ''}${esc(t.nome)}</span>
        <span class="sum">${esc(db.TYPES[t.tipo].nome)} · ${esc(summary(t))}${extra}</span>
      </button>
      <div class="actions">
        <button class="btn primary" data-act="start" data-id="${id}">${ICONS.playSmall} Avvia</button>
        <button class="btn icon" data-act="menu" data-id="${id}" aria-label="Altre azioni per ${esc(t.nome)}">⋯</button>
      </div>
    </div>
  </div>`;
}

function schedaCard(s) {
  const modelli = s.modelli.map(db.getTemplate).filter(Boolean);
  const id = esc(s.id);
  const run = modelli.length ? `<button class="btn primary" data-act="sch-run" data-id="${id}">${ICONS.playSmall} Avvia scheda</button>` : '';
  const menu = `<button class="btn icon" data-act="sch-menu" data-id="${id}" aria-label="Altre azioni per la scheda ${esc(s.nome)}">⋯</button>`;
  if (s.ricevuta) {
    return `<div class="scheda">
      <div class="name">${esc(s.nome)}</div>
      <div class="sum">${s.coach ? `da ${esc(s.coach)} · ` : 'Ricevuta · '}${modelli.length} allenamenti · aggiornata il ${esc(dateLabel(s.data))}</div>
      ${s.nota ? `<p class="nota">${esc(s.nota)}</p>` : ''}
      <div class="actions">${run}${menu}</div>
      ${modelli.map((t, i) => templateCard(t, { compact: true, n: i + 1 })).join('')}
    </div>`;
  }
  return `<div class="scheda mine">
    <button class="card-main" data-act="sch-edit" data-id="${id}" aria-label="Modifica la scheda ${esc(s.nome)}">
      <span class="name">${esc(s.nome)}</span>
      <span class="sum">Creata da te${s.coach ? ` · coach ${esc(s.coach)}` : ''} · ${modelli.length} allenamenti</span>
      <span class="sum">${modelli.map((t, i) => `${i + 1}. ${esc(t.nome)}`).join(' · ') || 'Nessun allenamento'}</span>
    </button>
    <div class="actions">
      ${run}
      <button class="btn" data-act="sch-share" data-id="${id}">Condividi</button>
      ${menu}
    </div>
  </div>`;
}

function renderSessions() {
  const schede = db.getSchede();
  const byType = Object.fromEntries(Object.keys(db.TYPES).map(tipo => [tipo, db.getTemplates(tipo).filter(t => !db.isReceived(t.id))]));
  const counts = { schede: schede.length, ...Object.fromEntries(Object.entries(byType).map(([k, l]) => [k, l.length])) };
  if (modelsFilter !== 'tutti' && !counts[modelsFilter]) modelsFilter = 'tutti';
  const show = k => modelsFilter === 'tutti' || modelsFilter === k;
  const filters = [['tutti', 'Tutti'], ['schede', 'Schede'], ['round', 'Round'], ['tempo', 'A tempo'], ['cronometro', 'Crono']]
    .filter(([k]) => k === 'tutti' || counts[k]);

  let html = `<div class="page-head">
      ${WORDMARK}
      <div class="head-actions">
        <button class="round-btn" data-act="paste" aria-label="Incolla una scheda o dei risultati ricevuti">${ICONS.paste}</button>
        <button class="btn primary" data-act="new-any">+ Nuovo</button>
      </div>
    </div>
    <p class="hint">Modelli e schede salvati solo su questo telefono.</p>`;
  if (filters.length > 2) {
    html += `<div class="chips">${filters.map(([k, label]) =>
      `<button class="chip" data-act="filter" data-k="${k}" aria-pressed="${modelsFilter === k}">${label}</button>`).join('')}</div>`;
  }
  if (show('schede') && schede.length) {
    html += `<h2 class="section-title">Schede</h2>${schede.map(schedaCard).join('')}`;
  }
  const tipi = Object.keys(db.TYPES).filter(k => show(k) && counts[k]);
  if (tipi.length) {
    if (modelsFilter === 'tutti') html += '<h2 class="section-title">Modelli</h2>';
    for (const tipo of tipi) {
      html += `<h3 class="section-sub">${db.TYPES[tipo].nome}</h3>${byType[tipo].map(t => templateCard(t)).join('')}`;
    }
  }
  if (!schede.length && !tipi.length) {
    html += '<p class="hint">Nessun modello. Tocca <b>+ Nuovo</b> per crearne uno.</p>';
  }
  $('sessions-view').innerHTML = html;
}

// "+ Nuovo": prima si sceglie cosa creare.
function openNewChooser() {
  const opt = (k, title, desc) => `<button class="choice" data-k="${k}"><b>${title}</b><span>${desc}</span></button>`;
  openSheet('new', `
    <h2>Nuovo</h2>
    ${opt('round', 'Round', 'Lavoro e riposo a tempo fisso, per round e cicli (es. Tabata)')}
    ${opt('tempo', 'Entro il tempo', 'Un obiettivo di ripetizioni o secondi in un tempo massimo')}
    ${opt('cronometro', 'Cronometro', 'In avanti con i giri, oppure conto alla rovescia')}
    ${opt('scheda', 'Scheda', 'Più allenamenti da eseguire in sequenza o da inviare a un atleta')}`, panel => {
    panel.querySelectorAll('.choice').forEach(b => {
      b.onclick = () => {
        if (b.dataset.k === 'scheda') openSchedaEditor(null);
        else openEditor(db.newTemplate(b.dataset.k), true);
      };
    });
  });
}

// Menu ⋯ di un modello.
function openTemplateMenu(t) {
  const received = db.isReceived(t.id);
  openSheet('menu', `
    <h2>${esc(t.nome)}</h2>
    <button class="choice" data-k="start"><b>Avvia</b></button>
    <button class="choice" data-k="edit"><b>Modifica</b></button>
    <button class="choice" data-k="dup"><b>Duplica</b><span>${received ? 'Crea una copia tra i tuoi modelli' : 'Crea una copia da modificare'}</span></button>
    ${received ? '' : '<button class="choice danger" data-k="del"><b>Elimina</b></button>'}`, panel => {
    panel.querySelectorAll('.choice').forEach(b => {
      b.onclick = async () => {
        switch (b.dataset.k) {
          case 'start': closeSheet(); db.setSelected(t.tipo, t.id); loadMode(t.tipo); break;
          case 'edit': openEditor(t, false); break;
          case 'dup': closeSheet(); db.duplicateTemplate(t.id); renderSessions(); break;
          case 'del':
            if (!(await ask(`Eliminare "${t.nome}"?`, { ok: 'Elimina', danger: true }))) return;
            closeSheet();
            db.deleteTemplate(t.id);
            renderSessions();
            break;
        }
      };
    });
  });
}

// Menu ⋯ di una scheda.
function openSchedaMenu(s) {
  openSheet('menu', `
    <h2>${esc(s.nome)}</h2>
    ${s.ricevuta ? '' : '<button class="choice" data-k="edit"><b>Modifica</b><span>Nome, coach, nota e ordine degli allenamenti</span></button>'}
    <button class="choice danger" data-k="del"><b>Elimina scheda</b><span>${s.ricevuta ? 'Elimina anche i suoi allenamenti; il tuo storico resta' : 'Gli allenamenti restano tra i tuoi modelli'}</span></button>`, panel => {
    panel.querySelectorAll('.choice').forEach(b => {
      b.onclick = async () => {
        if (b.dataset.k === 'edit') { openSchedaEditor(s); return; }
        const msg = s.ricevuta
          ? `Eliminare la scheda "${s.nome}" e i suoi allenamenti? Il tuo storico resta.`
          : `Eliminare la scheda "${s.nome}"? Gli allenamenti restano tra i tuoi modelli.`;
        if (!(await ask(msg, { ok: 'Elimina', danger: true }))) return;
        closeSheet();
        db.deleteScheda(s.id);
        renderSessions();
      };
    });
  });
}

$('sessions-view').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const t = db.getTemplate(b.dataset.id);
  const s = db.getScheda(b.dataset.id);
  switch (b.dataset.act) {
    case 'new-any': openNewChooser(); break;
    case 'filter': modelsFilter = b.dataset.k; renderSessions(); break;
    case 'start': db.setSelected(t.tipo, t.id); loadMode(t.tipo); break;
    case 'edit': openEditor(t, false); break;
    case 'menu': openTemplateMenu(t); break;
    case 'paste': openPaste(); break;
    case 'sch-edit': openSchedaEditor(s); break;
    case 'sch-share': shareScheda(s); break;
    case 'sch-run': startScheda(s); break;
    case 'sch-menu': openSchedaMenu(s); break;
  }
});

// --- Schede: creazione, condivisione, ricezione ------------------------------

function openSchedaEditor(s) {
  const isNew = !s;
  const sc = s ?? { id: db.uid(), nome: '', coach: settings.nomeCoach || '', nota: '', ricevuta: false, modelli: [] };
  const personal = db.getTemplates().filter(t => !db.isReceived(t.id));
  const groups = Object.entries(db.TYPES).map(([tipo, def]) => {
    const list = personal.filter(t => t.tipo === tipo);
    if (!list.length) return '';
    return `<h3>${def.nome}</h3>${list.map(t => `
      <label class="field toggle"><span>${esc(t.nome)}<br><small class="sum">${esc(summary(t))}</small></span>
        <input type="checkbox" name="m" value="${esc(t.id)}"${sc.modelli.includes(t.id) ? ' checked' : ''}></label>`).join('')}`;
  }).join('');
  openSheet('scheda', `
    <h2>${isNew ? 'Nuova scheda' : 'Modifica scheda'}</h2>
    <form id="sch" novalidate>
      <label class="field"><span>Nome</span><input type="text" name="nome" value="${esc(sc.nome)}" maxlength="60" placeholder="Es. Settimana 1"></label>
      <label class="field"><span>Coach</span><input type="text" name="coach" value="${esc(sc.coach)}" maxlength="40" placeholder="Facoltativo"></label>
      <label class="field"><span>Nota</span><input type="text" name="nota" value="${esc(sc.nota)}" maxlength="500" placeholder="Facoltativa"></label>
      <h3>Ordine di esecuzione</h3>
      <p>Con "Avvia scheda" gli allenamenti partono uno dopo l'altro in quest'ordine; tra uno e l'altro c'è il riposo dell'allenamento appena finito. Trascina la maniglia ≡ per riordinare.</p>
      <div id="sch-order"></div>
      <h3>Allenamenti</h3>
      <p>Scegli gli allenamenti da includere. Le foto caricate dal telefono non vengono inviate; i link a immagini e video sì.</p>
      ${groups || '<p>Crea prima qualche modello.</p>'}
      <div id="sch-err" class="error"></div>
      <div class="row">
        <button type="button" class="btn" data-act="close">Annulla</button>
        <button type="submit" class="btn primary">Salva</button>
      </div>
    </form>`, panel => {
    const form = panel.querySelector('#sch'), box = panel.querySelector('#sch-order');
    let order = sc.modelli.filter(id => personal.some(t => t.id === id));
    const drawOrder = () => {
      box.innerHTML = order.length ? order.map((id, i) => `
        <div class="order-row" data-id="${esc(id)}">
          <span class="drag-handle" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>
          </span>
          <span class="order-n">${i + 1}</span>
          <span class="order-name">${esc(db.getTemplate(id).nome)}</span>
          <button type="button" class="btn small" data-move="${i}" data-d="-1" aria-label="Sposta su"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="btn small" data-move="${i}" data-d="1" aria-label="Sposta giù"${i === order.length - 1 ? ' disabled' : ''}>↓</button>
        </div>`).join('') : '<p>Nessun allenamento scelto.</p>';
    };
    drawOrder();
    box.onclick = e => {
      const b = e.target.closest('[data-move]');
      if (!b) return;
      const i = Number(b.dataset.move), j = i + Number(b.dataset.d);
      [order[i], order[j]] = [order[j], order[i]];
      drawOrder();
    };
    // Trascinamento dalla maniglia ≡: la riga segue il dito e le altre si spostano al passaggio.
    box.addEventListener('pointerdown', e => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      e.preventDefault();
      const row = handle.closest('.order-row');
      row.classList.add('dragging');
      // Il gesto si segue su tutta la pagina: spostando la riga nel DOM la maniglia perderebbe il puntatore.
      const move = ev => {
        if (ev.pointerId !== e.pointerId) return;
        ev.preventDefault();
        const others = [...box.querySelectorAll('.order-row:not(.dragging)')];
        const before = others.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (before) { if (row.nextElementSibling !== before) box.insertBefore(row, before); }
        else if (box.lastElementChild !== row) box.appendChild(row);
        box.querySelectorAll('.order-n').forEach((n, i) => { n.textContent = i + 1; });
      };
      const end = ev => {
        if (ev.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        row.classList.remove('dragging');
        order = [...box.querySelectorAll('.order-row')].map(r => r.dataset.id);
        drawOrder();
      };
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
    form.querySelectorAll('[name=m]').forEach(c => {
      c.onchange = () => {
        order = c.checked ? order.concat(c.value) : order.filter(id => id !== c.value);
        drawOrder();
      };
    });
    form.onsubmit = e => {
      e.preventDefault();
      const fd = new FormData(form);
      const modelli = order.slice();
      const err = panel.querySelector('#sch-err');
      if (!modelli.length) { err.textContent = 'Scegli almeno un allenamento.'; return; }
      const out = {
        ...sc, nome: String(fd.get('nome')).trim() || 'Scheda', coach: String(fd.get('coach')).trim(),
        nota: String(fd.get('nota')).trim(), modelli,
      };
      try { db.saveScheda(out); } catch { err.textContent = 'Spazio esaurito sul telefono.'; return; }
      if (out.coach !== settings.nomeCoach) { settings = { ...settings, nomeCoach: out.coach }; db.saveSettings(settings); }
      closeSheet();
      renderSessions();
    };
  });
}

async function shareScheda(s) {
  const p = db.schedaPayload(s);
  if (!p.modelli.length) { alert('La scheda non contiene allenamenti.'); return; }
  const link = await encodeLink('scheda', p);
  const righe = p.modelli.map(m => `• ${m.nome}`).join('\n');
  await shareMessage(`Scheda "${p.nome}"${p.coach ? ` di ${p.coach}` : ''} — ${p.modelli.length} allenamenti:\n${righe}${p.nota ? `\n\n${p.nota}` : ''}\n\nAprila con Tempro: ${link}`);
}

// Pulsante "Copia per l'app": in Safari su iPhone la memoria è separata da quella dell'app sulla Home.
function iosCopyBlock(text) {
  if (!isIosBrowser()) return '';
  return `<p class="nota">Hai Tempro sulla schermata Home? Safari e l'app hanno memorie separate: tocca <b>Copia per l'app</b>, poi apri Tempro dalla Home e nella pagina Modelli premi <b>Incolla una scheda o dei risultati</b>.</p>
    <button class="btn block" data-act="copy-app" data-text="${esc(text)}">Copia per l'app</button>`;
}

function bindCopy(panel) {
  const b = panel.querySelector('[data-act=copy-app]');
  if (b) b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.text); b.textContent = 'Copiato: ora apri Tempro dalla Home'; } catch {
      b.textContent = 'Copia non riuscita';
    }
  };
}

async function handleIncoming(text, fromLink = false) {
  let parsed;
  try { parsed = await decodeLink(text); } catch (e) {
    if (fromLink) history.replaceState(null, '', location.pathname + location.search);
    openSheet('error', `<h2>Link non leggibile</h2><p>${esc(e.message)}</p><button class="btn block primary" data-act="close">Chiudi</button>`);
    return true;
  }
  if (!parsed) return false;
  if (fromLink) history.replaceState(null, '', location.pathname + location.search);
  const link = String(text).match(/https?:\/\/\S+#[sr]=\S+/)?.[0] ?? `${location.origin}${location.pathname}${String(text).match(/#[sr]=\S+/)?.[0] ?? ''}`;
  if (parsed.kind === 'scheda') openSchedaPreview(parsed.data, link);
  else openRisultatiPreview(parsed.data, link);
  return true;
}

function openSchedaPreview(data, link) {
  let sc;
  try { sc = db.readScheda(data); } catch (e) {
    openSheet('error', `<h2>Scheda non valida</h2><p>${esc(e.message)}</p><button class="btn block primary" data-act="close">Chiudi</button>`);
    return;
  }
  const mine = sc.esistente === 'mia';
  openSheet('import', `
    <h2>Scheda "${esc(sc.nome)}"</h2>
    <p>${sc.coach ? `da <b>${esc(sc.coach)}</b> · ` : ''}${sc.modelli.length} allenamenti</p>
    ${sc.nota ? `<p class="nota">${esc(sc.nota)}</p>` : ''}
    ${sc.modelli.map(t => `<div class="kv"><span>${esc(t.nome)}</span><b>${esc(db.TYPES[t.tipo].nome)}</b></div>
      <p class="sum">${esc(summary(t))}</p>`).join('')}
    ${mine ? '<p>Questa scheda è stata creata su questo telefono.</p>' : ''}
    ${sc.esistente === 'ricevuta' ? '<p>Hai già questa scheda: verrà aggiornata con la nuova versione. Il tuo storico resta.</p>' : ''}
    ${mine ? '' : iosCopyBlock(link)}
    <div class="row">
      <button class="btn" data-act="close">${mine ? 'Chiudi' : 'Annulla'}</button>
      ${mine ? '' : `<button class="btn primary" data-act="import">${sc.esistente ? 'Aggiorna' : 'Importa'}</button>`}
    </div>`, panel => {
    bindCopy(panel);
    const imp = panel.querySelector('[data-act=import]');
    if (imp) imp.onclick = () => {
      try {
        const res = db.importScheda(sc);
        closeSheet();
        loadMode('sessioni');
        openSheet('ok', `<h2>${res.aggiornata ? 'Scheda aggiornata' : 'Scheda importata'}</h2>
          <p>"${esc(sc.nome)}" con ${res.n} allenamenti è nella pagina Modelli.</p>
          <button class="btn block primary" data-act="close">OK</button>`);
      } catch (e) { alert(e.message); }
    };
  });
}

function openRisultatiPreview(data, link) {
  const list = (Array.isArray(data?.risultati) ? data.risultati : []).map(db.cleanResult).filter(Boolean);
  const atleta = String(data?.atleta ?? '').trim().slice(0, 40) || 'Atleta senza nome';
  if (!list.length) {
    openSheet('error', '<h2>Nessun risultato</h2><p>Il link non contiene risultati validi.</p><button class="btn block primary" data-act="close">Chiudi</button>');
    return;
  }
  const rows = list.slice(-8).map(r => `<div class="kv"><span>${esc(dateLabel(r.data))} · ${esc(r.nome)}</span></div><p class="sum">${esc(resultLine(r))}</p>`).join('');
  openSheet('import', `
    <h2>Risultati di ${esc(atleta)}</h2>
    <p>${list.length} allenament${list.length === 1 ? 'o' : 'i'}${list[0].schedaNome ? ` · scheda "${esc(list[0].schedaNome)}"` : ''}</p>
    ${list.length > 8 ? `<p>Ultimi 8 di ${list.length}:</p>` : ''}${rows}
    ${iosCopyBlock(link)}
    <div class="row">
      <button class="btn" data-act="close">Annulla</button>
      <button class="btn primary" data-act="import">Aggiungi ai miei atleti</button>
    </div>`, panel => {
    bindCopy(panel);
    panel.querySelector('[data-act=import]').onclick = () => {
      try {
        const res = db.importRisultati(data);
        reportTab = 'atleti';
        reportAtleta = res.atleta;
        closeSheet();
        loadMode('andamento');
        openSheet('ok', `<h2>Risultati aggiunti</h2>
          <p>${res.nuovi} nuov${res.nuovi === 1 ? 'o' : 'i'} per ${esc(res.atleta)}${res.presenti ? `, ${res.presenti} già presenti` : ''}.</p>
          <button class="btn block primary" data-act="close">OK</button>`);
      } catch (e) { alert(e.message); }
    };
  });
}

// Incolla: legge gli appunti (iOS chiede conferma) oppure lascia incollare a mano.
async function openPaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (await handleIncoming(text)) return;
  } catch { /* permesso negato o non supportato: si incolla a mano */ }
  openSheet('paste', `
    <h2>Incolla</h2>
    <p>Incolla qui il messaggio o il link ricevuto (scheda dal coach o risultati di un atleta).</p>
    <textarea class="share-text" id="paste-text" placeholder="Tieni premuto e scegli Incolla"></textarea>
    <div id="paste-err" class="error"></div>
    <div class="row">
      <button class="btn" data-act="close">Annulla</button>
      <button class="btn primary" data-act="go">Apri</button>
    </div>`, panel => {
    panel.querySelector('[data-act=go]').onclick = async () => {
      const text = panel.querySelector('#paste-text').value;
      closeSheet();
      if (!(await handleIncoming(text))) openPaste.notFound();
    };
  });
}
openPaste.notFound = () => openSheet('error', `<h2>Nessun link trovato</h2>
  <p>Il testo non contiene un link di Tempro. Copia l'intero messaggio ricevuto e riprova.</p>
  <button class="btn block primary" data-act="close">Chiudi</button>`);

// --- Andamento --------------------------------------------------------------

function modelCard(m, own) {
  const s = seriesFor(m.results);
  const last = m.results.reduce((a, r) => (r.data > a.data ? r : a));
  return `<div class="card report-card">
    <div class="info">
      <div class="name">${esc(m.nome)}</div>
      <div class="sum">${esc(db.TYPES[m.tipo]?.nome ?? '')} · ${m.results.length} session${m.results.length === 1 ? 'e' : 'i'} · ultima ${esc(dateLabel(last.data))}: ${esc(resultLine(last))}</div>
      <h4 class="chart-title">${esc(s.name)}</h4>
      ${chartSvg(s)}
      <div class="actions"><button class="btn small" data-act="detail" data-key="${esc(m.key)}" data-own="${own ? 1 : 0}">Tutte le sessioni</button></div>
    </div>
  </div>`;
}

function tiles(results) {
  const st = stats(results);
  return `<div class="tiles">
    <div class="tile"><span class="tile-v">${st.settimana}</span><span class="tile-k">questa settimana</span></div>
    <div class="tile"><span class="tile-v">${st.giorni}</span><span class="tile-k">giorni di fila</span></div>
    <div class="tile"><span class="tile-v">${st.mese}</span><span class="tile-k">questo mese</span></div>
  </div>`;
}

function reportResults() {
  if (reportTab === 'atleti') return db.getAtleti().filter(r => r.atleta === reportAtleta);
  return db.getStorico();
}

function renderReport() {
  const atleti = [...new Set(db.getAtleti().map(r => r.atleta))];
  if (reportTab === 'atleti' && !atleti.includes(reportAtleta)) reportAtleta = atleti[0];
  const own = reportTab === 'miei';
  const results = reportResults();
  let html = '<h1 class="page-title">Andamento</h1>';
  html += `<div class="seg" role="tablist">
    <button role="tab" aria-selected="${own}" data-act="tab-miei">I miei</button>
    <button role="tab" aria-selected="${!own}" data-act="tab-atleti">Atleti${atleti.length ? ` (${atleti.length})` : ''}</button>
  </div>`;
  if (!own) {
    html += `<div class="chips">${atleti.map(a => `<button class="chip" aria-pressed="${a === reportAtleta}" data-act="atleta" data-name="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
  }
  if (!own && !atleti.length) {
    html += `<p class="hint">Qui vedrai i risultati che i tuoi atleti ti inviano dalla loro app. Quando ricevi un messaggio con un link di Tempro, aprilo oppure copialo e premi il pulsante qui sotto.</p>
      <button class="btn block" data-act="paste">Incolla dei risultati ricevuti</button>`;
  } else if (!results.length) {
    html += tiles([]) + '<p class="hint">Completa un allenamento per vedere qui il tuo andamento.</p>';
  } else {
    html += tiles(results);
    for (const g of groupResults(results)) {
      html += `<div class="group-head"><h2>${esc(g.nome)}</h2>
        ${own ? `<button class="btn small" data-act="send-group" data-scheda="${esc(g.id ?? '')}">Invia al coach</button>` : ''}</div>`;
      html += g.modelli.map(m => modelCard(m, own)).join('');
    }
    if (!own) html += `<button class="btn block" data-act="paste">Incolla altri risultati</button>
      <button class="btn block danger" data-act="del-atleta">Elimina i dati di ${esc(reportAtleta)}</button>`;
  }
  $('report-view').innerHTML = html;
}

function openDetail(key, own) {
  const results = reportResults().filter(r => r.modello === key).sort((a, b) => b.data.localeCompare(a.data));
  if (!results.length) return;
  const s = seriesFor(results);
  const rows = results.map(r => {
    const p = s.points.find(x => x.r === r);
    return `<tr class="tap" data-sess="${esc(r.id)}"><td>${esc(dateTimeLabel(r.data))}${r.nota ? `<br><small class="sum">${esc(r.nota)}</small>` : ''}</td>
      <td>${p ? esc(formatValue(s, p.y)) : '–'}${r.completo ? '' : '<br><small class="sum">interrotto</small>'}</td>
      <td>${r.fatica ?? '–'}</td>
      ${own ? `<td><button class="btn small danger" data-del="${esc(r.id)}" aria-label="Elimina sessione">✕</button></td>` : ''}</tr>`;
  }).join('');
  openSheet('detail', `
    <h2>${esc(results[0].nome)}</h2>
    <h4 class="chart-title">${esc(s.name)}</h4>
    ${chartSvg(s)}
    <h3>Sessioni</h3>
    <p>Tocca una sessione per vederne il dettaglio.</p>
    <table class="serie"><tr><th>Data</th><th>${esc(s.name)}</th><th>Fatica</th>${own ? '<th></th>' : ''}</tr>${rows}</table>
    ${own ? `<button class="btn block" data-act="send-model">Invia al coach</button>` : ''}
    <button class="btn block primary" data-act="close">Chiudi</button>`, panel => {
    panel.querySelectorAll('tr[data-sess]').forEach(tr => {
      tr.onclick = e => {
        if (e.target.closest('[data-del]')) return;
        openSession(tr.dataset.sess, own, () => openDetail(key, own));
      };
    });
    panel.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        if (!(await ask('Eliminare questa sessione dallo storico?', { ok: 'Elimina', danger: true }))) return;
        db.deleteResult(b.dataset.del);
        closeSheet();
        renderReport();
        openDetail(key, own);
      };
    });
    const send = panel.querySelector('[data-act=send-model]');
    if (send) send.onclick = () => { closeSheet(); sendToCoach(results.slice().reverse()); };
  });
}

// Dettaglio di una singola sessione, come a fine allenamento.
function openSession(id, own, back) {
  const r = reportResults().find(x => x.id === id);
  if (!r) return;
  const u = { unita: r.unita };
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  let body = '';
  if (r.tipo === 'tempo') {
    const diff = (r.fatte ?? 0) - (r.obiettivo ?? 0);
    const serie = r.serie ?? [];
    const timed = r.serieFine?.length === serie.length && r.serieInizio?.length === serie.length;
    const mean = serie.length ? (r.fatte ?? 0) / serie.length : 0;
    body = `<div class="result ${diff >= 0 ? 'ok' : 'ko'}">${diff > 0 ? `${signed(u, diff)} oltre l'obiettivo` : diff === 0 ? 'Obiettivo centrato' : `${amount(u, -diff)} in meno`}</div>
      ${kv(inSec(u) ? 'Tempo di esercizio' : 'Esecuzioni fatte', amount(u, r.fatte ?? 0))}
      ${kv('Obiettivo', `${amount(u, r.obiettivo ?? 0)} in ${fmt(r.tempoTotale ?? 0)}`)}
      ${r.raggiuntoAl != null ? kv('Obiettivo raggiunto a', fmt(r.raggiuntoAl)) : ''}
      ${kv('Serie', serie.length)}
      ${kv('Media per serie', inSec(u) ? fmtShort(mean) : mean.toFixed(1).replace('.', ','))}
      ${serie.length ? `<h3>Serie</h3><table class="serie"><tr><th>Serie</th><th>${inSec(u) ? 'Tenuti' : 'Esecuzioni'}</th>${timed ? '<th>Durata</th><th>Al minuto</th>' : ''}</tr>
        ${serie.map((n, i) => `<tr><td>${i + 1}</td><td>${amount(u, n)}</td>${timed ? `<td>${fmt(r.serieFine[i] - r.serieInizio[i])}</td><td>${fmt(r.serieFine[i])}</td>` : ''}</tr>`).join('')}</table>
        ${timed ? '' : '<p>Orari delle serie non disponibili per le sessioni registrate prima della versione 11.</p>'}` : ''}`;
  } else if (r.tipo === 'round') {
    body = `${kv('Round completati', `${r.roundFatti ?? 0} su ${r.roundTotali ?? 0}`)}
      ${kv('Lavoro effettivo', fmtShort(r.lavoroSec ?? 0))}
      ${r.durataSec != null ? kv('Durata totale', fmt(r.durataSec)) : ''}
      ${r.ripetizioni != null ? kv('Ripetizioni', r.ripetizioni) : ''}`;
  } else {
    const giri = r.giriTempi ?? [];
    body = `${kv('Durata', fmt(r.durataSec ?? 0))}
      ${r.giri ? kv('Giri', r.giri) : ''}
      ${r.giroMigliore != null ? kv('Giro migliore', fmtTenths(r.giroMigliore)) : ''}
      ${r.ripetizioni != null ? kv('Ripetizioni', r.ripetizioni) : ''}
      ${giri.length ? `<h3>Giri</h3><table class="serie"><tr><th>Giro</th><th>Tempo giro</th><th>Totale</th></tr>
        ${giri.map((g, i) => `<tr><td>${i + 1}</td><td>${fmtTenths(g)}</td><td>${fmtTenths(giri.slice(0, i + 1).reduce((a, b) => a + b, 0))}</td></tr>`).join('')}</table>` : ''}`;
  }
  openSheet('session', `
    <h2>${esc(r.nome)}</h2>
    <p>${esc(dateTimeLabel(r.data))} · ${esc(db.TYPES[r.tipo].nome)}${r.schedaNome ? ` · scheda ${esc(r.schedaNome)}` : ''} · ${r.completo ? 'completato' : 'interrotto'}${r.atleta ? ` · ${esc(r.atleta)}` : ''}</p>
    ${body}
    ${r.peso ? kv('Peso', kgLabel(r.peso)) : ''}
    <h3>Valutazione</h3>
    ${kv('Fatica', r.fatica ? `${r.fatica}/10` : '–')}
    ${r.nota ? `<p class="nota">${esc(r.nota)}</p>` : ''}
    ${own ? `<div class="row">
        <button class="btn" data-act="rate">Modifica valutazione</button>
        <button class="btn" data-act="send">Invia al coach</button>
      </div>
      <button class="btn block danger" data-act="del">Elimina sessione</button>` : ''}
    <div class="row">
      ${back ? '<button class="btn" data-act="back">Indietro</button>' : ''}
      <button class="btn primary" data-act="close">Chiudi</button>
    </div>`, panel => {
    const b = sel => panel.querySelector(sel);
    if (back) b('[data-act=back]').onclick = () => { closeSheet(); back(); };
    if (!own) return;
    b('[data-act=rate]').onclick = () => { closeSheet(); openFeedback([r.id]); };
    b('[data-act=send]').onclick = () => { closeSheet(); sendToCoach([r]); };
    b('[data-act=del]').onclick = async () => {
      if (!(await ask('Eliminare questa sessione dallo storico?', { ok: 'Elimina', danger: true }))) return;
      db.deleteResult(r.id);
      closeSheet();
      renderReport();
      back?.();
    };
  });
}

// Tocco su un punto del grafico: il valore compare sotto il grafico.
function showTip(e) {
  const hit = e.target.closest('.hit');
  if (!hit) return false;
  const fig = hit.closest('.chart');
  fig.querySelector('.chart-tip').textContent = hit.dataset.tip;
  fig.querySelectorAll('.dot').forEach(d => d.classList.remove('on'));
  hit.previousElementSibling?.classList.add('on');
  return true;
}
$('sheet-panel').addEventListener('click', showTip);

$('report-view').addEventListener('click', e => {
  if (showTip(e)) return;
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'tab-miei': reportTab = 'miei'; renderReport(); break;
    case 'tab-atleti': reportTab = 'atleti'; renderReport(); break;
    case 'atleta': reportAtleta = b.dataset.name; renderReport(); break;
    case 'detail': openDetail(b.dataset.key, b.dataset.own === '1'); break;
    case 'paste': openPaste(); break;
    case 'send-group': {
      const id = b.dataset.scheda || null;
      sendToCoach(db.getStorico().filter(r => (r.scheda ?? null) === id).sort((a, c) => a.data.localeCompare(c.data)));
      break;
    }
    case 'del-atleta':
      ask(`Eliminare tutti i risultati di ${reportAtleta} da questo telefono?`, { ok: 'Elimina', danger: true })
        .then(ok => { if (ok) { db.deleteAtleta(reportAtleta); renderReport(); } });
      break;
  }
});

// --- Impostazioni -----------------------------------------------------------

async function exportTemplates() {
  const name = `tempro-modelli-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([db.exportJSON()], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Modelli Tempro' }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function openSettings() {
  const toggle = (k, label) => `<label class="field toggle"><span>${label}</span><input type="checkbox" name="${k}"${settings[k] ? ' checked' : ''}></label>`;
  openSheet('settings', `
    <div style="margin-bottom:14px">${WORDMARK}</div>
    <h3>Avvisi</h3>
    ${toggle('suoni', 'Segnali acustici')}
    ${toggle('voce', 'Voce (annuncia le fasi)')}
    ${toggle('vibrazione', 'Vibrazione')}
    <p>Su iPhone con il tasto silenzioso attivo i suoni non si sentono e la vibrazione non è disponibile: fai riferimento ai colori.</p>
    <h3>Coach</h3>
    <label class="field"><span>Il tuo nome nei risultati inviati</span><input type="text" name="nomeAtleta" value="${esc(settings.nomeAtleta)}" maxlength="40" placeholder="Facoltativo"></label>
    <p>Compare solo nei messaggi che invii tu al coach. Puoi usare un soprannome o le iniziali.</p>
    <h3>Backup</h3>
    <p>Esporta modelli, schede e storico in un file per conservarli o passarli a un altro telefono.</p>
    <div class="row">
      <button class="btn" data-act="export">Esporta</button>
      <label class="btn">Importa<input type="file" accept="application/json,.json" hidden></label>
    </div>
    <div id="set-msg" class="error"></div>
    <h3>Storico</h3>
    <p>I risultati degli allenamenti restano solo su questo telefono.</p>
    <button class="btn block danger" data-act="clear-sto">Cancella il mio storico</button>
    <button class="btn block primary" data-act="close">Chiudi</button>
    <p style="text-align:center">Tempro · versione ${APP_VERSION}</p>`, panel => {
    panel.querySelectorAll('.toggle input').forEach(inp => {
      inp.onchange = () => { settings = { ...settings, [inp.name]: inp.checked }; db.saveSettings(settings); };
    });
    panel.querySelector('[name=nomeAtleta]').onchange = e => {
      settings = { ...settings, nomeAtleta: e.target.value.trim().slice(0, 40), nomeChiesto: true };
      db.saveSettings(settings);
    };
    panel.querySelector('[data-act=clear-sto]').onclick = async () => {
      if (!(await ask('Cancellare tutti i risultati dei tuoi allenamenti? Non si possono recuperare.', { ok: 'Cancella', danger: true }))) return;
      db.clearStorico();
      if (mode === 'andamento') renderReport();
      closeSheet();
    };
    panel.querySelector('[data-act=export]').onclick = exportTemplates;
    const msg = panel.querySelector('#set-msg');
    panel.querySelector('input[type=file]').onchange = async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const n = db.importJSON(await file.text());
        msg.style.color = 'var(--ok)';
        msg.textContent = `Importati ${n} modelli, con schede e storico.`;
        if (mode === 'sessioni') renderSessions();
        if (mode === 'andamento') renderReport();
      } catch (e) {
        msg.style.color = '';
        msg.textContent = `Importazione non riuscita: ${e.message}`;
      }
    };
  });
}

// --- Avvio ------------------------------------------------------------------

$('btn-main').addEventListener('click', onMain);
$('ring').addEventListener('click', () => {
  if (view?.icon !== 'replay') onMain();   // a fine allenamento il tocco sull'anello non ricomincia
});
$('btn-left').addEventListener('click', e => onSide(e.currentTarget.dataset.act));
$('btn-aux').addEventListener('click', e => onSide(e.currentTarget.dataset.act));
$('btn-settings').addEventListener('click', openSettings);
$('btn-title').addEventListener('click', () => {
  if (schedaRun) return;   // durante una scheda l'ordine è quello della scheda
  openPicker();
});
$('run-exit').addEventListener('click', async () => {
  if (!schedaRun || !(await confirmStop())) return;
  resetRunner();
});
$('btn-media').addEventListener('click', openMedia);
[1, 2, 3].forEach(i => $(`stat-${i}`).addEventListener('click', () => view?.stats[i - 1]?.tap?.()));
$('sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet' && sheetDismiss) closeSheet();
});
document.querySelectorAll('.tab').forEach(b => {
  b.addEventListener('click', async () => {
    if (b.dataset.tab === mode || !(await confirmStop())) return;
    loadMode(b.dataset.tab);
  });
});

const savedTab = db.getTab();
loadMode(db.TYPES[savedTab] || savedTab === 'sessioni' || savedTab === 'andamento' ? savedTab : 'round');
setInterval(tick, 100);

// Un video rimasto in sospeso (app chiusa prima di salvarlo) viene riproposto all'apertura.
if (cameraSupported()) {
  videoStore.list()
    .then(list => {
      const last = list.sort((a, b) => b.creato.localeCompare(a.creato))[0];
      if (last) enqueue(() => openVideoSheet(last));
    })
    .catch(() => {});
}

// Aperta da un link di scheda o di risultati.
handleIncoming(location.hash, true);
addEventListener('hashchange', () => handleIncoming(location.hash, true));

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js')
    .then(reg => {
      // Ogni volta che si torna all'app si controlla se è stata pubblicata una versione nuova.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  // Versione nuova attiva: si ricarica la pagina, ma mai durante un allenamento.
  let pendingReload = false;
  const reloadIfIdle = () => { if (pendingReload && !isActive() && !sheetKind) location.reload(); };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;   // primo avvio: nessuna versione precedente
    pendingReload = true;
    reloadIfIdle();
  });
  setInterval(reloadIfIdle, 5000);
}
