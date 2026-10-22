// Andamento: misure dei risultati, grafici (SVG), statistiche e testi da inviare al coach.
// Nessuna dipendenza dalla UI: riceve risultati, restituisce dati o stringhe.
import { fmt, fmtShort, fmtTenths } from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const dateLabel = iso => new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
export const dateTimeLabel = iso => new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Serie da disegnare per i risultati di un modello. La misura è la stessa per tutte le sessioni:
// Entro il tempo → esecuzioni (con obiettivo); Round → ripetizioni se annotate, altrimenti fatica,
// altrimenti round completati; Cronometro → giro migliore se ci sono giri, altrimenti durata.
export function seriesFor(results) {
  const rs = results.slice().sort((a, b) => a.data.localeCompare(b.data));
  const tipo = rs[0]?.tipo;
  const pick = (name, get, opts = {}) => ({
    name, ...opts,
    points: rs.filter(r => get(r) != null).map(r => ({ y: get(r), r })),
  });
  if (tipo === 'tempo') {
    const sec = rs.at(-1).unita === 'secondi';
    return pick(sec ? 'Secondi' : 'Esecuzioni', r => r.fatte ?? 0, { target: rs.at(-1).obiettivo, time: sec });
  }
  if (tipo === 'round') {
    if (rs.some(r => r.ripetizioni != null)) return pick('Ripetizioni', r => r.ripetizioni);
    if (rs.some(r => r.fatica != null)) return pick('Fatica (1–10)', r => r.fatica, { min: 0, max: 10 });
    return pick('Round completati', r => r.roundFatti ?? 0, { min: 0 });
  }
  if (rs.some(r => r.giroMigliore != null)) return pick('Giro migliore', r => r.giroMigliore, { time: true, tenths: true, lowerIsBetter: true });
  return pick('Durata', r => r.durataSec ?? 0, { time: true });
}

export function formatValue(s, y) {
  if (s.tenths) return fmtTenths(y);
  if (s.time) return fmtShort(y);
  return String(Math.round(y * 10) / 10).replace('.', ',');
}

