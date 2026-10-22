// Salvataggio locale (solo su questo dispositivo): modelli, impostazioni, selezione.
// Nessun dato personale, nessun server.

const KEY_TPL = 'timer.modelli.v1';
const KEY_SET = 'timer.impostazioni.v1';
const KEY_SEL = 'timer.selezione.v1';
const KEY_TAB = 'timer.tab.v1';

export const TYPES = {
  round: {
    nome: 'Round',
    defaults: () => ({ prepara: 10, lavoro: 20, riposo: 10, roundPerCiclo: 10, cicli: 1, riposoTraCicli: 60, rinfrescati: 0 }),
  },
  tempo: {
    nome: 'Entro il tempo',
    defaults: () => ({ prepara: 10, tempoTotale: 600, obiettivo: 100, riposo: 30 }),
  },
  cronometro: {
    nome: 'Cronometro',
    defaults: () => ({ direzione: 'avanti', prepara: 5, durata: 300 }),
  },
};

const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
// Può lanciare un'eccezione se lo spazio è esaurito: la gestisce il chiamante.
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

export function newTemplate(tipo, nome) {
  return { id: uid(), tipo, nome: nome ?? TYPES[tipo].nome, immagine: '', video: '', ...TYPES[tipo].defaults() };
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

function commit(next) {
  write(KEY_TPL, next);   // se fallisce, lo stato in memoria resta quello precedente
  templates = next;
}

export const getTemplates = tipo => (tipo ? templates.filter(t => t.tipo === tipo) : templates.slice());
export const getTemplate = id => templates.find(t => t.id === id);

export function saveTemplate(t) {
  const i = templates.findIndex(x => x.id === t.id);
  const next = templates.slice();
  if (i >= 0) next[i] = t; else next.push(t);
  commit(next);
}

export function deleteTemplate(id) { commit(templates.filter(t => t.id !== id)); }

export function duplicateTemplate(id) {
  const t = getTemplate(id);
  const copy = { ...t, id: uid(), nome: `${t.nome} (copia)` };
  const next = templates.slice();
  next.splice(templates.indexOf(t) + 1, 0, copy);
  commit(next);
  return copy;
}

export function exportJSON() {
  return JSON.stringify({ app: 'timer-allenamento', versione: 1, modelli: templates }, null, 2);
}

// Importa modelli da un backup: vengono aggiunti con nuovi id. Ritorna quanti.
export function importJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.modelli;
  if (!Array.isArray(list)) throw new Error('File non valido');
  const valid = list
    .filter(t => t && TYPES[t.tipo])
    .map(t => ({ ...newTemplate(t.tipo), ...t, id: uid() }));
  commit(templates.concat(valid));
  return valid.length;
}

export function getSelected(tipo) {
  const id = read(KEY_SEL, {})[tipo];
  return getTemplate(id) ? id : getTemplates(tipo)[0]?.id ?? null;
}
export function setSelected(tipo, id) {
  try { write(KEY_SEL, { ...read(KEY_SEL, {}), [tipo]: id }); } catch { /* non critico */ }
}

export function getSettings() {
  return { suoni: true, voce: true, vibrazione: true, ...read(KEY_SET, {}) };
}
export function saveSettings(s) {
  try { write(KEY_SET, s); } catch { /* non critico */ }
}

export const getTab = () => read(KEY_TAB, 'round');
export const setTab = tab => { try { write(KEY_TAB, tab); } catch { /* non critico */ } };
