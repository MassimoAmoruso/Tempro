import { PHASES, fmt, fmtTenths, buildRoundPhases, buildCronoPhases, Sequence, TempoRunner } from './engine.js';
import * as db from './storage.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = v => Math.max(0, parseInt(v, 10) || 0);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const safeImg = u => (/^(https?:\/\/|data:image\/)/i.test(u || '') ? u : '');
const cssUrl = u => `url("${u.replace(/["\\\s()]/g, c => encodeURIComponent(c))}")`;

// Durata compatta per i riquadri: 0:10, 1:30, 1:02:05
function fmtShort(sec) {
  const s = Math.max(0, Math.round(sec));
  return s >= 3600 ? fmt(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7.5 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12a7 7 0 1 0 2.05-4.95"/><path d="M5 4.5V9h4.5"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l8 6-8 6z"/><path d="M18 6v12"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
};

const WORDMARK = `<span class="wordmark" role="img" aria-label="Tempro">tempr<svg aria-hidden="true" viewBox="0 0 100 100">
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

const RING = 2 * Math.PI * 136;   // circonferenza dell'anello (r=136 nel viewBox 300)

let settings = db.getSettings();
let mode;            // 'round' | 'tempo' | 'cronometro' | 'sessioni'
let tpl;             // modello in uso
let runner;          // Sequence | TempoRunner
let laps = [];       // cronometro: istanti (s) dei giri
let lastIdx = -1;    // ultima fase annunciata (Sequence)
let beepKey = null, beepSec = null;
let sheetKind = null, sheetDismiss = null;
let phaseType = null;
let view = null;     // ultimo modello di vista disegnato

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

function setPhase(type) {
  if (type === phaseType) return;
  phaseType = type;
  document.documentElement.style.setProperty('--phase', `var(--c-${type})`);
}

function loadMode(m) {
  keepAwake(false);
  mode = m;
  db.setTab(m);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === m));
  const sessions = m === 'sessioni';
  $('timer-view').hidden = sessions;
  $('sessions-view').hidden = !sessions;
  if (sessions) { runner = null; setPhase('info'); renderSessions(); return; }
  tpl = db.getTemplate(db.getSelected(m)) ?? db.newTemplate(m);
  updateMedia();
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

// Pulsante a sinistra: pausa durante il lavoro (Entro il tempo) o giro (Cronometro).
function onLeft() {
  unlockMedia();
  if (tpl.tipo === 'tempo' && isActive()) {
    if (runner.paused) { runner.resume(); keepAwake(true); }
    else { runner.pause(); keepAwake(false); }
  } else if (tpl.tipo === 'cronometro' && runner.clock.running) {
    const s = runner.state();
    if (!s.done && s.phase.type === 'cronometro') { laps.push(s.phaseElapsed); audio.beep(1200, 0.06); }
  }
  render();
}

// Pulsante a destra: salta fase (Round).
function onAux() {
  if (tpl.tipo === 'round') runner.skip();
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

// --- Modello di vista per ciascuna modalità ---------------------------------
// { type, name, time, sub, frac, total, stats[3], icon, label, left, aux }

const runLabel = (run, started) => ({ icon: run ? 'pause' : 'play', label: run ? 'Pausa' : started ? 'Riprendi' : 'Avvia' });

function vmRound() {
  const s = runner.state(), started = runner.clock.ms > 0, t = tpl;
  const aux = { icon: 'skip', label: 'Salta fase', disabled: !started || s.done };
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
  const fatte = { k: 'Fatte', v: String(tot), tap: r.serie.length ? openSeries : null };
  const manca = diff < 0 ? { k: 'Mancano', v: String(-diff) } : { k: 'Oltre', v: `+${diff}`, type: 'lavoro' };
  const obiettivo = { k: 'Obiettivo', v: String(t.obiettivo) };
  const riposo = { k: 'Riposo', v: fmtShort(t.riposo), type: 'riposo' };
  const base = { total: `Tempo rimasto ${fmt(r.totRemaining, { ceil: true })}`, left: null, aux: null };
  const pausable = { icon: r.paused ? 'play' : 'pause', label: r.paused ? 'Riprendi' : 'Pausa' };
  switch (r.stato) {
    case 'idle':
      return {
        ...base, type: t.prepara > 0 ? 'prepara' : 'lavoro', name: t.prepara > 0 ? 'PREPARA' : 'LAVORA',
        time: fmt(t.prepara > 0 ? t.prepara : T), sub: `${t.obiettivo} esecuzioni in ${fmt(T)}`, frac: 1,
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
        time: fmt(r.totRemaining, { ceil: true }), sub: r.paused ? 'In pausa' : 'Premi ✓ a fine serie',
        frac: r.totRemaining / T,
        stats: [fatte, manca, { k: `Serie ${r.serie.length + 1}`, v: fmtShort(r.serieElapsed) }],
        icon: r.paused ? 'play' : 'check', label: r.paused ? 'Riprendi' : 'Fatto',
        left: r.paused ? null : { icon: 'pause', label: 'Pausa' },
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
        time: diff > 0 ? `+${diff}` : String(diff), sub: `${tot} su ${t.obiettivo} in ${fmt(T)}`,
        frac: Math.min(1, tot / t.obiettivo),
        stats: [fatte, manca, { k: 'Serie', v: String(r.serie.length), tap: r.serie.length ? openSummary : null }],
        icon: 'replay', label: 'Ricomincia',
      };
  }
}

function vmCrono() {
  const s = runner.state(), run = runner.clock.running, started = runner.clock.ms > 0, t = tpl;
  const base = { left: null, aux: null, ...runLabel(run, started) };
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
      left: { icon: 'flag', label: 'Giro', disabled: !(run && !prepara) },
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

function renderSide(id, b) {
  const node = $(id);
  node.style.visibility = b ? '' : 'hidden';
  if (!b) return;
  setIcon(node, b.icon);
  node.disabled = !!b.disabled;
  node.setAttribute('aria-label', b.label);
}

function render() {
  if (!runner) return;
  const v = view = tpl.tipo === 'round' ? vmRound() : tpl.tipo === 'tempo' ? vmTempo() : vmCrono();
  setPhase(v.type);
  setText('tpl-name', tpl.nome);
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
  setIcon($('btn-main'), v.icon);
  $('btn-main').setAttribute('aria-label', v.label);
  renderSide('btn-left', v.left);
  renderSide('btn-aux', v.aux);
}

function updateMedia() {
  const img = safeImg(tpl.immagine), vid = safeUrl(tpl.video);
  $('btn-media').hidden = !img && !vid;
  const thumb = $('media-thumb');
  thumb.style.backgroundImage = img ? cssUrl(img) : '';
  thumb.innerHTML = img ? '' : ICONS.video;
  $('media-sub').textContent = img && vid ? 'Guarda foto e video' : img ? 'Guarda la foto' : 'Guarda il video';
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
      <h2>Serie ${i + 1}</h2>
      <p>Quante esecuzioni hai fatto?${fine ? '' : ' Il riposo è già partito.'}</p>
      <input id="reps-val" class="reps-num" type="number" inputmode="numeric" min="0" value="${val}" aria-label="Esecuzioni">
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
  openSheet('series', `<h2>Serie</h2>${serieTable(r)}<button class="btn block primary" data-act="close">Chiudi</button>`, bindSerieRows);
}

function openSummary() {
  const r = runner, t = tpl, tot = r.totale, diff = tot - t.obiettivo;
  const al = r.obiettivoRaggiuntoAl();
  const res = diff > 0 ? `+${diff} oltre l'obiettivo` : diff === 0 ? 'Obiettivo centrato' : `${-diff} in meno`;
  const media = r.serie.length ? (tot / r.serie.length).toFixed(1).replace('.', ',') : '0';
  openSheet('summary', `
    <h2>Risultato · ${esc(t.nome)}</h2>
    <div class="result ${diff >= 0 ? 'ok' : 'ko'}">${res}</div>
    <div class="kv"><span>Esecuzioni fatte</span><b>${tot}</b></div>
    <div class="kv"><span>Obiettivo</span><b>${t.obiettivo} in ${fmt(t.tempoTotale)}</b></div>
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

function summary(t) {
  if (t.tipo === 'round') {
    const total = buildRoundPhases(t).reduce((a, p) => a + p.duration, 0);
    return `Lavoro ${fmtShort(t.lavoro)} · Riposo ${fmtShort(t.riposo)} · ${t.roundPerCiclo} round × ${t.cicli} ${t.cicli === 1 ? 'ciclo' : 'cicli'} · Totale ${fmt(total)}`;
  }
  if (t.tipo === 'tempo') return `${t.obiettivo} esecuzioni in ${fmt(t.tempoTotale)} · Riposo ${fmtShort(t.riposo)}`;
  return t.direzione === 'indietro' ? `Conto alla rovescia ${fmt(t.durata)}` : 'Cronometro in avanti con giri';
}

function openPicker() {
  if (!tpl) return;
  const list = db.getTemplates(tpl.tipo);
  const items = list.map(t => `
    <button class="card${t.id === tpl.id ? ' current' : ''}" data-id="${esc(t.id)}">
      <span class="info"><span class="name" style="display:block">${esc(t.nome)}</span><span class="sum" style="display:block">${esc(summary(t))}</span></span>
    </button>`).join('') || '<div class="empty">Nessun modello salvato.</div>';
  openSheet('picker', `
    <h2>${db.TYPES[tpl.tipo].nome}</h2>
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
    <h2>${isNew ? 'Nuovo modello' : 'Modifica'} · ${db.TYPES[t.tipo].nome}</h2>
    <form id="ed" novalidate>
      <label class="field"><span>Nome</span><input type="text" name="nome" value="${esc(t.nome)}" maxlength="40"></label>
      ${FIELDS[t.tipo].map(f => fieldHtml(f, t)).join('')}
      <h3>Esercizio (facoltativo)</h3>
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
      if (immagine && !safeImg(immagine)) { err.textContent = 'Il link immagine deve iniziare con https://'; return; }
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
        <div class="sum">${esc(summary(t))}${t.video ? ' · video' : ''}</div>
        <div class="actions">
          <button class="btn small primary" data-act="start" data-id="${esc(t.id)}">Avvia</button>
          <button class="btn small" data-act="edit" data-id="${esc(t.id)}">Modifica</button>
          <button class="btn small" data-act="dup" data-id="${esc(t.id)}">Duplica</button>
          <button class="btn small danger" data-act="del" data-id="${esc(t.id)}">Elimina</button>
        </div>
      </div>
    </div>`;
  };
  let html = `${WORDMARK}<p class="hint">I tuoi modelli, salvati solo su questo telefono. Nessun dato personale.</p>`;
  for (const [tipo, def] of Object.entries(db.TYPES)) {
    const list = db.getTemplates(tipo);
    html += `<div class="group-head"><h2>${def.nome}</h2>
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
    <h3>Backup modelli</h3>
    <p>Esporta i modelli in un file per conservarli o passarli a un altro telefono.</p>
    <div class="row">
      <button class="btn" data-act="export">Esporta</button>
      <label class="btn">Importa<input type="file" accept="application/json,.json" hidden></label>
    </div>
    <div id="set-msg" class="error"></div>
    <p>Nessun dato personale: i modelli restano solo in questo browser.</p>
    <button class="btn block primary" data-act="close">Chiudi</button>`, panel => {
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
$('btn-left').addEventListener('click', onLeft);
$('btn-aux').addEventListener('click', onAux);
$('btn-reset').addEventListener('click', () => {
  if (isActive() && !confirm('Azzerare il timer?')) return;
  resetRunner();
});
$('btn-settings').addEventListener('click', openSettings);
$('btn-title').addEventListener('click', openPicker);
$('btn-media').addEventListener('click', openMedia);
[1, 2, 3].forEach(i => $(`stat-${i}`).addEventListener('click', () => view?.stats[i - 1]?.tap?.()));
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
