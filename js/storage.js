// Salvataggio locale (solo su questo dispositivo): modelli, schede, storico, risultati degli atleti,
// impostazioni. Nessun server: i dati escono dal telefono solo quando l'utente li condivide.
// Le chiavi restano "timer.*" anche dopo il cambio di nome in Tempro, per non perdere i dati già salvati.

const KEY_TPL = 'timer.modelli.v1';
const KEY_SCH = 'timer.schede.v1';
const KEY_STO = 'timer.storico.v1';
const KEY_ATL = 'timer.atleti.v1';
const KEY_SET = 'timer.impostazioni.v1';
const KEY_SEL = 'timer.selezione.v1';
const KEY_TAB = 'timer.tab.v1';

const MAX_STORICO = 2000;
const MAX_ATLETI = 5000;

export const TYPES = {
  round: {
    nome: 'Round',
    defaults: () => ({ prepara: 10, lavoro: 20, riposo: 10, roundPerCiclo: 10, cicli: 1, riposoTraCicli: 60, rinfrescati: 0 }),
  },
  tempo: {
    nome: 'Entro il tempo',
    defaults: () => ({ prepara: 10, tempoTotale: 600, unita: 'ripetizioni', obiettivo: 100, riposo: 30 }),
  },
  cronometro: {
    nome: 'Cronometro',
    defaults: () => ({ direzione: 'avanti', prepara: 5, durata: 300 }),
  },
};

export const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
// Può lanciare un'eccezione se lo spazio è esaurito: la gestisce il chiamante.
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

// --- Pulizia dei dati in arrivo da link o file ---------------------------------

const ID_RE = /^[\w-]{6,64}$/;
const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const httpUrl = v => (/^https?:\/\//i.test(v || '') ? str(v, 500) : '');

const LIMITS = {
  prepara: [0, 3600], lavoro: [1, 86400], riposo: [0, 86400], roundPerCiclo: [1, 100], cicli: [1, 50],
  riposoTraCicli: [0, 86400], rinfrescati: [0, 86400], tempoTotale: [1, 86400], obiettivo: [1, 100000], durata: [1, 86400],
};

// Modello valido e completo a partire da dati qualsiasi; null se il tipo non è riconosciuto.
// Le foto caricate dal telefono (data:) non sono ammesse: solo link http(s).
export function cleanTemplate(m) {
  if (!m || !TYPES[m.tipo]) return null;
  const out = newTemplate(m.tipo);
  out.nome = str(m.nome, 40) || out.nome;
  out.video = httpUrl(m.video);
  out.immagine = httpUrl(m.immagine);
  out.registra = !!m.registra;
  out.fotocamera = m.fotocamera === 'environment' ? 'environment' : 'user';
  out.audio = m.audio !== false;
  for (const k of Object.keys(TYPES[m.tipo].defaults())) {
    if (k === 'direzione') out[k] = m[k] === 'indietro' ? 'indietro' : 'avanti';
    else if (k === 'unita') out[k] = m[k] === 'secondi' ? 'secondi' : 'ripetizioni';
    else if (k in m) out[k] = clampInt(m[k], ...LIMITS[k]);
  }
  return out;
}

const num = (v, max) => (v == null || v === '' ? null : clampInt(v, 0, max));

export function cleanResult(r) {
  if (!r || !ID_RE.test(r.id) || !TYPES[r.tipo] || Number.isNaN(Date.parse(r.data))) return null;
  const out = {
    id: r.id, data: new Date(r.data).toISOString(), tipo: r.tipo,
    modello: str(r.modello, 64), nome: str(r.nome, 40), scheda: r.scheda ? str(r.scheda, 64) : null,
    schedaNome: str(r.schedaNome, 60), completo: !!r.completo,
    unita: r.unita === 'secondi' ? 'secondi' : null,
    fatte: num(r.fatte, 1e6), obiettivo: num(r.obiettivo, 1e6), tempoTotale: num(r.tempoTotale, 86400),
    raggiuntoAl: num(r.raggiuntoAl, 86400),
    serie: Array.isArray(r.serie) ? r.serie.slice(0, 500).map(x => clampInt(x, 0, 1e5)) : null,
    // Inizio e fine di ogni serie (secondi dall'avvio), tempi di ogni giro (decimi).
    serieInizio: Array.isArray(r.serieInizio) ? r.serieInizio.slice(0, 500).map(x => clampInt(x, 0, 86400)) : null,
    serieFine: Array.isArray(r.serieFine) ? r.serieFine.slice(0, 500).map(x => clampInt(x, 0, 86400)) : null,
    giriTempi: Array.isArray(r.giriTempi) ? r.giriTempi.slice(0, 500).map(x => Math.min(86400, Math.max(0, Math.round((Number(x) || 0) * 10) / 10))) : null,
    roundFatti: num(r.roundFatti, 1e4), roundTotali: num(r.roundTotali, 1e4), lavoroSec: num(r.lavoroSec, 172800),
    durataSec: num(r.durataSec, 172800), giri: num(r.giri, 1e4),
    giroMigliore: r.giroMigliore == null ? null : Math.min(86400, Math.max(0, Math.round((Number(r.giroMigliore) || 0) * 10) / 10)),
    fatica: r.fatica == null ? null : clampInt(r.fatica, 1, 10), ripetizioni: num(r.ripetizioni, 1e6), nota: str(r.nota, 200),
  };
  return compact(out);
}

// Toglie i campi vuoti, per tenere piccoli link e archivio.
export function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
}

