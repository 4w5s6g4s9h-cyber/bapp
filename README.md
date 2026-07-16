# Vermogen — lokale beleggingstracker

Vermogen is een statische browserapp voor het importeren en analyseren van een eigen portefeuille. Er is geen applicatiebackend, account of cloudsynchronisatie. Portfoliodata staat in `localStorage`; externe koersdata is standaard uitgeschakeld en vereist expliciete toestemming.

> Experimentele analyse, geen beleggingsadvies. Gereconstrueerde koersen worden alleen voor visualisatie gebruikt en zijn uitgesloten van ML, backtests, DCA-simulaties en risico-advies.

## Starten

```bash
python3 -m http.server 8642
```

Open daarna `http://localhost:8642`. Een HTTP-server is nodig voor betrouwbaar PWA- en service-workergedrag.

Voor ontwikkeling en controle is Node.js 20 of nieuwer nodig:

```bash
npm run check
```

De runtime-app zelf heeft geen npm-dependencies en geen buildstap.

## Belangrijkste functies

- Dashboard met effecten én cash, cashflow-gecorrigeerd dagresultaat, TWR, jaarlijks geldgewogen rendement (XIRR) en watchlist.
- Cashledger voor koop/verkoop, storting/opname, dividend/rente, fees/belasting, splits en assettransfers. Interne trades veranderen de externe inleg niet.
- Gemiddelde kostbasis, gerealiseerd resultaat, ledgerwaarschuwingen en brokerreconciliatie op aantallen en cash.
- JSON-import en aanvullende DEGIRO/Bitvavo-CSV-import met strikte validatie, fees, cash-/assettransfers, transactiededupe en rollback bij opslagfouten.
- Volledige versie-3-backup en restore van ledger, reconciliatie, assets, koersen, herkomst, watchlist, alerts en DCA-plannen; versie 2 migreert automatisch.
- Expliciete koersherkomst per dag. Analyses vereisen minimaal 90% echte dekking in hun analysevenster.
- Assetweergave, RSI/MACD, experimentele neurale projectie en een model-arena met vier expanding-window walk-forward-folds.
- Backtests over 730 kalenderdagen, transactiekosten en aparte in-/out-of-sample auto-tune.
- Cashflow-gecorrigeerde volatiliteit, Sharpe, drawdown, correlatie en Markowitz-verkenning.
- DCA-plannen als lokale boekhoudautomatisering. Er worden geen echte brokerorders geplaatst; een termijn wordt alleen geboekt als voor die dag een echte koers bekend is.
- In-app alerts; geen achtergrondserver en dus geen push wanneer de app gesloten is.
- Afzonderlijk opt-in automatisch verversen zolang de app open is: crypto maximaal elk uur in één batch en aandelen/ETF’s maximaal dagelijks in batches van tien.
- Offline shell via een service worker die uitsluitend succesvolle same-origin-responses cachet.

## Privacy en externe data

Zonder toestemming doet de app geen koersnetwerkcalls. Na het aanzetten van **Instellingen → Privacy en netwerk** kunnen uitsluitend assetzoektermen, tickers of externe asset-id's naar deze diensten gaan:

- CoinGecko voor crypto;
- Yahoo Finance voor aandelen en ETF's;
- optioneel Alpha Vantage als browservriendelijke koersroute voor aandelen en ETF's;
- Frankfurter voor conversie naar EUR.

Transacties, aantallen, kostprijzen en portefeuillewaarden worden niet in deze calls meegestuurd. Directe Yahoo-calls kunnen door browser-CORS worden geblokkeerd. In dat geval kan een eigen Alpha Vantage API-sleutel lokaal worden opgeslagen; zodra die is ingesteld probeert de app deze route eerst. De gratis API levert maximaal 100 recente handelsdagen. De sleutel wordt niet geëxporteerd in backups. Voor langere, volledige historie blijft eigen import de betrouwbare route.

Automatisch verversen heeft een eigen schakelaar en wordt nooit stilzwijgend door netwerktoestemming geactiveerd. CoinGecko-spotprijzen worden maximaal eenmaal per uur in één call bijgewerkt. De gratis aandelenbronnen leveren dagdata; daarom worden aandelen en ETF’s maximaal eenmaal per dag en in kleine batches bijgewerkt. Bij terugkeer naar een verouderde tab controleert de app direct of een groep aan de beurt is. Browsers mogen achtergrondtabs pauzeren en er wordt niets uitgevoerd wanneer de app gesloten is. Dynamisch gevonden CoinGecko-ID’s worden lokaal bij de watch-asset bewaard, zodat ook die koppelingen een reload overleven.

