# Vermogen. — Beleggingen Tracker

Een volledig client-side beleggingstracker met interactieve grafieken en échte machine learning in de browser. Geen dependencies, geen build-stap, geen API-keys.

## Starten

```bash
python3 -m http.server 8642
# open http://localhost:8642
```

(Elke statische webserver werkt; er is geen backend. De app is een PWA: installeerbaar en offline bruikbaar. Openen via `file://` kan ook — alleen de PWA/service-worker staat dan uit.)

**Privacy:** de app bevat géén data. Je importeert je portfolio-JSON via Instellingen; alles blijft in de localStorage van je browser. De code kan veilig op GitHub (`.gitignore` sluit portfolio-bestanden uit).

## Features

- **Dashboard** — animated KPI's, interactieve portefeuillegrafiek met **zoom/pan-brush** en **benchmark-vergelijking** ("wat als alles in VWCE?"), allocatie-donut (dust-posities gegroepeerd als "Overig"), positietabel met sparklines en AI-signalen, een **watchlist** met vrij zoekveld (catalogus van ±45 populaire assets, elke beurs-ticker via Yahoo-lookup, crypto via CoinGecko-search) en **sorteerbare positietabel** (klik op een kolomkop).
- **Asset Analyse** — lijn/**candlestick**/**vergelijk**-weergave (genormaliseerd op 100), 30-dagen AI-voorspelling met ~80%-betrouwbaarheidsband, **anomaliedetectie** (>3σ dagen gemarkeerd), RSI & MACD.
- **ML Lab** — neuraal netwerk (20→24→12→1, backpropagation) dat live traint met loss-curve en gewichts-visualisatie; **Model-arena** met walk-forward validatie (NN vs. ridge-regressie vs. naïef momentum, out-of-sample); Monte Carlo-vermogensprojectie met sliders.
- **Backtest** — drie strategieën naast kopen-en-vasthouden, zonder look-ahead, met transactiekosten: **Klassiek** (één drempel), **Hysterese** (dode zone tegen whipsaw) en **Trend + vol-target** (trendfilter + positiegrootte omgekeerd evenredig met volatiliteit). Resultaten-tabel met rendement, drawdown, Sharpe, trades, win-rate en marktblootstelling; instelbare drempel, dag-voor-dag playback en **🎯 Auto-tune**: walk-forward drempeloptimalisatie (70% in-sample, 30% out-of-sample) die eerlijk toont hoeveel van het in-sample resultaat overfitting was.
- **Inzichten** — **efficient frontier (Markowitz)** met 3.500 gesimuleerde portefeuilles en klikbaar herbalanceringsadvies, **correlatie-heatmap**, **stress-tests** (Crash 2008, crypto-winter, rente +2%, zwarte zwaan) met hersteltijd-schatting, risicometrieken en AI-observaties.
- **Transacties + JSON-import** — importeer je eigen portfolio/transactiegeschiedenis (knop of drag-and-drop). De parser is tolerant: NL/EN veldnamen, `dd-mm-jjjj`-datums, komma-decimalen, totaalbedrag i.p.v. koers, geneste structuren en optionele koershistorie. Ontbrekende historie wordt gereconstrueerd rond je transactiekoersen (Brownian bridge). In import-modus worden crypto-koersen **live** bijgewerkt via CoinGecko. Transacties met koers 0 (staking rewards/airdrops) tellen mee in aantallen met kostprijs €0, en het `currentPrice`-veld wordt als koersanker op de snapshotdatum gebruikt.
- **Instellingen** — import/export (backup-JSON met alles erin), alles wissen, en **echte koershistorie**: crypto via CoinGecko én aandelen/ETF's via Yahoo Finance (chart-API via publieke CORS-proxy, automatische beurskeuze .AS/.DE/… en USD→EUR-conversie via frankfurter.dev, ECB-koersen). Statusoverzicht per asset (echt vs. gereconstrueerd). Geen API-keys nodig; alleen tickersymbolen verlaten de browser.
- **TWR** — tijdgewogen rendement (totaal, YTD en per kalenderjaar in Inzichten), gecorrigeerd voor stortingen/opnames — de eerlijke maatstaf naast geldgewogen rendement.
- **Alerts** — regels op koers, 24u-verandering, RSI of portefeuilleweging; gecheckt bij openen en na live koersupdates; badge + toast in de app (geen server, dus geen push).
- **DCA-plannen** — meerdere plannen (vast bedrag of AI-gestuurd: maandbedrag schaalt 0,5×–1,75× mee met het ensemble-signaal, contrair). Vervallen termijnen worden bij het openen van de app automatisch als transacties geboekt; simulatie-preview toont wat het plan de afgelopen 12 maanden had gedaan.
- **Command palette** — ⌘K/Ctrl-K voor navigatie, assets en acties.

## Architectuur

| Bestand | Rol |
|---|---|
| `js/data.js` | Seeded marktsimulatie (GBM met regimes/jumps), portefeuillemodel, transacties |
| `js/ml.js` | Neuraal netwerk + backprop, voorspelling, ridge-regressie, model-arena, anomalieën, indicatoren, Monte Carlo |
| `js/quant.js` | Efficient frontier, herbalanceringsadvies, stress-scenario's, correlatie, benchmark |
| `js/backtest.js` | Signaal-backtester met playback |
| `js/importer.js` | JSON-import (tolerante parser), historie-synthese, live koersen, demo/import-modus |
| `js/charts.js` | Eigen SVG/canvas grafiek-engine (lijn, candles, donut, scatter, heatmap, brush, frontier, fan-chart) |
| `js/alerts.js` | Alertregels: opslag + evaluatie |
| `js/catalog.js` | Watchlist-catalogus + watch-only assets |
| `js/dca.js` | DCA-plannen: uitvoering, AI-multiplier, simulatie |
| `js/app.js` | State, views, instellingen, command palette, interactie |
| `sw.js` + `manifest.webmanifest` | PWA (offline, installeerbaar) |

**Onderhoud:** bij het wijzigen van JS/CSS de `?v=`-versieparameter in `index.html` en de cache-naam + lijst in `sw.js` ophogen (cache-busting).

**Let op:** demo-marktdata is gesimuleerd; import-modus gebruikt jouw echte transacties. Dit is een demo — geen beleggingsadvies.