// --- Modelli ----------------------------------------------------------------

export function newTemplate(tipo, nome) {
  return {
    id: uid(), tipo, nome: nome ?? TYPES[tipo].nome, immagine: '', video: '',
    registra: false, fotocamera: 'user', audio: true,   // ripresa video dei lavori
    ...TYPES[tipo].defaults(),
  };
}

function seed() {
  return [
    { ...newTemplate('round', 'Tabata'), lavoro: 20, riposo: 10, roundPerCiclo: 8, cicli: 1 },
    { ...newTemplate('round', 'Tabata 3 cicli'), lavoro: 20, riposo: 10, roundPerCiclo: 10, cicli: 3, riposoTraCicli: 60, rinfrescati: 120 },
    { ...newTemplate('tempo', '100 in 10 minuti'), tempoTotale: 600, obiettivo: 100, riposo: 30 },
    { ...newTemplate('cronometro', 'Cronometro'), direzione: 'avanti' },
    { ...newTemplate('cronometro', 'Timer 5 minuti'), direzione: 'indietro', durata: 300 },
  ];
}

let templates = read(KEY_TPL, null);
if (!Array.isArray(templates)) {
  templates = seed();
  try { write(KEY_TPL, templates); } catch { /* storage non disponibile: si lavora in memoria */ }
}
let schede = read(KEY_SCH, []);
let storico = read(KEY_STO, []);
let atleti = read(KEY_ATL, []);

function commit(next) {
  write(KEY_TPL, next);   // se fallisce, lo stato in memoria resta quello precedente
  templates = next;
}

export const getTemplates = tipo => (tipo ? templates.filter(t => t.tipo === tipo) : templates.slice());
export const getTemplate = id => templates.find(t => t.id === id);
// Chiave stabile del modello: per i modelli ricevuti è l'id originale del coach.
export const templateKey = t => t.chiave ?? t.id;

export function saveTemplate(t) {
  const i = templates.findIndex(x => x.id === t.id);
  const next = templates.slice();
  if (i >= 0) next[i] = t; else next.push(t);
  commit(next);
}

export function deleteTemplate(id) {
  commit(templates.filter(t => t.id !== id));
  if (schede.some(s => s.modelli.includes(id))) {
    commitSchede(schede.map(s => ({ ...s, modelli: s.modelli.filter(x => x !== id) })));
  }
}

export function duplicateTemplate(id) {
  const t = getTemplate(id);
  const { chiave, ...rest } = t;   // la copia è un modello personale
  const copy = { ...rest, id: uid(), nome: `${t.nome} (copia)` };
  const next = templates.slice();
  next.splice(templates.indexOf(t) + 1, 0, copy);
  commit(next);
  return copy;
}

// --- Schede -----------------------------------------------------------------
// { id, nome, coach, nota, ricevuta, modelli: [id modello], ver, data }
// Scheda creata qui: raggruppa modelli personali. Scheda ricevuta: i suoi modelli le appartengono.

function commitSchede(next) {
  write(KEY_SCH, next);
  schede = next;
}

