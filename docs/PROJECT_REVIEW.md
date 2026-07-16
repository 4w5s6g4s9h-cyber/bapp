# Kritische projectbeoordeling en verbeterplan

Datum: 16 juli 2026
Scope: app, hoofddoel, aannames, architectuur, code, cybersecurity, functies, tests en deployment.

## Samenvattend oordeel

De app is geschikt als lokale, experimentele portefeuilleviewer voor één gebruiker, mits de gebruiker begrijpt dat browseropslag geen kluis is en historische modellen geen adviesmotor zijn. De oorspronkelijke versie had bruikbare visualisaties, maar liet gereconstrueerde data doorstromen naar statistiek en ML, behandelde cashflows als rendement, maakte impliciete netwerkcalls en had geen regressietests of CI. Daardoor waren vooral de financiële uitkomsten overtuigender gepresenteerd dan de datakwaliteit toeliet.

Versie 16 herstelde daarnaast de belangrijkste boekhoudkundige grens. Trades zijn niet langer automatisch gelijk aan externe inleg: een schema-v4-ledger verwerkt effecten en cash gezamenlijk, met fees, belasting, dividend, rente, splits en transfers. Gemiddelde kostbasis, gerealiseerd resultaat, TWR, XIRR en brokerreconciliatie komen nu uit dezelfde gebeurtenisstroom. Oude schema-v3-trades migreren waarderingsneutraal en versie-2-backups blijven herstelbaar.

Versie 17 sluit vervolgens een kritieke tijdsdimensiefout: marktdata wordt met een expliciete begindatum opgeslagen en bij een nieuwe kalenderdag op datum geprojecteerd, in plaats van de oude positionele reeks stilzwijgend als “eindigend vandaag” te herinterpreteren. Iedere waarde heeft nu de status waargenomen, doorgetrokken of gereconstrueerd. Dagresultaat, koersalerts en DCA-uitvoering vereisen een waargenomen koers; historische analyses mogen waargenomen en transparant doorgetrokken kalenderdagen gebruiken, maar nooit reconstructies. Oude ongedateerde marktdata migreert fail-closed en blijft als lokale rollbackkopie bewaard. De app blijft bewust een statische browserapp; dat is tegelijk haar sterkste privacy-eigenschap en haar voornaamste operationele beperking.

Versie 18 maakt ook de actualiteit van die marktdata afdwingbaar. Een doorgetrokken koers is maximaal één kalenderdag betrouwbaar voor crypto en vier voor aandelen/ETF’s; daarna blijft de waarde zichtbaar, maar wordt zij gereconstrueerd/verouderd en zijn actuele rendementen, analyses en wegingalerts geblokkeerd. Dashboard, posities, watchlist, assetdetail en instellingen tonen de laatste waargenomen bronkoersdatum. Toekomstige boekingen worden bij invoer en import geweigerd en reeds aanwezige toekomstige gebeurtenissen worden niet langer op vandaag geklemd. Afgeleide TWR-state wordt bij iedere relevante mutatie ongeldig gemaakt.

## Hoofddoel en expliciete aannames

Het hoofddoel is inzicht geven in een zelf geïmporteerde portefeuille zonder een centrale applicatieserver. De implementatie gaat uit van:

1. één vertrouwde gebruiker per browserprofiel en website-origin;
2. één EUR-cashrekening; transacties in andere valuta bevatten een expliciete wisselkoers naar EUR en marktkoersreeksen zijn al in EUR;
3. kalenderdagreeksen van 1.095 dagen, waarbij niet-handelsdagen expliciet als doorgetrokken en niet als waargenomen zijn gemarkeerd;
4. begin-van-de-dagcashflows voor de berekening van dagrendement;
5. historische analyse als educatief hulpmiddel, niet als voorspellingsgarantie;
6. een DCA-plan als lokale boeking, niet als brokerintegratie.

Als één van deze aannames niet klopt, moet de gebruiker de uitkomst als onvolledig beschouwen.

## Architectuurbeoordeling

De scheiding in data, import, kwantitatieve analyse, ML, backtest, DCA, alerts, charts en UI is logisch en herkenbaar. De gedeelde globale runtime maakt een dependencyvrije statische deployment mogelijk. Nadelen zijn impliciete afhankelijkheden, lastiger geïsoleerd testen en het risico dat laadvolgorde onderdeel van de architectuur wordt.

De kerngegevensstroom is nu:

```text
bestand / expliciete of opt-in geplande koerscall
            |
       validatie + normalisatie
            |
 asset + gedateerde marktserie + kwaliteit
            |
   schema-v4-events + cashledger
            |
 kostbasis + externe flows + reconciliatie
            |
   atomaire localStorage-opslag
            |
 portefeuille + TWR / XIRR
            |
 kwaliteitsgate (minimaal 90% bron-gedekt)
            |
 ML / backtest / risico / DCA-simulatie
```