// Grafico a linea di una sola serie (una sessione per punto, in ordine di data).
// Ogni punto ha un'area di tocco più grande del segno, con il testo del suggerimento in data-tip.
export function chartSvg(s, { w = 320, h = 132 } = {}) {
  const pts = s.points;
  if (!pts.length) return '<p class="chart-empty">Nessun dato da mostrare.</p>';
  const L = 34, R = 10, T = 12, B = 22;
  const ys = pts.map(p => p.y).concat(s.target != null ? [s.target] : []);
  let lo = s.min ?? Math.min(...ys), hi = s.max ?? Math.max(...ys);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const pad = (hi - lo) * 0.12;
  if (s.min == null) lo = Math.max(0, lo - pad);
  if (s.max == null) hi += pad;
  // Conteggi (esecuzioni, ripetizioni, round): asse a numeri interi, con il valore centrale intero.
  if (!s.time && ys.every(Number.isInteger)) {
    lo = Math.floor(lo);
    hi = Math.ceil(hi);
    if ((hi - lo) % 2) hi += 1;
  }
  const x = i => (pts.length === 1 ? (L + w - R) / 2 : L + (i * (w - L - R)) / (pts.length - 1));
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  const grid = [lo, (lo + hi) / 2, hi].map(v => `
    <line x1="${L}" x2="${w - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>
    <text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${esc(formatValue(s, v))}</text>`).join('');
  const target = s.target != null ? `
    <line x1="${L}" x2="${w - R}" y1="${y(s.target).toFixed(1)}" y2="${y(s.target).toFixed(1)}" class="target"/>
    <text x="${w - R}" y="${(y(s.target) - 5).toFixed(1)}" class="axis" text-anchor="end">obiettivo ${esc(formatValue(s, s.target))}</text>` : '';
  const line = pts.length > 1 ? `<polyline class="line" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')}"/>` : '';
  const slot = pts.length > 1 ? (w - L - R) / (pts.length - 1) : w;
  const dots = pts.map((p, i) => {
    const tip = `${dateTimeLabel(p.r.data)} · ${s.name}: ${formatValue(s, p.y)}${p.r.fatica ? ` · fatica ${p.r.fatica}/10` : ''}`;
    return `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="4"/>
      <rect class="hit" x="${(x(i) - Math.max(12, slot / 2)).toFixed(1)}" y="0" width="${Math.max(24, slot).toFixed(1)}" height="${h}" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
  }).join('');
  const first = dateLabel(pts[0].r.data), last = dateLabel(pts.at(-1).r.data);
  const label = `${s.name}, ${pts.length} sessioni dal ${first} al ${last}, ultimo valore ${formatValue(s, pts.at(-1).y)}`;
  return `<figure class="chart">
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
      ${grid}${target}${line}${dots}
      <text x="${L}" y="${h - 4}" class="axis">${esc(first)}</text>
      ${pts.length > 1 ? `<text x="${w - R}" y="${h - 4}" class="axis" text-anchor="end">${esc(last)}</text>` : ''}
    </svg>
    <figcaption class="chart-tip">Tocca un punto per vedere il valore</figcaption>
  </figure>`;
}

// Riepilogo in una riga di un risultato (per elenchi e messaggi).
export function resultLine(r) {
  let s;
  if (r.tipo === 'tempo') {
    const diff = (r.fatte ?? 0) - (r.obiettivo ?? 0);
    const v = n => (r.unita === 'secondi' ? fmtShort(n) : String(n));
    s = `${v(r.fatte ?? 0)} su ${v(r.obiettivo ?? 0)} (${diff ? `${diff > 0 ? '+' : '−'}${v(Math.abs(diff))}` : 'obiettivo centrato'})`;
    if (r.raggiuntoAl != null) s += `, obiettivo a ${fmt(r.raggiuntoAl)}`;
    if (r.serie?.length) s += `, ${r.serie.length} serie`;
  } else if (r.tipo === 'round') {
    s = `${r.roundFatti ?? 0}/${r.roundTotali ?? 0} round`;
    if (r.lavoroSec) s += `, lavoro ${fmtShort(r.lavoroSec)}`;
    if (r.ripetizioni != null) s += `, ${r.ripetizioni} ripetizioni`;
  } else {
    s = fmt(r.durataSec ?? 0);
    if (r.giri) s += `, ${r.giri} giri${r.giroMigliore != null ? ` (migliore ${fmtTenths(r.giroMigliore)})` : ''}`;
    if (r.ripetizioni != null) s += `, ${r.ripetizioni} ripetizioni`;
  }
  if (!r.completo) s += ' (interrotto)';
  if (r.fatica) s += ` · fatica ${r.fatica}/10`;
  return s;
}

// Testo leggibile del messaggio al coach (il link con i dati viene aggiunto a parte).
export function coachMessage(results, atleta) {
  const who = atleta ? ` — ${atleta}` : '';
  if (results.length === 1) {
    const r = results[0];
    return `${r.nome}: ${resultLine(r)}${r.nota ? ` · "${r.nota}"` : ''}${who}`;
  }
  const scheda = results[0].schedaNome || 'Allenamenti';
  const lines = results.slice(-8).map(r => `• ${dateLabel(r.data)} ${r.nome}: ${resultLine(r)}`);
  if (results.length > 8) lines.unshift(`(ultimi 8 di ${results.length})`);
  return `Andamento "${scheda}"${who}\n${lines.join('\n')}`;
}

// Allenamenti di questa settimana (da lunedì), di questo mese e giorni consecutivi fino a oggi.
export function stats(results, now = new Date()) {
  const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = day(now);
  const monday = today - ((new Date(today).getDay() + 6) % 7) * 864e5;
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const days = new Set(results.map(r => day(r.data)));
  let streak = 0;
  for (let d = days.has(today) ? today : today - 864e5; days.has(d); d -= 864e5) streak++;
  const t = r => new Date(r.data).getTime();
  return {
    settimana: results.filter(r => t(r) >= monday).length,
    mese: results.filter(r => t(r) >= month).length,
    giorni: streak,
  };
}

// Raggruppa i risultati per scheda e poi per modello, i gruppi più recenti prima.
export function groupResults(results) {
  const schede = new Map();
  for (const r of results) {
    const sk = r.scheda ?? '';
    if (!schede.has(sk)) schede.set(sk, { id: r.scheda ?? null, nome: r.schedaNome || 'Allenamenti personali', modelli: new Map(), last: '' });
    const g = schede.get(sk);
    if (r.schedaNome) g.nome = r.schedaNome;
    if (!g.modelli.has(r.modello)) g.modelli.set(r.modello, { key: r.modello, nome: r.nome, tipo: r.tipo, results: [], last: '' });
    const m = g.modelli.get(r.modello);
    m.results.push(r);
    m.nome = r.nome;
    if (r.data > m.last) m.last = r.data;
    if (r.data > g.last) g.last = r.data;
  }
  const byLast = (a, b) => b.last.localeCompare(a.last);
  return [...schede.values()].sort(byLast).map(g => ({ ...g, modelli: [...g.modelli.values()].sort(byLast) }));
}
