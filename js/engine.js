// Motore del timer: nessuna dipendenza dalla UI.
// Tutti i tempi sono calcolati da timestamp (performance.now), mai contando i tick,
// così il timer resta preciso anche se il browser rallenta o va in background.

export const PHASES = {
  prepara:     { label: 'PREPARA',      voce: 'Preparati' },
  lavoro:      { label: 'LAVORA',       voce: 'Lavora' },
  riposo:      { label: 'RIPOSA',       voce: 'Riposa' },
  riposoCicli: { label: 'RIPOSO CICLO', voce: 'Riposo tra i cicli' },
  rinfrescati: { label: 'RINFRESCATI',  voce: 'Rinfrescati' },
  cronometro:  { label: 'CRONOMETRO',   voce: 'Via' },
  timer:       { label: 'TIMER',        voce: 'Via' },
  fine:        { label: 'FINE',         voce: 'Fine' },
};

export class Clock {
  constructor() { this.reset(); }
  reset() { this.acc = 0; this.since = null; }
  start() { if (this.since === null) this.since = performance.now(); }
  pause() {
    if (this.since !== null) { this.acc += performance.now() - this.since; this.since = null; }
  }
  get running() { return this.since !== null; }
  get ms() { return this.acc + (this.since === null ? 0 : performance.now() - this.since); }
}

