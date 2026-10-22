import { PHASES, fmt, fmtTenths, buildRoundPhases, buildCronoPhases, roundStats, Sequence, TempoRunner } from './engine.js';
import * as db from './storage.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = v => Math.max(0, parseInt(v, 10) || 0);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const safeImg = u => (/^(https?:\/\/|data:image\/)/i.test(u || '') ? u : '');
const cssUrl = u => `url("${u.replace(/["\\\s()]/g, c => encodeURIComponent(c))}")`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12a7 7 0 1 0 2.05-4.95"/><path d="M5 4.5V9h4.5"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M5 5.5l9 6.5-9 6.5z"/><path d="M18 5.5v13"/></svg>',
  pauseSmall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M10 8.5v7M14 8.5v7"/></svg>',
  playSmall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
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
    ['obiettivo', 'num', 'Esecuzioni obiettivo'],
    ['riposo', 'dur', 'Riposo dopo ogni serie'],
  ],
  cronometro: [
    ['direzione', 'dir', 'Modalità'],
    ['prepara', 'dur', 'Prepara'],
    ['durata', 'dur', 'Durata (conto alla rovescia)'],
  ],
};
const MIN = { lavoro: 1, roundPerCiclo: 1, cicli: 1, tempoTotale: 1, obiettivo: 1, durata: 1 };

let settings = db.getSettings();
let mode;            // 'round' | 'tempo' | 'cronometro' | 'sessioni'
let tpl;             // modello in uso
let runner;          // Sequence | TempoRunner
let laps = [];       // cronometro: istanti (s) dei giri
let lastIdx = -1;    // ultima fase annunciata (Sequence)
let beepKey = null, beepSec = null;
let sheetKind = null, sheetDismiss = null;

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
async function keepAwake(on) {
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

function confirmStop() {
  return !isActive() || confirm("Interrompere l'allenamento in corso?");
}

function loadMode(m) {
  keepAwake(false);
  mode = m;
  db.setTab(m);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === m));
  const sessions = m === 'sessioni';
  $('timer-view').hidden = sessions;
  $('sessions-view').hidden = !sessions;
  if (sessions) { runner = null; renderSessions(); return; }
  tpl = db.getTemplate(db.getSelected(m)) ?? db.newTemplate(m);
  updateMediaThumb();
  resetRunner();
}

function resetRunner() {
  if (sheetKind === 'reps' || sheetKind === 'summary') closeSheet();
  laps = [];
  lastIdx = -1;
  beepKey = null;
  if (tpl.tipo === 'round') runner = new Sequence(buildRoundPhases(tpl));
  else if (tpl.tipo === 'tempo') runner = new TempoRunner(tpl);
  else runner = new Sequence(buildCronoPhases(tpl));
  keepAwake(false);
  render();
}

function tick() {
  if (!runner) return;
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
    } else {
      if (s.idx !== lastIdx) { lastIdx = s.idx; announce(s.phase.type); }
      countdown(s.idx, s.phaseRemaining);
    }
  }
  render();
}

function onMain() {
  unlockMedia();
  if (tpl.tipo === 'tempo') {
    const r = runner;
    if (r.stato === 'idle') { r.start(); announce(r.stato); keepAwake(true); }
    else if (r.stato === 'fine') resetRunner();
    else if (r.paused) { r.resume(); keepAwake(true); }
    else if (r.stato === 'lavoro') {
      const i = r.fatto();
      if (i >= 0) { announce(r.stato); openReps(i); }
    } else { r.pause(); keepAwake(false); }
  } else {
    const s = runner.state();
    if (s.done) resetRunner();
    else if (runner.clock.running) { runner.clock.pause(); keepAwake(false); }
    else {
      if (runner.clock.ms === 0) { lastIdx = s.idx; announce(s.phase.type); }
      runner.clock.start();
      keepAwake(true);
    }
  }
  render();
}

function onAux() {
  unlockMedia();
  if (tpl.tipo === 'round') runner.skip();
  else if (tpl.tipo === 'tempo' && isActive()) {
    if (runner.paused) { runner.resume(); keepAwake(true); }
    else { runner.pause(); keepAwake(false); }
  }
  render();
}

function onTempoFine() {
  announce('fine');
  keepAwake(false);
  // Se l'utente sta già inserendo le esecuzioni, il riepilogo arriva dopo il salvataggio.
  if (sheetKind !== 'reps') continueFine();
}