Een toekomstige grotere versie hoort klassieke globals te vervangen door ES-modules en een kleine repositorylaag voor opslag en migraties. Voor de huidige schaal is die verbouwing P2: nuttig, niet nodig om de aangetroffen kritieke fouten te sluiten.

## Bevindingen en uitvoering

| Prioriteit | Bevinding | Uitgevoerde maatregel | Status |
|---|---|---|---|
| P0 | Identieke JSON-herimport kon lege assetdefinities bewaren, waardoor reload assets verloor | Elke import bouwt en bewaart volledige assetdefinities; regressietest herimporteert en simuleert reload | Afgerond |
| P0 | Trades en externe inleg waren hetzelfde, waardoor verkopen/herbalanceren rendement en cash verkeerd beïnvloedden | Eén eventledger met afzonderlijke effecten, cash en externe flows; interne trades zijn resultaatneutraal voor inleg | Afgerond |
| P0 | Gereconstrueerde Brownian-bridge-data voedde ML, backtests en advies en kon toekomstige ankers bevatten | Driewaardige koerskwaliteit per dag; analyse-gates op 90% bron-gedekte waarden; reconstructie alleen nog als zichtbare grafiek | Afgerond |
| P0 | Positionele koersarrays werden bij een latere appstart opnieuw aan “vandaag” gekoppeld en verschoven daardoor ongemerkt in de tijd | Marktseries hebben een expliciete begindatum; runtimegrid en opgeslagen/live historie worden op kalenderdatum geprojecteerd; legacyreeksen migreren fail-closed | Afgerond in versie 17 |
| P0 | Backup was niet volledig herstelbaar en bewaarde marktdata niet datumvast | Backup-schema 4 omvat ledger, reconciliatie en gedateerde marktseries met kwaliteit; schema 2/3 migreert waarderingsneutraal en met onbetrouwbare legacykoersen uitgesloten van analyse | Afgerond |
| P0 | Import kon gedeeltelijk opgeslagen toestand achterlaten | Meervoudige localStorage-mutaties hebben verificatie en rollback | Afgerond binnen localStorage-beperkingen |
| P0 | Geïmporteerde/externe tekst kon via `innerHTML` uitvoerbaar worden | Normalisatie, HTML-escaping op dynamische hotspots, strikte kleuren/id's, CSP en gevalideerde opgeslagen regels | Afgerond voor bekende invoerpaden |
| P0 | Privacytekst ontkende externe verzoeken; fonts en koersen gingen automatisch naar derden | Externe fonts verwijderd; koersnetwerk standaard uit; expliciete toestemming en eerlijke UI/README | Afgerond |
| P1 | Publieke CORS-proxy's zagen tickers en vormden een supply-chain/availability-risico | Proxy's verwijderd; directe Yahoo-call faalt gesloten bij CORS | Afgerond |
| P1 | Vreemde valuta kon bij FX-fout als EUR worden gelabeld | Asset wordt niet geregistreerd zonder geldige EUR-conversiereeks | Afgerond |
| P1 | Model-arena normaliseerde op alle data en testte één holdout | Vier expanding-window folds; elke fold bepaalt scaler en modellen uitsluitend uit training | Afgerond |
| P1 | “Zekerheid” en “80%-betrouwbaarheidsinterval” waren niet gekalibreerd | UI noemt signaalsterkte en indicatieve residuband | Afgerond |
| P1 | 365-daags grid werd met 252 geannualiseerd en 504 kalenderdagen heette twee jaar | Centrale factor 365; backtest/covariantie gebruiken 730 kalenderdagen | Afgerond |
| P1 | CSV-dedupe liet legitieme orders met gelijk aantal/dag verdwijnen | Broker-id primair; fallback bevat richting, aantal, prijs en transfertype | Afgerond |
| P1 | Fees, belasting, dividend, rente, splits en transfers ontbraken als volwaardige gebeurtenissen | Schema-v4-normalisatie, cashimpact, gemiddelde kostbasis, gerealiseerd resultaat en expliciete transferwaarde | Afgerond voor ondersteunde events |
| P1 | Meer verkopen/transfereren dan aanwezig werd stil naar nul geklemd | Ongeldige events worden fail-closed genegeerd, zichtbaar gemeld en door het handmatige formulier vooraf geblokkeerd | Afgerond |
| P1 | Formeel geldgewogen rendement ontbrak | XNPV/XIRR met exacte datums, 365-dagenconventie, hybride rootfinding en referentietests | Afgerond |
| P1 | Geen controle of de lokale ledger nog met de broker aansloot | Lokale brokerstand per asset en cash, toleranties, verschilrapport en opname in backup-schema 4 | Afgerond |
| P1 | Brokerimports verloren fees en maakten van assettransfers gewone trades | DEGIRO-fees/belasting, Bitvavo-cashfunding, assettransfers en stakingrewards worden afzonderlijk geboekt | Afgerond voor ondersteunde kolommen |
| P1 | Watch-only assets verdwenen door verkeerde laadvolgorde | Assetdefinities laden vóór de watchlist | Afgerond |
| P1 | Toegevoegde assets hadden geen betrouwbare vervolgverversing; dynamische CoinGecko-ID’s gingen bij reload verloren | CoinGecko-ID persistent; single-flight uurcontrole bij open/focus/online; aandelen providerbewust dagelijks in begrensde batches; bron- en ophaaltijd zichtbaar; observaties datumvast opgeslagen | Afgerond binnen browserbeperkingen |
| P1 | DCA kon toekomstige data gebruiken en fictieve koersen boeken | Historisch venster eindigt exact op uitvoerdag; openstaande termijn wacht vanaf de vervaldatum op de eerste waargenomen koers | Afgerond |
| P1 | Stilstaande koersdata werd zonder peildatum als actuele portefeuillewaarde gepresenteerd | Laatste bronkoersdatum per positie zichtbaar; carried-venster begrensd op 1/4 dagen; actuele rendementen en analyses sluiten daarna fail-closed | Afgerond in versie 18 |
| P1 | Assetdetail toonde een dagrendement zonder dezelfde kwaliteitsgate als het dashboard | Dagresultaat vereist in beide schermen twee opeenvolgende waargenomen koersen | Afgerond in versie 17 |
| P1 | Verwijderen of wijzigen van transacties kon gecachte TWR-resultaten laten staan | Centrale invalidatie wist portefeuille, TWR, frontier en backteststate | Afgerond in versie 18 |
| P1 | Modals misten Escape, focuslus en dialoogsemantiek | ARIA, Escape, focus trap, focusherstel en live toast toegevoegd | Afgerond voor de twee modals |
| P1 | Geen tests of CI | Node-testset, publieke-buildvalidator en minimale GitHub Actions-workflow | Afgerond |
| P2 | Service worker cachete ook foutresponses | Alleen succesvolle same-origin-responses worden gecachet; expliciete offline 503 | Afgerond |
| P2 | Toekomstige transacties werden door indexclamping stil op vandaag verwerkt | Formulier en imports weigeren toekomstige datums; bestaande rijen worden overgeslagen met een zichtbaar ledgerprobleem | Afgerond in versie 18 |

