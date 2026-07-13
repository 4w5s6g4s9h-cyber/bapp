# Kritische projectbeoordeling en verbeterplan

Datum: 13 juli 2026  
Scope: app, hoofddoel, aannames, architectuur, code, cybersecurity, functies, tests en deployment.

## Samenvattend oordeel

De app is geschikt als lokale, experimentele portefeuilleviewer voor één gebruiker, mits de gebruiker begrijpt dat browseropslag geen kluis is en historische modellen geen adviesmotor zijn. De oorspronkelijke versie had bruikbare visualisaties, maar liet gereconstrueerde data doorstromen naar statistiek en ML, behandelde cashflows als rendement, maakte impliciete netwerkcalls en had geen regressietests of CI. Daardoor waren vooral de financiële uitkomsten overtuigender gepresenteerd dan de datakwaliteit toeliet.

Versie 12 herstelt de belangrijkste betrouwbaarheidsgrenzen: data heeft nu herkomst, financiële analyses blokkeren op onvoldoende echte dekking, cashflows zijn neutraal in rendement, externe calls zijn opt-in en import/restore is gevalideerd en herstelbaar. De app blijft bewust een statische browserapp; dat is tegelijk haar sterkste privacy-eigenschap en haar voornaamste operationele beperking.

## Hoofddoel en expliciete aannames

Het hoofddoel is inzicht geven in een zelf geïmporteerde portefeuille zonder een centrale applicatieserver. De implementatie gaat uit van:

1. één vertrouwde gebruiker per browserprofiel en website-origin;
2. transacties en koersen in EUR, of een aantoonbare omrekening naar EUR;
3. kalenderdagreeksen van 1.095 dagen, inclusief forward-fill op niet-handelsdagen;
4. begin-van-de-dagcashflows voor de berekening van dagrendement;
5. historische analyse als educatief hulpmiddel, niet als voorspellingsgarantie;
6. een DCA-plan als lokale boeking, niet als brokerintegratie.

Als één van deze aannames niet klopt, moet de gebruiker de uitkomst als onvolledig beschouwen.

## Architectuurbeoordeling

De scheiding in data, import, kwantitatieve analyse, ML, backtest, DCA, alerts, charts en UI is logisch en herkenbaar. De gedeelde globale runtime maakt een dependencyvrije statische deployment mogelijk. Nadelen zijn impliciete afhankelijkheden, lastiger geïsoleerd testen en het risico dat laadvolgorde onderdeel van de architectuur wordt.

De kerngegevensstroom is nu:

```text
bestand / expliciete koerscall
            |
       validatie + normalisatie
            |
     asset + prijzen + provenance
            |
   atomaire localStorage-opslag
            |
 portefeuille + cashflowcorrectie
            |
 kwaliteitsgate (minimaal 90% echt)
            |
 ML / backtest / risico / DCA-simulatie
```

Een toekomstige grotere versie hoort klassieke globals te vervangen door ES-modules en een kleine repositorylaag voor opslag en migraties. Voor de huidige schaal is die verbouwing P2: nuttig, niet nodig om de aangetroffen kritieke fouten te sluiten.

## Bevindingen en uitvoering

| Prioriteit | Bevinding | Uitgevoerde maatregel | Status |
|---|---|---|---|
| P0 | Identieke JSON-herimport kon lege assetdefinities bewaren, waardoor reload assets verloor | Elke import bouwt en bewaart volledige assetdefinities; regressietest herimporteert en simuleert reload | Afgerond |
| P0 | Stortingen/opnames vervormden dag-P&L, volatiliteit, Sharpe, drawdown en Monte Carlo | Centrale cashflowreeks en begin-van-de-dagcorrectie; analyses gebruiken gecorrigeerde rendementen | Afgerond |
| P0 | Gereconstrueerde Brownian-bridge-data voedde ML, backtests en advies en kon toekomstige ankers bevatten | Boolean provenance per dag; analyse-gates op 90% echte dekking; reconstructie alleen nog als zichtbare grafiek | Afgerond |
| P0 | Backup was niet volledig herstelbaar | Schema 2 omvat transacties, assets, prijzen, provenance, watchlist, alerts, DCA, watch-assets en bronmappings | Afgerond |
| P0 | Import kon gedeeltelijk opgeslagen toestand achterlaten | Meervoudige localStorage-mutaties hebben verificatie en rollback | Afgerond binnen localStorage-beperkingen |
| P0 | Geïmporteerde/externe tekst kon via `innerHTML` uitvoerbaar worden | Normalisatie, HTML-escaping op dynamische hotspots, strikte kleuren/id's, CSP en gevalideerde opgeslagen regels | Afgerond voor bekende invoerpaden |
| P0 | Privacytekst ontkende externe verzoeken; fonts en koersen gingen automatisch naar derden | Externe fonts verwijderd; koersnetwerk standaard uit; expliciete toestemming en eerlijke UI/README | Afgerond |
| P1 | Publieke CORS-proxy's zagen tickers en vormden een supply-chain/availability-risico | Proxy's verwijderd; directe Yahoo-call faalt gesloten bij CORS | Afgerond |
| P1 | Vreemde valuta kon bij FX-fout als EUR worden gelabeld | Asset wordt niet geregistreerd zonder geldige EUR-conversiereeks | Afgerond |
| P1 | Model-arena normaliseerde op alle data en testte één holdout | Vier expanding-window folds; elke fold bepaalt scaler en modellen uitsluitend uit training | Afgerond |
| P1 | “Zekerheid” en “80%-betrouwbaarheidsinterval” waren niet gekalibreerd | UI noemt signaalsterkte en indicatieve residuband | Afgerond |
| P1 | 365-daags grid werd met 252 geannualiseerd en 504 kalenderdagen heette twee jaar | Centrale factor 365; backtest/covariantie gebruiken 730 kalenderdagen | Afgerond |
| P1 | CSV-dedupe liet legitieme orders met gelijk aantal/dag verdwijnen | Broker-id primair; fallback bevat richting, aantal, prijs en transfertype | Afgerond |
| P1 | Watch-only assets verdwenen door verkeerde laadvolgorde | Assetdefinities laden vóór de watchlist | Afgerond |
| P1 | DCA kon toekomstige data gebruiken en fictieve koersen boeken | Historisch venster eindigt exact op uitvoerdag; openstaande termijn wacht op echte koers | Afgerond |
| P1 | Modals misten Escape, focuslus en dialoogsemantiek | ARIA, Escape, focus trap, focusherstel en live toast toegevoegd | Afgerond voor de twee modals |
| P1 | Geen tests of CI | Node-testset, publieke-buildvalidator en minimale GitHub Actions-workflow | Afgerond |
| P2 | Service worker cachete ook foutresponses | Alleen succesvolle same-origin-responses worden gecachet; expliciete offline 503 | Afgerond |

