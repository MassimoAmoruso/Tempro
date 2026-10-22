# Tempro

Web app (PWA) per il telefono: timer a round (Tabata), lavoro entro il tempo con obiettivo, cronometro e conto alla rovescia.
Nessun server e nessun dato personale: i modelli sono salvati solo nel browser del dispositivo (`localStorage`).

Pubblicata con GitHub Pages: https://massimoamoruso.github.io/Timer/timer/

## Modalità

- **Round**: Prepara → [Lavoro → Riposo] × round per ciclo → Riposo tra i cicli → … × cicli → Rinfrescati.
- **Entro il tempo**: Prepara, poi il tempo totale (riposi compresi) scorre. A fine serie premi **✓**, segni le esecuzioni e parte il riposo. Allo scadere ottieni il riepilogo con la differenza rispetto all'obiettivo.
- **Cronometro**: in avanti con giri, oppure conto alla rovescia.

Per ogni tipo puoi creare più modelli (scheda **Modelli**) e associare a ciascuno un'immagine (link o foto dal telefono) e un link video, entrambi facoltativi.
Dalle impostazioni puoi esportare e importare i modelli come file JSON.

## Struttura

```
index.html             pagina unica
styles.css             grafica
js/engine.js           motore del timer (senza UI)
js/storage.js          salvataggio modelli e impostazioni
js/app.js              interfaccia
sw.js                  cache offline (aggiornare VERSION ad ogni rilascio)
manifest.webmanifest   installazione come app
icons/                 icona dell'app (svg + png) e logo testuale (wordmark.svg)
```

## Aggiornare il sito

1. Cambia `VERSION` in `sw.js` (es. `tempro-v3`), così i telefoni scaricano la nuova versione.
2. Su GitHub, nella cartella `timer` del repository, carica i file modificati (**Add file → Upload files**), mantenendo le cartelle `js` e `icons`.
3. Dopo 1-2 minuti riapri l'app sul telefono: con la rete attiva carica subito la versione nuova (senza rete usa l'ultima salvata).

## Provarla sul computer

```
python3 -m http.server 8000
```

e apri http://localhost:8000.

## Note iPhone

- Con il tasto silenzioso attivo i suoni web non si sentono; la vibrazione non è supportata da Safari. Il colore della fase indica sempre a che punto sei.
- Se l'app va in background il tempo resta corretto (è calcolato da timestamp), ma gli avvisi riprendono solo quando torni nell'app.
- Le chiavi di salvataggio restano `timer.*` anche con il nome Tempro: i modelli creati prima del cambio di nome non si perdono.
