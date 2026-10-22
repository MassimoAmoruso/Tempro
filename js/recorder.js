// Ripresa video dei soli lavori: un'unica registrazione (MediaRecorder) che si mette in pausa
// fuori dalle fasi di lavoro. I pezzi vengono scritti subito sul telefono (IndexedDB) invece che
// in memoria, e cancellati quando il video viene salvato o scartato. Nulla esce dal dispositivo.
import { Clock } from './engine.js';

// Formati in ordine di preferenza: MP4 (iPhone, Chrome recenti), poi WebM (Android meno recenti).
const MIME_TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export const cameraSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.indexedDB);

// --- Archivio temporaneo ----------------------------------------------------

let dbPromise = null;
function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tempro-video', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessioni', { keyPath: 'id' });
      d.createObjectStore('pezzi', { autoIncrement: true }).createIndex('sid', 'sid');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Esegue fn in una transazione; risolve con il risultato della richiesta restituita da fn.
function tx(stores, mode, fn) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

export const videoStore = {
  saveMeta: meta => tx(['sessioni'], 'readwrite', t => t.objectStore('sessioni').put(meta)),
  addChunk: (sid, blob) => tx(['pezzi'], 'readwrite', t => t.objectStore('pezzi').add({ sid, blob })),
  list: () => tx(['sessioni'], 'readonly', t => t.objectStore('sessioni').getAll()),
  async blob(meta) {
    // L'indice restituisce i pezzi nell'ordine in cui sono stati scritti.
    const rows = await tx(['pezzi'], 'readonly', t => t.objectStore('pezzi').index('sid').getAll(meta.id));
    return new Blob(rows.map(r => r.blob), { type: meta.mime });
  },
  remove: sid => tx(['sessioni', 'pezzi'], 'readwrite', t => {
    t.objectStore('sessioni').delete(sid);
    const pezzi = t.objectStore('pezzi');
    pezzi.index('sid').openKeyCursor(IDBKeyRange.only(sid)).onsuccess = e => {
      const c = e.target.result;
      if (c) { pezzi.delete(c.primaryKey); c.continue(); }
    };
  }),
};

// --- Registrazione ----------------------------------------------------------

export class WorkRecorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.meta = null;          // sessione di registrazione in corso
    this.clock = new Clock();  // tempo effettivamente registrato
    this.writes = Promise.resolve();
    this.error = null;
  }

  get active() { return !!this.meta; }
  get recording() { return this.rec?.state === 'recording'; }
  get recordedSec() { return this.clock.ms / 1000; }

  async open({ facing = 'user', audio = true } = {}) {
    this.closeStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio,
    });
    return this.stream;
  }

  closeStream() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  begin(nome) {
    this.meta = { id: `v${Date.now()}`, nome, mime: '', creato: new Date().toISOString(), durata: 0 };
    this.clock.reset();
    this.error = null;
  }

  // Chiamato a ogni tick: registra durante i lavori, in pausa altrimenti.
  setWorking(on) {
    if (!this.meta || !this.stream || this.error) return;
    if (on) {
      if (!this.rec) this._start();
      else if (this.rec.state === 'paused') this.rec.resume();
      this.clock.start();
    } else {
      if (this.rec?.state === 'recording') this.rec.pause();
      this.clock.pause();
    }
  }

  _start() {
    const mime = MIME_TYPES.find(t => MediaRecorder.isTypeSupported?.(t)) ?? '';
    const rec = new MediaRecorder(this.stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: 2_500_000 });
    const meta = this.meta;
    meta.mime = rec.mimeType || mime || 'video/mp4';
    rec.ondataavailable = e => {
      if (!e.data?.size) return;
      this.writes = this.writes.then(() => videoStore.addChunk(meta.id, e.data)).catch(err => { this.error = err; });
    };
    rec.onerror = e => { this.error = e.error ?? new Error('Errore di registrazione'); };
    this.rec = rec;
    this.writes = this.writes.then(() => videoStore.saveMeta(meta)).catch(err => { this.error = err; });
    rec.start(1000);   // un pezzo al secondo, scritto subito sul telefono
  }

  // Chiude la registrazione e la fotocamera. Ritorna i dati del video salvato, o null se non è stato registrato nulla.
  async finish() {
    const meta = this.meta, rec = this.rec;
    this.meta = null;
    this.rec = null;
    this.clock.pause();
    if (rec && rec.state !== 'inactive') {
      await new Promise(resolve => { rec.addEventListener('stop', resolve, { once: true }); rec.stop(); });
    }
    this.closeStream();
    await this.writes;
    if (!meta || !rec) return null;
    meta.durata = Math.round(this.clock.ms / 1000);
    await videoStore.saveMeta(meta);
    return meta;
  }
}