## Cybersecurity en privacy

Positief zijn de nul-backendarchitectuur, CSP, opt-in netwerkgrens, afwezigheid van runtime-dependencies, gesloten valutafouten, maximale importgroottes en gevalideerde opslagobjecten. De publieke-buildvalidator controleert dat bekende privépaden niet onder versiebeheer staan.

Resterende risico's:

- `localStorage` is niet versleuteld, origin-breed en leesbaar voor iedere succesvolle same-origin scriptinjectie. CSP verkleint dit risico, maar is geen encryptie.
- Een meta-CSP kan geen betrouwbare `frame-ancestors`-header zetten. Productiehosting hoort CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` en `Permissions-Policy` als HTTP-headers toe te voegen.
- De app heeft geen authenticatie, autorisatie, auditlog of veilige synchronisatie. Maak haar niet multi-user zonder backend- en threat-modelherontwerp.
- Externe koersdiensten kunnen uitvallen, CORS wijzigen of een verkeerd symbool teruggeven. Valuta wordt gevalideerd, maar tickeridentiteit zonder ISIN/beurs blijft ambigu.
- Een lokaal backupbestand is platte financiële JSON. Beveiliging daarvan ligt bij bestandssysteem, gebruiker en eventuele schijfversleuteling.
- Eerder verwijderde gevoelige Git-objecten kunnen nog in lokale reflogs of onbereikbare objecten bestaan. Geschiedenis opschonen is destructief en valt buiten automatische uitvoering; doe dit alleen na backup en expliciete keuze, en roteer een remote indien die objecten ooit zijn gepusht.

## Functionele evaluatie

De kernworkflow — importeren, holdings berekenen, bekijken, aanvullen en backuppen — is nu coherent. De app communiceert wanneer een dagcijfer of analyse ontbreekt in plaats van een synthetisch getal als feit te tonen. Transfers en DCA zijn explicieter, en watchlistvoorkeuren overleven herstel.

Niet opgelost of bewust beperkt:

- corporate actions, splits, dividenden, belastingen en brokerfees hebben geen volwaardig domeinmodel;
- money-weighted return/IRR ontbreekt als formele metriek;
- ticker naar beurs/ISIN-resolutie blijft heuristisch wanneer metadata ontbreekt;
- DCA voert geen brokerorder uit;
- candlestick open/hoog/laag wordt afgeleid uit slotkoersen en is duidelijk als indicatief gelabeld;
- een browserquota- of storagepolicyfout kan opslag alsnog verhinderen, hoewel gedeeltelijke writes worden teruggedraaid.

## Tests en deployment

De regressiesuite controleert de cashflowcorrectie, herimport/reload, rollback, CSV-dedupe, standaard-uitgeschakeld netwerk, backuprestore, DCA zonder look-ahead, walk-forward-arena, syntaxis en statische security-/cache-eisen. `scripts/validate-public-build.mjs` controleert daarnaast privépaden, lokale assetreferenties en cacheversies.

De GitHub Actions-job is aanwezig, maar branch protection is een externe repository-instelling en moet handmatig worden geactiveerd. Ook productie-securityheaders zijn een hostingverantwoordelijkheid; GitHub Pages biedt daar beperkte controle over.

## Vervolgplan

1. **P1 — domeinmodel uitbreiden:** fees, belastingen, dividenden, transfers met expliciete externe kostbasis, splits en corporate actions.
2. **P1 — instrumentidentiteit:** ISIN + beurs + quotevaluta als primaire sleutel; ticker alleen als label/zoekterm.
3. **P1 — browser-end-to-endtests:** import, backuprestore, modaltoetsenbord, service-workerupdate en een volledige lege-stateflow in Playwright.
4. **P2 — opslagmigratie:** IndexedDB-repository met schema-migraties, checksums en optionele versleutelde backup met een gebruikerswachtwoord.
5. **P2 — modulegrenzen:** ES-modules, expliciete imports en afzonderlijke adapters voor opslag en koersproviders.
6. **P2 — deploymenthardening:** eigen hosting met securityheaders, branch protection, verplichte CI en periodieke dependency-/browsercompatibiliteitscontrole.

De eerstvolgende inhoudelijke investering hoort instrumentidentiteit en corporate actions te zijn. Zonder die domeinlaag levert verdere verfijning van ML meer schijnprecisie dan betrouwbaarheid op.