export const getSchede = () => schede.slice();
export const getScheda = id => schede.find(s => s.id === id);
// Scheda di un modello: prima quelle ricevute, poi quelle create qui.
export const schedaOf = tplId => schede.find(s => s.ricevuta && s.modelli.includes(tplId))
  ?? schede.find(s => s.modelli.includes(tplId)) ?? null;
// Modelli che appartengono a una scheda ricevuta (non compaiono tra i modelli personali).
export const isReceived = tplId => schede.some(s => s.ricevuta && s.modelli.includes(tplId));

export function saveScheda(s) {
  const i = schede.findIndex(x => x.id === s.id);
  const next = schede.slice();
  if (i >= 0) next[i] = s; else next.push(s);
  commitSchede(next);
}

export function deleteScheda(id) {
  const s = getScheda(id);
  if (!s) return;
  if (s.ricevuta) commit(templates.filter(t => !s.modelli.includes(t.id)));
  commitSchede(schede.filter(x => x.id !== id));
}

// Dati da mettere nel link di condivisione di una scheda.
export function schedaPayload(s) {
  return {
    v: 1, id: s.id, nome: s.nome, coach: s.coach || '', nota: s.nota || '', ver: Date.now(),
    modelli: s.modelli.map(getTemplate).filter(Boolean).map(t => {
      const { id, ...m } = cleanTemplate(t);
      return compact({ ...m, chiave: templateKey(t) });
    }),
  };
}

// Controlla una scheda ricevuta e la prepara per l'anteprima (non salva nulla).
export function readScheda(p) {
  if (!p || !ID_RE.test(p.id) || !Array.isArray(p.modelli)) throw new Error('Scheda non valida');
  const modelli = p.modelli.slice(0, 50).map(m => {
    const t = cleanTemplate(m);
    if (!t) return null;
    delete t.id;
    t.chiave = ID_RE.test(m.chiave) ? m.chiave : uid();
    return t;
  }).filter(Boolean);
  if (!modelli.length) throw new Error('La scheda non contiene allenamenti');
  const esistente = getScheda(p.id);
  return {
    id: p.id, nome: str(p.nome, 60) || 'Scheda', coach: str(p.coach, 40), nota: str(p.nota, 500),
    ver: Number(p.ver) || Date.now(), modelli,
    esistente: esistente ? (esistente.ricevuta ? 'ricevuta' : 'mia') : null,
  };
}

// Salva una scheda ricevuta; se c'è già, la aggiorna mantenendo le preferenze video dell'atleta.
export function importScheda(sc) {
  const existing = getScheda(sc.id);
  if (existing && !existing.ricevuta) throw new Error('Questa scheda è stata creata su questo telefono.');
  const old = existing ? existing.modelli.map(getTemplate).filter(Boolean) : [];
  const byKey = new Map(old.map(t => [templateKey(t), t]));
  const nuovi = sc.modelli.map(m => {
    const prev = byKey.get(m.chiave);
    return { ...m, id: prev?.id ?? uid(), ...(prev && { registra: prev.registra, fotocamera: prev.fotocamera, audio: prev.audio }) };
  });
  const oldIds = new Set(old.map(t => t.id));
  const scheda = {
    id: sc.id, nome: sc.nome, coach: sc.coach, nota: sc.nota, ver: sc.ver, ricevuta: true,
    modelli: nuovi.map(t => t.id), data: new Date().toISOString(),
  };
  const nextT = templates.filter(t => !oldIds.has(t.id)).concat(nuovi);
  const nextS = existing ? schede.map(s => (s.id === sc.id ? scheda : s)) : schede.concat(scheda);
  write(KEY_TPL, nextT);
  write(KEY_SCH, nextS);
  templates = nextT;
  schede = nextS;
  return { aggiornata: !!existing, n: nuovi.length };
}

// --- Storico personale ------------------------------------------------------

export const getStorico = () => storico.slice();

export function saveResult(r) {
  const i = storico.findIndex(x => x.id === r.id);
  let next = storico.slice();
  if (i >= 0) next[i] = r; else next.push(r);
  if (next.length > MAX_STORICO) next = next.slice(-MAX_STORICO);
  write(KEY_STO, next);
  storico = next;
}

export function deleteResult(id) {
  const next = storico.filter(r => r.id !== id);
  write(KEY_STO, next);
  storico = next;
}

export function clearStorico() {
  write(KEY_STO, []);
  storico = [];
}

