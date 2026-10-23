# Tempro

Web app (PWA) per il telefono: timer a round (Tabata), lavoro entro il tempo con obiettivo, cronometro e conto alla rovescia.
Nessun server e nessun dato personale: i modelli sono salvati solo nel browser del dispositivo (`localStorage`).

Pubblicata con GitHub Pages dal repository `MassimoAmoruso/Tempro` (file nella radice): https://massimoamoruso.github.io/Tempro/

## Modalità

- **Round**: Prepara → [Lavoro → Riposo] × round per ciclo → Riposo tra i cicli → … × cicli → Rinfrescati.
- **Entro il tempo**: Prepara, poi il tempo totale (riposi compresi) scorre. A fine serie premi **✓**, segni le esecuzioni e parte il riposo. Allo scadere ottieni il riepilogo con la differenza rispetto all'obiettivo.
- **Cronometro**: in avanti con giri, oppure conto alla rovescia.

Per ogni tipo puoi creare più modelli (scheda **Modelli**) e associare a ciascuno un'immagine (link o foto dal telefono) e un link video, entrambi facoltativi.
Dalle impostazioni puoi esportare e importare i modelli come file JSON.

## Schede coach → atleta

- **Coach**: in Modelli → **+ Nuova scheda** sceglie gli allenamenti, il nome della scheda, il proprio nome e una nota (facoltativi), poi **Condividi** (es. WhatsApp).
- **Atleta**: tocca il link → anteprima → **Importa**. Le schede ricevute restano raggruppate in Modelli; se il coach invia una nuova versione della stessa scheda, l'app propone **Aggiorna**.
- Su iPhone Safari e l'app sulla Home hanno memorie separate: se il link si apre in Safari, usare **Copia per l'app** e poi, nell'app, **Incolla una scheda o dei risultati**.
- La scheda viaggia nella parte del link dopo `#`, che non viene inviata al server. Le foto caricate dal telefono non vengono condivise (i link sì).

### Eseguire una scheda in sequenza

- Nell'editor della scheda si imposta l'**ordine di esecuzione** (frecce ↑↓); per le schede ricevute vale l'ordine del coach.
- **Avvia scheda** esegue gli allenamenti uno dopo l'altro: tra uno e l'altro parte il **riposo dell'allenamento appena concluso** (il Cronometro non ha riposo), poi il successivo parte da solo senza "Prepara".
- In alto la barra "Scheda · 2 di 4 · poi: …" con **Esci**. Il cronometro in avanti passa al successivo con il pulsante ⏭.
- "Com'è andata?" compare una volta sola a fine scheda; con la ripresa attiva si registra un unico video di tutti i lavori.

## Entro il tempo: ripetizioni o secondi

Nel modello si sceglie **Obiettivo in: Ripetizioni / Secondi**. In secondi (es. plank) a fine serie viene proposta la durata cronometrata della serie, modificabile; riepiloghi, grafici e messaggi mostrano i tempi.

## Andamento e risultati

- A fine allenamento il risultato viene salvato nello **storico** (solo sul telefono) e si apre **Com'è andata?** (fatica 1–10, ripetizioni, nota; facoltativi).
- **Salva e invia al coach** prepara un messaggio con il riepilogo e un link; **Andamento → Invia al coach** invia tutti i risultati di una scheda.
- Pagina **Andamento**: allenamenti della settimana/mese, giorni di fila, grafico per ogni allenamento, elenco delle sessioni.
- Toccando una sessione in **Tutte le sessioni** si apre il **dettaglio** (serie con durata e minuto, giri, round, fatica e nota), con Modifica valutazione, Invia al coach ed Elimina. Orari delle serie e tempi dei giri sono salvati dalla versione 11.
- **Lato coach**: aprendo il link dei risultati (o incollandolo) i dati finiscono in **Andamento → Atleti**, divisi per atleta; i doppioni vengono ignorati.
- Il nome dell'atleta è facoltativo (Impostazioni → Coach).

## Ripresa video dei lavori

Nel modello, sezione **Video**: "Registra le fasi di lavoro", fotocamera (frontale/posteriore) e audio.
All'avvio si apre l'inquadratura; durante l'allenamento si registra solo durante i lavori (in pausa nelle altre fasi) e alla fine si ottiene **un unico video** da salvare o scartare.
Il video viene scritto temporaneamente sul telefono (IndexedDB) e cancellato dopo Salva/Scarta; se l'app si chiude prima, alla riapertura viene riproposto. Non viene mai inviato a server.
L'app deve restare in primo piano durante la ripresa.

## Struttura

```
index.html             pagina unica
styles.css             grafica
js/engine.js           motore del timer (senza UI)
js/storage.js          salvataggio di modelli, schede, storico, risultati atleti, impostazioni
js/app.js              interfaccia
js/recorder.js         ripresa video dei lavori
js/share.js            link condivisibili (schede e risultati)
js/report.js           andamento: grafici, statistiche, messaggi al coach
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