function continueFine() {
  const i = runner.serie.findIndex(s => s.reps === null);
  if (i >= 0) openReps(i);
  else openSummary();
}

// --- Rendering del timer ----------------------------------------------------

const runLabel = (run, started) => ({ icon: run ? 'pause' : 'play', label: run ? 'PAUSA' : started ? 'RIPRENDI' : 'AVVIA' });

function vmRound() {
  const s = runner.state(), started = runner.clock.ms > 0;
  const aux = { icon: 'skip', label: 'Salta fase', disabled: !started || s.done };
  if (s.done) {
    return {
      total: fmt(0), aux, icon: 'replay', label: 'RICOMINCIA',
      main: { type: 'fine', label: 'FINE', time: fmt(runner.total) },
      next: { type: 'fine', label: 'BEN FATTO!', time: '' },
      left: { num: '0', label: 'ROUND RIMASTI' },
      right: { num: '0', label: 'CICLI RIMASTI' },
    };
  }
  const st = roundStats(runner.phases, s.idx, tpl);
  const n = s.next;
  return {
    total: fmt(s.totalRemaining, { ceil: true }), aux,
    ...runLabel(runner.clock.running, started),
    main: { type: s.phase.type, label: PHASES[s.phase.type].label, time: fmt(s.phaseRemaining, { ceil: true }) },
    next: n ? { type: n.type, label: PHASES[n.type].label, time: fmt(n.duration) } : { type: 'fine', label: 'FINE', time: '' },
    left: { num: String(st.round), label: 'ROUND RIMASTI' },
    right: { num: String(st.cicli), label: 'CICLI RIMASTI' },
  };
}

function vmCrono() {
  const s = runner.state(), run = runner.clock.running, started = runner.clock.ms > 0;
  const avanti = tpl.direzione !== 'indietro';
  const base = { aux: null, ...runLabel(run, started) };
  const lapStats = {
    left: { num: '+', label: 'GIRO', tap: run && !s.done && s.phase.type === 'cronometro' },
    right: { num: String(laps.length), label: 'GIRI', tap: laps.length > 0 },
  };
  if (s.done) {
    return {
      ...base, total: fmt(0), icon: 'replay', label: 'RICOMINCIA', left: null, right: null,
      main: { type: 'fine', label: 'FINE', time: '00:00' },
      next: { type: 'fine', label: 'TEMPO SCADUTO', time: '' },
    };
  }
  const type = s.phase.type;
  if (type === 'prepara') {
    const n = s.next;
    return {
      ...base, ...(avanti ? lapStats : { left: null, right: null }),
      total: avanti ? fmt(0) : fmt(tpl.durata),
      main: { type, label: 'PREPARA', time: fmt(s.phaseRemaining, { ceil: true }) },
      next: { type: n.type, label: PHASES[n.type].label, time: fmt(avanti ? 0 : n.duration) },
    };
  }
  if (type === 'timer') {
    return {
      ...base, left: null, right: null,
      total: fmt(s.phaseRemaining, { ceil: true }),
      main: { type, label: 'TIMER', time: fmt(s.phaseRemaining, { ceil: true }) },
      next: { type: 'info', label: 'DURATA', time: fmt(tpl.durata) },
    };
  }
  const lapStart = laps.at(-1) ?? 0;
  return {
    ...base, ...lapStats,
    total: fmt(s.phaseElapsed),
    main: { type, label: 'CRONOMETRO', time: fmt(s.phaseElapsed) },
    next: { type: 'info', label: `GIRO ${laps.length + 1}`, time: fmtTenths(s.phaseElapsed - lapStart) },
  };
}