export function fmt(sec, { ceil = false } = {}) {
  if (!Number.isFinite(sec)) return '--:--';
  let s = ceil ? Math.ceil(sec - 1e-6) : Math.floor(sec + 1e-6);
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function fmtTenths(sec) {
  const t = Math.max(0, Math.floor(sec * 10));
  return `${fmt(Math.floor(t / 10))}.${t % 10}`;
}

// --- Modalità Round -------------------------------------------------------
// Prepara → [Lavoro → Riposo] × roundPerCiclo → Riposo tra cicli → … × cicli → Rinfrescati
export function buildRoundPhases(t) {
  const out = [];
  const add = (type, duration, extra = {}) => { if (duration > 0) out.push({ type, duration, ...extra }); };
  add('prepara', t.prepara);
  for (let c = 1; c <= t.cicli; c++) {
    for (let r = 1; r <= t.roundPerCiclo; r++) {
      add('lavoro', Math.max(1, t.lavoro), { round: r, ciclo: c });
      if (r < t.roundPerCiclo) add('riposo', t.riposo, { round: r, ciclo: c });
      else if (c < t.cicli) {
        if (t.riposoTraCicli > 0) add('riposoCicli', t.riposoTraCicli, { round: r, ciclo: c });
        else add('riposo', t.riposo, { round: r, ciclo: c });
      }
    }
  }
  add('rinfrescati', t.rinfrescati);
  return out;
}

export function buildCronoPhases(t) {
  const out = [];
  if (t.prepara > 0) out.push({ type: 'prepara', duration: t.prepara });
  if (t.direzione === 'indietro') out.push({ type: 'timer', duration: Math.max(1, t.durata) });
  else out.push({ type: 'cronometro', duration: Infinity });
  return out;
}

// Sequenza lineare di fasi a durata fissa (Round e Cronometro).
export class Sequence {
  constructor(phases) {
    this.phases = phases;
    this.clock = new Clock();
    this.ends = [];
    let s = 0;
    for (const p of phases) { s += p.duration; this.ends.push(s); }
    this.total = s;
  }
  state() {
    const e = this.clock.ms / 1000;
    const idx = this.ends.findIndex(end => e < end);
    if (idx < 0) return { done: true, idx: this.phases.length, elapsed: this.total, totalRemaining: 0 };
    const start = idx ? this.ends[idx - 1] : 0;
    return {
      done: false, idx,
      phase: this.phases[idx],
      next: this.phases[idx + 1] ?? null,
      phaseElapsed: e - start,
      phaseRemaining: this.ends[idx] - e,
      elapsed: e,
      totalRemaining: this.total - e,
    };
  }
  skip() {
    const s = this.state();
    if (!s.done && Number.isFinite(s.phaseRemaining)) this.clock.acc += s.phaseRemaining * 1000 + 1;
  }
}

// --- Modalità Entro il tempo ----------------------------------------------
// Il tempo totale comprende lavoro e riposi. L'utente preme FATTO a fine serie,
// segna le esecuzioni e parte il riposo; si ripete fino allo scadere del tempo.
export class TempoRunner {
  constructor(t) { this.t = t; this.reset(); }
  reset() {
    this.stato = 'idle';   // idle | prepara | lavoro | riposo | fine
    this.paused = false;
    this.prep = new Clock();
    this.tot = new Clock();
    this.rest = new Clock();
    this.serie = [];       // { reps: number|null, inizio, fine }
    this.inizioSerie = 0;
  }
  get T() { return this.t.tempoTotale; }
  get totElapsed() { return Math.min(this.T, this.tot.ms / 1000); }
  get totRemaining() { return this.T - this.totElapsed; }
  get prepRemaining() { return this.t.prepara - this.prep.ms / 1000; }
  get restRemaining() { return Math.min(this.t.riposo - this.rest.ms / 1000, this.totRemaining); }
  get serieElapsed() { return this.totElapsed - this.inizioSerie; }
  get totale() { return this.serie.reduce((a, s) => a + (s.reps || 0), 0); }

  start() {
    if (this.t.prepara > 0) { this.stato = 'prepara'; this.prep.start(); }
    else this._lavoro();
  }
  _lavoro() {
    this.stato = 'lavoro';
    this.tot.start();
    this.inizioSerie = this.totElapsed;
  }
  // Chiude la serie in corso e avvia il riposo. Ritorna l'indice della serie.
  fatto() {
    if (this.stato !== 'lavoro' || this.paused) return -1;
    const now = this.totElapsed;
    this.serie.push({ reps: null, inizio: this.inizioSerie, fine: now });
    if (this.t.riposo > 0) { this.stato = 'riposo'; this.rest.reset(); this.rest.start(); }
    else this.inizioSerie = now;
    return this.serie.length - 1;
  }
  pause() {
    this.paused = true;
    this.prep.pause(); this.tot.pause(); this.rest.pause();
  }
  resume() {
    this.paused = false;
    if (this.stato === 'prepara') this.prep.start();
    if (this.stato === 'lavoro' || this.stato === 'riposo') this.tot.start();
    if (this.stato === 'riposo') this.rest.start();
  }
  // Avanza la macchina a stati; ritorna gli eventi accaduti ('lavoro', 'fine').
  update() {
    const ev = [];
    if (this.paused) return ev;
    if (this.stato === 'prepara' && this.prepRemaining <= 0) {
      this.prep.pause();
      this._lavoro();
      ev.push('lavoro');
    }
    if ((this.stato === 'lavoro' || this.stato === 'riposo') && this.tot.ms / 1000 >= this.T) {
      this._fine();
      ev.push('fine');
      return ev;
    }
    if (this.stato === 'riposo' && this.rest.ms / 1000 >= this.t.riposo) {
      this.rest.pause();
      this.stato = 'lavoro';
      this.inizioSerie = this.totElapsed;
      ev.push('lavoro');
    }
    return ev;
  }
  _fine() {
    this.tot.pause(); this.rest.pause();
    if (this.stato === 'lavoro' && this.T - this.inizioSerie > 0.5) {
      this.serie.push({ reps: null, inizio: this.inizioSerie, fine: this.T });
    }
    this.stato = 'fine';
  }
  // Momento (secondi dall'inizio) in cui è stato raggiunto l'obiettivo, o null.
  obiettivoRaggiuntoAl() {
    let acc = 0;
    for (const s of this.serie) {
      acc += s.reps || 0;
      if (acc >= this.t.obiettivo) return s.fine;
    }
    return null;
  }
}