`localStorage` is niet versleuteld en wordt gedeeld door pagina's op dezelfde origin. Gebruik de app daarom op een vertrouwd apparaat en host haar bij voorkeur op een eigen origin. Backupbestanden bevatten financiële data en horen niet in Git of gedeelde opslag.

## Data-integriteit

- Asset-id's, datums, getallen, reekslengtes, kleuren en externe antwoorden worden gevalideerd.
- Een restore accepteert backup-schema 2 en 3, migreert oude trades waarderingsneutraal naar schema v4 en schakelt netwerktoestemming opnieuw uit.
- Een restore schakelt ook automatisch verversen uit en herstelt geen provider- of refreshsessievoorkeuren.
- Een generieke import kan ontbrekende historie reconstrueren om een grafiek te tonen. De provenance-array blijft dan `false`, zodat die waarden niet teruglekken in financiële analyses.
- Alleen externe stortingen, opnames en transfers worden uit dagrendement en TWR gefilterd; interne trades, dividend en fees blijven terecht onderdeel van het resultaat.
- Een ongeldige verkoop/transfer of split zonder positie wordt fail-closed genegeerd en als ledgerprobleem getoond; een nieuwe handmatige boeking mag het historische cashsaldo niet verder negatief maken.
- Bitvavo-EUR-funding wordt als cash geboekt, trades daartegen als intern; assettransfers zonder koers worden op de beschikbare dagkoers gewaardeerd en stakingrewards krijgen nul kostbasis zonder fictieve externe inleg.
- Aandelen in een vreemde valuta worden alleen geregistreerd als ook een geldige EUR-reeks beschikbaar is; anders faalt de import veilig.

## Architectuur

| Bestand | Verantwoordelijkheid |
|---|---|
| `js/data.js` | Datumgrid, assets, provenance, schema-v4-gebeurtenissen, cashledger, kostbasis, reconciliatie en portefeuillewaarden |
| `js/importer.js` | JSON/CSV-import, backup/restore, atomaire opslag en opt-in koersbronnen |
| `js/ml.js` | Indicatoren, neuraal netwerk, walk-forward model-arena en Monte Carlo |
| `js/quant.js` | TWR, XIRR/XNPV, correlatie, efficient frontier, benchmark en stressscenario's |
| `js/backtest.js` | Signaalstrategieën, kosten, playback en auto-tune |
| `js/catalog.js` | Watchlistcatalogus en gevalideerde watch-only assets |
| `js/dca.js` | DCA-plannen, historische simulatie en lokale termijnboeking |
| `js/alerts.js` | Validatie en evaluatie van lokale alerts |
| `js/charts.js` | SVG- en canvasweergaven |
| `js/app.js` | UI-state, toegangscontroles voor analyses en interactie |
| `sw.js` | Offline app-shellcache |

De scripts zijn klassieke browserscripts en delen bewust één globale runtime. Dat houdt deployment simpel, maar maakt modulegrenzen minder afdwingbaar dan met ES-modules.

## Testen en deployment

`npm run check` voert unit-/regressietests en een publieke-buildcontrole uit. De tests dekken onder meer boekhoudkundige invarianties, v2→v3/v3→v4-migraties, XIRR, brokerimports en reconciliatie. De controle faalt bij onder meer een syntaxfout, cacheversiemismatch, ontbrekend publiek bestand of gevolgd privépaddata. GitHub Actions draait dezelfde controle bij pushes en pull requests.

Deployment is een statische publicatie van de repository-root, bijvoorbeeld via GitHub Pages. Publiceer pas nadat `npm run check` slaagt. Stel daarnaast in de repository-instellingen branch protection in met de CI-job als verplichte statuscheck; dat kan niet vanuit deze lokale repository worden afgedwongen.

Zie [docs/PROJECT_REVIEW.md](docs/PROJECT_REVIEW.md) voor de kritische beoordeling, uitgevoerde verbeteringen en resterende risico's.