function vmTempo() {
  const r = runner, T = tpl.tempoTotale, tot = r.totale, diff = tot - tpl.obiettivo;
  const active = isActive();
  const v = {
    total: fmt(r.totRemaining, { ceil: true }),
    left: { num: String(tot), label: 'FATTE', tap: r.serie.length > 0 },
    right: diff < 0 ? { num: String(-diff), label: 'MANCANO' } : { num: `+${diff}`, label: 'OLTRE' },
    aux: active ? { icon: r.paused ? 'playSmall' : 'pauseSmall', label: r.paused ? 'Riprendi' : 'Pausa' } : null,
  };
  const pausable = { icon: r.paused ? 'play' : 'pause', label: r.paused ? 'RIPRENDI' : 'PAUSA' };
  switch (r.stato) {
    case 'idle':
      return {
        ...v, icon: 'play', label: 'AVVIA',
        main: tpl.prepara > 0 ? { type: 'prepara', label: 'PREPARA', time: fmt(tpl.prepara) } : { type: 'lavoro', label: 'LAVORA', time: fmt(T) },
        next: tpl.prepara > 0 ? { type: 'lavoro', label: 'LAVORA', time: fmt(T) } : { type: 'riposo', label: 'RIPOSA', time: fmt(tpl.riposo) },
      };
    case 'prepara':
      return {
        ...v, ...pausable,
        main: { type: 'prepara', label: 'PREPARA', time: fmt(r.prepRemaining, { ceil: true }) },
        next: { type: 'lavoro', label: 'LAVORA', time: fmt(T) },
      };
    case 'lavoro':
      return {
        ...v, icon: r.paused ? 'play' : 'check', label: r.paused ? 'RIPRENDI' : 'FATTO',
        main: { type: 'lavoro', label: 'LAVORA', time: fmt(r.totRemaining, { ceil: true }) },
        next: { type: 'info', label: `SERIE ${r.serie.length + 1}`, time: fmt(r.serieElapsed) },
      };
    case 'riposo':
      return {
        ...v, ...pausable,
        main: { type: 'riposo', label: 'RIPOSA', time: fmt(r.restRemaining, { ceil: true }) },
        next: { type: 'lavoro', label: 'TEMPO RIMASTO', time: fmt(r.totRemaining, { ceil: true }) },
      };
    default:
      return {
        ...v, total: fmt(0), icon: 'replay', label: 'RICOMINCIA',
        main: { type: 'fine', label: diff >= 0 ? 'OBIETTIVO OK' : 'FINE', time: diff > 0 ? `+${diff}` : String(diff) },
        next: { type: 'info', label: 'FATTE / OBIETTIVO', time: `${tot} / ${tpl.obiettivo}` },
      };
  }
}

const setText = (id, text) => { const e = $(id); if (e.textContent !== text) e.textContent = text; };
const paint = (node, type) => { node.style.backgroundColor = `var(--c-${type})`; };
function setIcon(node, name) {
  if (node.dataset.icon !== name) { node.innerHTML = ICONS[name] ?? ''; node.dataset.icon = name; }
}

function renderStat(id, st) {
  const b = $(id);
  b.style.visibility = st ? '' : 'hidden';
  if (!st) return;
  setText(`${id}-num`, st.num);
  setText(`${id}-label`, st.label);
  $(`${id}-num`).classList.toggle('small', st.num.length > 3);
  b.classList.toggle('tappable', !!st.tap);
}

function render() {
  if (!runner) return;
  const v = tpl.tipo === 'round' ? vmRound() : tpl.tipo === 'tempo' ? vmTempo() : vmCrono();
  setText('tpl-name', tpl.nome);
  setText('total-time', v.total);
  paint($('phase-main'), v.main.type);
  setText('phase-label', v.main.label);
  setText('phase-time', v.main.time);
  $('phase-time').classList.toggle('long', v.main.time.length > 5);
  paint($('phase-next'), v.next.type);
  setText('next-label', v.next.label);
  setText('next-time', v.next.time);
  renderStat('stat-left', v.left);
  renderStat('stat-right', v.right);
  setIcon($('btn-main'), v.icon);
  $('btn-main').setAttribute('aria-label', v.label);
  setText('main-label', v.label);
  const aux = $('btn-aux');
  aux.style.visibility = v.aux ? '' : 'hidden';
  if (v.aux) {
    setIcon(aux, v.aux.icon);
    aux.disabled = !!v.aux.disabled;
    aux.setAttribute('aria-label', v.aux.label);
  }
}

function updateMediaThumb() {
  const b = $('btn-media'), img = safeImg(tpl.immagine), vid = safeUrl(tpl.video);
  b.hidden = !img && !vid;
  b.style.backgroundImage = img ? cssUrl(img) : '';
  b.innerHTML = !img && vid ? ICONS.video : '';
}

// --- Pannelli (sheet) -------------------------------------------------------

