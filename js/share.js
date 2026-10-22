// Link condivisibili per schede (coach → atleta) e risultati (atleta → coach).
// Il contenuto viaggia nella parte del link dopo il "#", che il browser non invia mai al server.
// Formato: #s=<dati> per una scheda, #r=<dati> per i risultati; <dati> inizia con
// "z" se compresso (deflate) oppure "j" se è JSON semplice, poi base64url.

const KINDS = { s: 'scheda', r: 'risultati' };
const PREFIX = { scheda: 's', risultati: 'r' };

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function appUrl() {
  return `${location.origin}${location.pathname}`;
}

export async function encodeLink(kind, data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let payload;
  if ('CompressionStream' in window) payload = 'z' + toB64url(await pipe(bytes, new CompressionStream('deflate-raw')));
  else payload = 'j' + toB64url(bytes);
  return `${appUrl()}#${PREFIX[kind]}=${payload}`;
}

// Cerca un link di Tempro in un testo qualsiasi (link, messaggio WhatsApp incollato…).
// Ritorna { kind, data } oppure null; lancia un errore se il link è presente ma illeggibile.
export async function decodeLink(text) {
  const m = String(text || '').match(/#([sr])=([zj])([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let bytes = fromB64url(m[3]);
  if (m[2] === 'z') {
    if (!('DecompressionStream' in window)) throw new Error('Questo browser è troppo vecchio per aprire il link: aggiorna il sistema.');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== 'object') throw new Error('Link non valido');
  return { kind: KINDS[m[1]], data };
}

// Safari su iPhone/iPad aperto come pagina (non come app dalla Home): ha una memoria separata dall'app.
export function isIosBrowser() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
}