// --- Risultati ricevuti dagli atleti (lato coach) ----------------------------

export const getAtleti = () => atleti.slice();

// Ritorna quanti risultati nuovi sono stati aggiunti e quanti erano già presenti.
export function importRisultati(p) {
  const atleta = str(p?.atleta, 40) || 'Atleta senza nome';
  const list = (Array.isArray(p?.risultati) ? p.risultati : []).slice(0, 1000).map(cleanResult).filter(Boolean);
  if (!list.length) throw new Error('Nessun risultato valido nel link');
  const known = new Set(atleti.map(r => r.id));
  const nuovi = list.filter(r => !known.has(r.id)).map(r => ({ ...r, atleta }));
  let next = atleti.concat(nuovi);
  if (next.length > MAX_ATLETI) next = next.slice(-MAX_ATLETI);
  write(KEY_ATL, next);
  atleti = next;
  return { atleta, nuovi: nuovi.length, presenti: list.length - nuovi.length };
}

export function deleteAtleta(nome) {
  const next = atleti.filter(r => r.atleta !== nome);
  write(KEY_ATL, next);
  atleti = next;
}

// --- Backup completo --------------------------------------------------------

export function exportJSON() {
  return JSON.stringify({ app: 'tempro', versione: 2, modelli: templates, schede, storico, atleti }, null, 2);
}

// Importa un backup (anche della versione 1, solo modelli). I modelli ricevono nuovi id;
// schede, storico e risultati si aggiungono senza duplicati. Ritorna quanti modelli.
export function importJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.modelli;
  if (!Array.isArray(list)) throw new Error('File non valido');
  const idMap = new Map();
  const nuovi = list.map(m => {
    const t = cleanTemplate(m);
    if (!t) return null;
    if (m.id) idMap.set(m.id, t.id);
    if (m.chiave && ID_RE.test(m.chiave)) t.chiave = m.chiave;
    if (/^data:image\/(png|jpeg|webp);base64,/.test(m.immagine || '')) t.immagine = m.immagine;
    return t;
  }).filter(Boolean);
  const nuoveSchede = (Array.isArray(data?.schede) ? data.schede : [])
    .filter(s => s && ID_RE.test(s.id) && !getScheda(s.id) && Array.isArray(s.modelli))
    .map(s => ({
      id: s.id, nome: str(s.nome, 60) || 'Scheda', coach: str(s.coach, 40), nota: str(s.nota, 500),
      ricevuta: !!s.ricevuta, ver: Number(s.ver) || 0, data: s.data,
      modelli: s.modelli.map(id => idMap.get(id)).filter(Boolean),
    }));
  const known = new Set(storico.map(r => r.id));
  const sto = (Array.isArray(data?.storico) ? data.storico : []).map(cleanResult).filter(r => r && !known.has(r.id));
  const knownA = new Set(atleti.map(r => r.id));
  const atl = (Array.isArray(data?.atleti) ? data.atleti : [])
    .map(r => { const c = cleanResult(r); return c && { ...c, atleta: str(r.atleta, 40) || 'Atleta senza nome' }; })
    .filter(r => r && !knownA.has(r.id));
  commit(templates.concat(nuovi));
  if (nuoveSchede.length) commitSchede(schede.concat(nuoveSchede));
  if (sto.length) { storico = storico.concat(sto).slice(-MAX_STORICO); write(KEY_STO, storico); }
  if (atl.length) { atleti = atleti.concat(atl).slice(-MAX_ATLETI); write(KEY_ATL, atleti); }
  return nuovi.length;
}

// --- Preferenze -------------------------------------------------------------

export function getSelected(tipo) {
  const id = read(KEY_SEL, {})[tipo];
  return getTemplate(id) ? id : getTemplates(tipo)[0]?.id ?? null;
}
export function setSelected(tipo, id) {
  try { write(KEY_SEL, { ...read(KEY_SEL, {}), [tipo]: id }); } catch { /* non critico */ }
}

export function getSettings() {
  return { suoni: true, voce: true, vibrazione: true, nomeAtleta: '', nomeCoach: '', ...read(KEY_SET, {}) };
}
export function saveSettings(s) {
  try { write(KEY_SET, s); } catch { /* non critico */ }
}

export const getTab = () => read(KEY_TAB, 'round');
export const setTab = tab => { try { write(KEY_TAB, tab); } catch { /* non critico */ } };