function openSheet(kind, html, mount, { dismissable = true } = {}) {
  sheetKind = kind;
  sheetDismiss = dismissable;
  const panel = $('sheet-panel');
  panel.innerHTML = html;
  panel.scrollTop = 0;
  $('sheet').hidden = false;
  panel.querySelectorAll('[data-act=close]').forEach(b => { b.onclick = closeSheet; });
  mount?.(panel);
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-panel').innerHTML = '';
  sheetKind = null;
}

function openReps(i) {
  const r = runner;
  const fine = r.stato === 'fine';
  const prev = r.serie.slice(0, i).reverse().find(s => s.reps !== null);
  const val = r.serie[i].reps ?? prev?.reps ?? 0;
  openSheet('reps', `
    <div class="reps">
      <h2>SERIE ${i + 1}</h2>
      <p>Quante esecuzioni hai fatto?${fine ? '' : ' Il riposo è già partito.'}</p>
      <input id="reps-val" class="reps-num" type="number" inputmode="numeric" min="0" value="${val}">
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
      closeSheet();
      if (r.stato === 'fine') continueFine();
      render();
    };
    panel.querySelector('[data-act=save]').onclick = () => done(int(inp.value));
    panel.querySelector('[data-act=later]').onclick = () => done(fine ? 0 : null);
  }, { dismissable: !fine });
}

function serieTable(r) {
  const rows = r.serie.map((s, i) => `
    <tr data-i="${i}"><td>${i + 1}</td><td>${s.reps ?? '–'}</td><td>${fmt(s.fine - s.inizio)}</td><td>${fmt(s.fine)}</td></tr>`).join('');
  return `<table class="serie"><tr><th>Serie</th><th>Esecuzioni</th><th>Durata</th><th>Al minuto</th></tr>${rows}</table>
    <p>Tocca una serie per correggerla.</p>`;
}

function bindSerieRows(panel) {
  panel.querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => openReps(Number(tr.dataset.i)); });
}

function openSeries() {
  const r = runner;
  if (r.stato === 'fine') return openSummary();
  openSheet('series', `<h2>SERIE</h2>${serieTable(r)}<button class="btn block primary" data-act="close">Chiudi</button>`, bindSerieRows);
}

function openSummary() {
  const r = runner, t = tpl, tot = r.totale, diff = tot - t.obiettivo;
  const al = r.obiettivoRaggiuntoAl();
  const res = diff > 0 ? `+${diff} oltre l'obiettivo` : diff === 0 ? 'Obiettivo centrato' : `${-diff} in meno`;
  const media = r.serie.length ? (tot / r.serie.length).toFixed(1).replace('.', ',') : '0';
  openSheet('summary', `
    <h2>RISULTATO · ${esc(t.nome)}</h2>
    <div class="result ${diff >= 0 ? 'ok' : 'ko'}">${res.toUpperCase()}</div>
    <div class="kv"><span>Esecuzioni fatte</span><b>${tot}</b></div>
    <div class="kv"><span>Obiettivo</span><b>${t.obiettivo} in ${fmt(t.tempoTotale)}</b></div>
    ${al !== null ? `<div class="kv"><span>Obiettivo raggiunto a</span><b>${fmt(al)}</b></div>` : ''}
    <div class="kv"><span>Serie</span><b>${r.serie.length}</b></div>
    <div class="kv"><span>Media per serie</span><b>${media}</b></div>
    <h3>SERIE</h3>
    ${serieTable(r)}
    <button class="btn block primary" data-act="close">Chiudi</button>`, bindSerieRows);
}

function openLaps() {
  const rows = laps.map((t, i) => `<tr><td>${i + 1}</td><td>${fmtTenths(t - (laps[i - 1] ?? 0))}</td><td>${fmtTenths(t)}</td></tr>`).join('');
  openSheet('laps', `
    <h2>GIRI</h2>
    <table class="serie"><tr><th>Giro</th><th>Tempo giro</th><th>Totale</th></tr>${rows}</table>
    <button class="btn block primary" data-act="close" style="margin-top:14px">Chiudi</button>`);
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
  html += '<button class="btn block primary" data-act="close" style="margin-top:14px">Chiudi</button>';
  openSheet('media', html);
}

function summary(t) {
  if (t.tipo === 'round') {
    const total = buildRoundPhases(t).reduce((a, p) => a + p.duration, 0);
    return `Lavoro ${fmt(t.lavoro)} · Riposo ${fmt(t.riposo)} · ${t.roundPerCiclo} round × ${t.cicli} ${t.cicli === 1 ? 'ciclo' : 'cicli'} · Totale ${fmt(total)}`;
  }
  if (t.tipo === 'tempo') return `${t.obiettivo} esecuzioni in ${fmt(t.tempoTotale)} · Riposo ${fmt(t.riposo)}`;
  return t.direzione === 'indietro' ? `Conto alla rovescia ${fmt(t.durata)}` : 'Cronometro in avanti con giri';
}

function openPicker() {
  if (!tpl) return;
  const list = db.getTemplates(tpl.tipo);
  const items = list.map(t => `
    <button class="card" data-id="${esc(t.id)}" style="width:100%;text-align:left">
      <div class="info"><div class="name">${t.id === tpl.id ? '● ' : ''}${esc(t.nome)}</div><div class="sum">${esc(summary(t))}</div></div>
    </button>`).join('') || '<div class="empty">Nessun modello salvato.</div>';
  openSheet('picker', `
    <h2>${db.TYPES[tpl.tipo].nome.toUpperCase()}</h2>
    ${items}
    <div class="row">
      <button class="btn" data-act="edit">Modifica questo</button>
      <button class="btn primary" data-act="new">+ Nuovo</button>
    </div>`, panel => {
    panel.querySelectorAll('.card[data-id]').forEach(b => {
      b.onclick = () => {
        if (!confirmStop()) return;
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
  return `<label class="field"><span>${label}</span><select name="${k}">
      <option value="avanti"${t[k] === 'avanti' ? ' selected' : ''}>In avanti (con giri)</option>
      <option value="indietro"${t[k] === 'indietro' ? ' selected' : ''}>Conto alla rovescia</option>
    </select></label>`;
}

function openEditor(t, isNew) {
  let immagine = t.immagine || '';
  const urlImg = immagine.startsWith('data:') ? '' : immagine;
  openSheet('editor', `
    <h2>${isNew ? 'NUOVO' : 'MODIFICA'} · ${db.TYPES[t.tipo].nome.toUpperCase()}</h2>
    <form id="ed" novalidate>
      <label class="field"><span>Nome</span><input type="text" name="nome" value="${esc(t.nome)}" maxlength="40"></label>
      ${FIELDS[t.tipo].map(f => fieldHtml(f, t)).join('')}
      <h3>ESERCIZIO (FACOLTATIVO)</h3>
      <label class="field"><span>Link video</span><input type="url" name="video" value="${esc(t.video)}" placeholder="https://youtube.com/…"></label>
      <label class="field"><span>Link immagine</span><input type="url" name="immagineUrl" value="${esc(urlImg)}" placeholder="https://…"></label>
      <div class="row">
        <label class="btn">Scegli foto<input type="file" accept="image/*" name="foto" hidden></label>
        <button type="button" class="btn danger" data-act="noimg">Rimuovi immagine</button>
      </div>
      <img id="ed-prev" class="img-preview" alt="">
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
      if (immagine && !safeImg(immagine)) { err.textContent = "Il link immagine deve iniziare con https://"; return; }
      out.video = video;
      out.immagine = immagine;
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

function renderSessions() {
  const card = t => {
    const img = safeImg(t.immagine);
    return `<div class="card">
      ${img ? `<div class="thumb" style="background-image:${esc(cssUrl(img))}"></div>` : ''}
      <div class="info">
        <div class="name">${esc(t.nome)}</div>
        <div class="sum">${esc(summary(t))}${t.video ? ' · ▶ video' : ''}</div>
        <div class="actions">
          <button class="btn small primary" data-act="start" data-id="${esc(t.id)}">▶ Avvia</button>
          <button class="btn small" data-act="edit" data-id="${esc(t.id)}">Modifica</button>
          <button class="btn small" data-act="dup" data-id="${esc(t.id)}">Duplica</button>
          <button class="btn small danger" data-act="del" data-id="${esc(t.id)}">Elimina</button>
        </div>
      </div>
    </div>`;
  };
  let html = '<h1>MODELLI</h1><p class="hint">Salvati solo su questo telefono. Nessun dato personale.</p>';
  for (const [tipo, def] of Object.entries(db.TYPES)) {
    const list = db.getTemplates(tipo);
    html += `<div class="group-head"><h2>${def.nome.toUpperCase()}</h2>
      <button class="btn small primary" data-act="new" data-tipo="${tipo}">+ Nuovo</button></div>`;
    html += list.length ? list.map(card).join('') : '<div class="empty">Nessun modello.</div>';
  }
  $('sessions-view').innerHTML = html;
}

$('sessions-view').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const t = db.getTemplate(b.dataset.id);
  switch (b.dataset.act) {
    case 'new': openEditor(db.newTemplate(b.dataset.tipo), true); break;
    case 'start': db.setSelected(t.tipo, t.id); loadMode(t.tipo); break;
    case 'edit': openEditor(t, false); break;
    case 'dup': db.duplicateTemplate(t.id); renderSessions(); break;
    case 'del':
      if (confirm(`Eliminare "${t.nome}"?`)) { db.deleteTemplate(t.id); renderSessions(); }
      break;
  }
});

// --- Impostazioni -----------------------------------------------------------

async function exportTemplates() {
  const name = `timer-modelli-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([db.exportJSON()], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Modelli timer' }); return; } catch (e) {
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
    <h2>IMPOSTAZIONI</h2>
    ${toggle('suoni', 'Segnali acustici')}
    ${toggle('voce', 'Voce (annuncia le fasi)')}
    ${toggle('vibrazione', 'Vibrazione')}
    <p>Su iPhone con il tasto silenzioso attivo i suoni non si sentono e la vibrazione non è disponibile: fai riferimento ai colori.</p>
    <h3>BACKUP MODELLI</h3>
    <p>Esporta i modelli in un file per conservarli o passarli a un altro telefono.</p>
    <div class="row">
      <button class="btn" data-act="export">Esporta</button>
      <label class="btn">Importa<input type="file" accept="application/json,.json" hidden></label>
    </div>
    <div id="set-msg" class="error"></div>
    <p>Nessun dato personale: i modelli restano solo in questo browser.</p>
    <button class="btn block primary" data-act="close" style="margin-top:14px">Chiudi</button>`, panel => {
    panel.querySelectorAll('.toggle input').forEach(inp => {
      inp.onchange = () => { settings = { ...settings, [inp.name]: inp.checked }; db.saveSettings(settings); };
    });
    panel.querySelector('[data-act=export]').onclick = exportTemplates;
    const msg = panel.querySelector('#set-msg');
    panel.querySelector('input[type=file]').onchange = async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const n = db.importJSON(await file.text());
        msg.style.color = 'var(--ok)';
        msg.textContent = `Importati ${n} modelli.`;
      } catch (e) {
        msg.style.color = '';
        msg.textContent = `Importazione non riuscita: ${e.message}`;
      }
    };
  });
}

// --- Avvio ------------------------------------------------------------------

$('btn-main').addEventListener('click', onMain);
$('btn-aux').addEventListener('click', onAux);
$('btn-reset').addEventListener('click', () => {
  if (isActive() && !confirm('Azzerare il timer?')) return;
  resetRunner();
});
$('btn-settings').addEventListener('click', openSettings);
$('btn-title').addEventListener('click', openPicker);
$('btn-media').addEventListener('click', openMedia);
$('stat-left').addEventListener('click', () => {
  if (tpl.tipo === 'tempo' && runner.serie.length) openSeries();
  else if (tpl.tipo === 'cronometro' && tpl.direzione !== 'indietro' && runner.clock.running) {
    const s = runner.state();
    if (!s.done && s.phase.type === 'cronometro') { laps.push(s.phaseElapsed); audio.beep(1200, 0.06); render(); }
  }
});
$('stat-right').addEventListener('click', () => {
  if (tpl.tipo === 'cronometro' && laps.length) openLaps();
});
$('sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet' && sheetDismiss) closeSheet();
});
document.querySelectorAll('.tab').forEach(b => {
  b.addEventListener('click', () => {
    if (b.dataset.tab === mode || !confirmStop()) return;
    loadMode(b.dataset.tab);
  });
});

const savedTab = db.getTab();
loadMode(db.TYPES[savedTab] || savedTab === 'sessioni' ? savedTab : 'round');
setInterval(tick, 100);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