## Cybersecurity en privacy

Positief zijn de nul-backendarchitectuur, CSP, opt-in netwerkgrens, afwezigheid van runtime-dependencies, gesloten valutafouten, maximale importgroottes en gevalideerde opslagobjecten. De publieke-buildvalidator controleert dat bekende privépaden niet onder versiebeheer staan.

Resterende risico's:

- `localStorage` is niet versleuteld, origin-breed en leesbaar voor iedere succesvolle same-origin scriptinjectie. CSP verkleint dit risico, maar is geen encryptie.
- Een meta-CSP kan geen betrouwbare `frame-ancestors`-header zetten. Productiehosting hoort CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` en `Permissions-Policy` als HTTP-headers toe te voegen.
- De app heeft geen authenticatie, autorisatie, auditlog of veilige synchronisatie. Maak haar niet multi-user zonder backend- en threat-modelherontwerp.
- Externe koersdiensten kunnen uitvallen, CORS wijzigen of een verkeerd symbool teruggeven. Valuta wordt gevalideerd, maar tickeridentiteit zonder ISIN/beurs blijft ambigu.
- De ledger heeft één EUR-cashrekening, geen afzonderlijke valutarekeningen. Een verkeerde handmatige FX-rate blijft een invoerfout die reconciliatie alleen indirect kan blootleggen.
- Een open browsertab is geen scheduler: timers kunnen worden vertraagd of gepauzeerd en stoppen volledig wanneer de app gesloten is. Gegarandeerde achtergrondverversing vereist een backend of worker.
- Gratis Alpha Vantage-data is eindedagdata en heeft een laag dagelijks verzoekbudget; de app noemt aandelenkoersen daarom niet realtime en ververst ze automatisch hooguit dagelijks.
- Een lokaal backupbestand is platte financiële JSON. Beveiliging daarvan ligt bij bestandssysteem, gebruiker en eventuele schijfversleuteling.
- Eerder verwijderde gevoelige Git-objecten kunnen nog in lokale reflogs of onbereikbare objecten bestaan. Geschiedenis opschonen is destructief en valt buiten automatische uitvoering; doe dit alleen na backup en expliciete keuze, en roteer een remote indien die objecten ooit zijn gepusht.

## Functionele evaluatie

De kernworkflow — importeren, ledger opbouwen, waarderen, reconciliëren en backuppen — is nu coherent. Het dashboard telt cash mee, toont XIRR naast TWR wanneer de datakwaliteit dat toelaat en maakt fees, inkomsten en gerealiseerd resultaat zichtbaar. Interne herbalancering verandert de externe inleg niet. Een onmogelijke verkoop, transfer of split verdwijnt niet stil in de berekening maar wordt geweigerd of gemeld.

Niet opgelost of bewust beperkt:

- complexere corporate actions zoals fusies, spin-offs, symboolwijzigingen en return-of-capital ontbreken;
- kostbasis gebruikt één gewogen gemiddelde; FIFO/LIFO, lots en fiscale jaarrapportage ontbreken;
- multi-currency cashrekeningen en historische FX-reeksen ontbreken;
- ticker naar beurs/ISIN-resolutie blijft heuristisch wanneer metadata ontbreekt;
- DCA voert geen brokerorder uit;
- candlestick open/hoog/laag wordt afgeleid uit slotkoersen en is duidelijk als indicatief gelabeld;
- een browserquota- of storagepolicyfout kan opslag alsnog verhinderen, hoewel gedeeltelijke writes worden teruggedraaid.

## Tests en deployment

De regressiesuite controleert nu ook v3→v4-transactiemigratie, interne herbalancering, fees/dividend/kostbasis, realized P&L, splits, transfers, oversell-beveiliging, reconciliatie, XIRR en schema-2/3/4-backupherstel. Datumregressies starten dezelfde marktdata op een latere systeemdatum, controleren dat de bronobservatie op haar oorspronkelijke kalenderdag blijft staan, bewaken het 1/4-daagse actualiteitsvenster en toetsen kalenderdagverschillen over zomer- en wintertijd. Toekomstige transacties worden zowel bij import als in de ledger fail-closed getest. Brokerfixtures bewijzen DEGIRO-fees, Bitvavo-cashfunding, assettransfers, stakingrewards en dedupe. Daarnaast blijven netwerkgrenzen, DCA zonder look-ahead, walk-forward-arena, syntaxis en statische security-/cache-eisen gedekt. Een lokale headless-Chrome-smokecheck doorliep storting, interne koop, reconciliatie en oversell-blokkade zonder runtime-exception; dit is nog geen geautomatiseerde cross-browser-CI.

De GitHub Actions-job is aanwezig, maar branch protection is een externe repository-instelling en moet handmatig worden geactiveerd. Ook productie-securityheaders zijn een hostingverantwoordelijkheid; GitHub Pages biedt daar beperkte controle over.

## Vervolgplan

1. **P1 — importpreview en brokerintegriteit:** expliciet tonen en laten bevestigen wat wordt herkend, overgeslagen, omgerekend of geschat; transfers zonder betrouwbare waarneming blokkeren.
2. **P1 — kwantitatieve sampling:** correlaties op gezamenlijke waargenomen handelsdagen, consistente cashweging en expliciete samplingwaarschuwingen bij signalen/frontier.
3. **P1 — geautomatiseerde browser-end-to-endtests:** import, schema-2/3/4-backuprestore, modaltoetsenbord, service-workerupdate en een volledige lege-stateflow in Chromium, Firefox en WebKit.
4. **P1 — instrumentidentiteit:** ISIN + beurs + quotevaluta als primaire sleutel; ticker alleen als label/zoekterm.
5. **P1 — fiscale lots en corporate actions:** optionele FIFO/lots, return-of-capital, fusies, spin-offs en symboolmigraties zonder historische breuk.
6. **P2 — multi-currency ledger:** afzonderlijke cashrekeningen en gevalideerde historische FX-bronnen in plaats van één handmatige rate per event.
7. **P2 — opslagmigratie en modulegrenzen:** IndexedDB met migraties/checksums, optionele versleutelde backup, ES-modules en expliciete provideradapters.
8. **P2 — deploymenthardening:** eigen hosting met securityheaders, branch protection, verplichte CI en periodieke browsercompatibiliteitscontrole.

De eerstvolgende investering hoort nu importintegriteit en kwantitatieve sampling te zijn. Daarna leveren browser-E2E en sterkere instrumentidentiteit meer betrouwbaarheid op dan verdere verfijning van ML.
