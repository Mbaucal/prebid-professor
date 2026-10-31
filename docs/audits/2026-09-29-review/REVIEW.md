# Tessera — provera nezavisnog pregleda, 29.09.2026.

Pregled je koristan i otkriva stvarne nedostatke. Njegove najvažnije runtime nalaze treba rešavati, ali nekoliko zaključaka i predloženih popravki treba korigovati. Veliki refaktor nije preduslov za popravku isporuke oglasa.

Izvor: [nezavisni pregled](https://linear.app/mbaucal/document/tessera-nezavisni-pregled-proizvoda-i-koda-29092026-4f2e5f75f550). Proverena osnova: `main` **3d56708a5669a27c9c34b00ad36728468a0d64fd**. U trenutku preuzimanja to je i dalje aktuelni main. TEST osnova: **f3eb3fb6fe67e631aba2780743647d0416dd77a9**.

## Šta je nezavisno provereno

- Izvorni kod, compiler izmene i stvarno generisani Tanjug izlaz; ne samo stari 3.9.1 template.
- `npm ci --ignore-scripts`, priprema izvora, produkcioni build i TypeScript: **63 dijagnostike** pre i posle ove popravke. Nije dodat novi type error.
- Izvršavanje izdvojenih funkcija iz generisanog izlaza uz simulirani sat, CMP, GPT i requestBids. Reprodukcija: `observe-runtime.mjs` u ovom direktorijumu, nakon `node scripts/prepare-test-workspace.mjs`.
- S1/S3 reprodukcije i nova popravka: **48 ciljanih Node testova**, plus kompajlirani produkcioni Worker u workerd/Miniflare sa lokalnim R2. Provereni stvarni HTTP odgovori i odbijanje `Origin: null` mutacije sa validnom sesijom.
- Zvanična dokumentacija Prebid-a, Google-a, Cloudflare-a i Better Ads Standards za sporne preporuke.

Nije ponovljen autorov puni Chromium harness sa pravim Prebid-om, jer nije priložen. Nisu ispitani live publisher sajtovi, prihodi, stvarni GAM request parametri, produkcioni D1/R2 ili cela git istorija. Broj 955 testova i tvrdnja da istorija nema tajni pripadaju originalnom pregledu; nisu nova nezavisna potvrda ovog rada.

## Runtime i oglasna isporuka

| Nalaz | Ocena | Odluka |
| --- | --- | --- |
| **R1 — CMP / pre-auction / failsafe** | **Potvrđen problem, delimično netačno obrazloženje.** `getTCF` prekida na 1.200 ms, uklanja listener i može da izgubi kasniju odluku. Grupni failsafe počinje pre završetka pre-auction čekanja. Međutim, spoljašnji `resolveConsent` je već izmenjen kroz `worker/runtime/consent-timer.mjs`; u generisanom Tanjug izlazu nije uvek limitiran na 1.500 ms. | Najvažniji naredni runtime posao, **MBA-171**. Nova verzija sa jasno razdvojenim čekanjem na CMP, odluku korisnika, spremnost Prebid-a i samu aukciju. |
| **R1 — „NPA posle 1.200 ms ako je CMP mrtav”** | **Ne prihvatiti kao opšte rešenje.** Bez odgovora 1.200 ms ne znači da je CMP mrtav. Nepoznat `gdprApplies` nije isto što i `false`. NPA nije zamena za potrebnu saglasnost za storage. | Emergency režim definisati kroz dozvoljeni način isporuke i CMP signale; ne uvoditi query-parametar koji zaobilazi consent. Naknadnu odluku pratiti za sledeće requeste. |
| **R2 — nedostaje Prebid fajl** | **Potvrđeno za ATF putanju sa uključenim Prebid-om i bidderima.** `startATF` smešta rad i failsafe u `pbjs.que`; ako se fajl ne izvrši, ništa ne pokreće taj failsafe. GAM-only putanja ima direktan GPT refresh. | Eksterni readiness watchdog posle odgovarajuće privacy odluke, tačno jedan initial request po slotu, bez dupliranja kada Prebid stigne kasno. Raditi zajedno sa R1. |
| **R3 — TakeOver** | **Rizik formata je opravdan; automatska zamena nije tehnička obaveza.** Zatvaranje odmah/ESC i informativni countdown ne dokazuju prihvatljivost celog overlay iskustva. Nije tačno da GPT interstitial postoji samo pri internoj navigaciji: postoje i drugi trigger-i. Oni ipak ne garantuju trenutno prikazivanje na ulasku niti svaki podoban prikaz. | Sačuvati izričiti zahtev za direktnu landing kampanju; zasebno dizajnirati Custom TakeOver i GPT interstitial. Proveriti konkretan UX, uređaj, trigger, cap, kupca i format. Ne gasiti postojeći format naslepo. |
| **R4 — refresh** | **Glavni mehanizmi postoje.** Vidljivost, dwell, skriven tab i cap nisu dokaz da su sve konfiguracije ispravne. Ako UI dopušta niži interval, konfiguracija i runtime nisu jedinstven ugovor. | Jedan validacioni model i testovi stvarnog minimalnog razmaka. Google minimum za time-based refresh ne nestaje zato što se koristi cached bid. Ne vraćati otkazani Sticky BTF posao (MBA-102). |
| **R5 — cache** | **Browser `no-store` je stvaran trošak.** Zaključak da Cloudflare Pages zato nema edge cache i svaki put dovlači sirovih ~420 KB sa origina nije dokazan: Pages ima sopstveno Tiered Cache posluživanje i kompresiju. | Izmeriti stvarne headere/transfer; verzionisati međusobno kompatibilne JS fajlove, kratko revalidirati entrypoint, testirati 304 i rollback. Ne menjati cache politiku mimo manifest/verification pravila. |
| **R6 — frozen izvori / build** | **Dug postoji; nisu svi simptomi bug.** Timestamp je deo ulaza pa različit timestamp legitimno menja hash. Jednaka verziona oznaka za različite source hash-eve zbunjuje. `compress:false,mangle:false` ne znači da nema nikakve minifikacije. | Jedinstvene buduće oznake, pouzdana istorija i migracioni put. Ne uklanjati `package-lock.json` iz postojećih frozen potpisa niti prepisivati stare ZIP-ove da bi upgrade lakše prošao. Za novu verziju preciznije definisati build zavisnosti. |

Izvršena funkcijska reprodukcija daje:

| Scenario | Posmatrani rezultat |
| --- | --- |
| `cmpuishown`, dozvoljeno spoljašnje čekanje 8 s, odluka na 5 s | Resolver završava na **1.200 ms**, `fallback:noCMP`; listener je već uklonjen. |
| Prebid uključen, fajl nikada ne izvrši queue | Posle simuliranih 30 s: **1 callback u redu, 0 timer-a, 0 refresh-a**. |
| Grupni timeout 2.500 ms, simulirani pre-auction wait i bidsBack na 5.700 ms | **Refresh na 3.000 ms**, pa kasni callback na 5.700 ms bez drugog initial refresh-a. |

To potvrđuje kontrolni tok. Ne meri procenat pogođenih poseta, stvarni `npa` na Google mrežnom zahtevu ili izgubljeni prihod. Takve brojke zahtevaju stvarni CMP/Prebid/GPT i kontrolisano merenje.

## Ostali runtime nalazi R7

| Tema | Ocena i sledeći korak |
| --- | --- |
| Globalni `pubads().refresh` patch | **Potvrđen rizik kompatibilnosti.** Presreće i tuđe slotove; treba ograničiti na Tesserine slotove i očuvati semantiku tuđih poziva, uključujući `refresh()` bez liste. Nova runtime verzija i mixed-owner regresije. Nije dokazano da je već pokvario Tanjug. |
| Isti SSP placement na više pozicija | **Konfiguracija je vidljiva, greška nije dokazana.** Zavisi od ugovora i adaptera. GPID i placement ID nisu sinonimi. Proveriti sa partnerima pre deljenja inventara na nove ID-eve. |
| Currency fallback | Nema `defaultRates`; proveriti ponašanje korišćene Prebid verzije pri grešci kursnog servisa. Rezervni kurs mora imati datum i definisanu starost. Ne zalepiti trajno zastarele brojeve. |
| `storageControl.enforcement` | Tvrdnja o ignorisanoj opciji zahteva proveru baš izabranog Prebid build-a; uklanjanje mrtve opcije nema potvrđeni prihodovni dobitak. Niži prioritet od R1/R2. |
| ID5 → PPID | Direktno čitanje localStorage bez lokalnog consent guard-a jeste prisutno. Proveriti efektivni trenutak poziva, dozvoljene signale i pravila partnera. Obuhvatiti postojeći EID/ID5 posao MBA-108; ne kopirati EID/PPID kao ekvivalentne identifikatore. |
| Različite klasifikacije uređaja | Tehnički dug. Viewport, kategorija uređaja i raspoloživa širina oglasa ne moraju biti isti pojam. Definisati njihovu svrhu pre ujednačavanja. |
| GPP/USP blokira bid cache | Konzervativni guard je prisutan. Tvrdnja da Tanjug B grana stvarno ne koristi cache ostaje **neproverena** bez live CMP-a i dijagnostike. Ne uklanjati guard radi boljeg A/B broja; dodati podržane privacy signale i razlog za fallback. MBA-58/59/113. |
| A/B samo Tanjug, client-side vs edge | Pilot ograničenje je stvarno; edge grana nije isto što i aktivni main. Produkt mora jasno pokazati podržani scope. Generalizovati nakon pouzdane prve isporuke, uz postojeći MBA-57. |
| **40.000 kreativa „po ceni”** | **Netačno.** Preset ima 2.000 cena × 20 kopija = **40.000 ukupno**, 20 po ceni. Deljeni skup je optimizacija, ne hitna korekcija pogrešne aukcije; zadržati potreban broj kopija za više slotova na stranici. |
| GAM veličine i PUC `@latest` | Fiksni default spisak može odstupati od sajta. To nije dokaz da su svi GAM izveštaji o veličini pogrešni. Predlog: prefill iz size mapa uz pregled, pinovana testirana PUC verzija i kontrolisan upgrade. SMN ime/email su promenljivi preset default-i, a ne dokaz pogrešne autentifikacije. Backoff/kvote zasebno proveriti. |
| Mobilni prag 40 → 50 | Razlika između originala i compiler patch-a potvrđuje potrebu da UI prikazuje efektivno ponašanje. Proveravati generisani izlaz, ne samo komentare. |
| **Ukloniti HTML iz kompaktnog deploy-a** | **Već urađeno na ovom main-u.** `scripts/pages-release-verification.mjs` za kompaktni built-in profil dozvoljava samo `ads.js`/`prebid.js`. Legacy puni paket i admin-origin CDN HTML su druga pitanja. |

## Bezbednost

| Nalaz | Ocena / odluka |
| --- | --- |
| **S1 — HTML na admin originu** | **Potvrđeno; prva popravka MBA-172.** Built-in i legacy CDN nemaju sandbox. Dodatno pronađena ista praznina na autentifikovanom `builtin-releases/.../files/implementation.html`. Nije dokazano da svaka GAM kreativa može da dohvati parent origin; dovoljan razlog za izolaciju je već samo izvršavanje publisher/uploadovanog koda na tom originu. |
| **S2 — login rate limit** | U aplikacionom login handleru nema limitera. Dodati server-side limit uz proverenu TEST binding konfiguraciju; ne uvoditi lako zloupotrebljiv trajni account lockout. Jača lozinka je operativna mera, ne zamena za limiter. `cf-access-authenticated-user-email` u ovom kodu nije verifikacija Access JWT-a niti gotova Access prijava. |
| **S3 — open redirect** | **Reprodukovano; prva popravka MBA-172.** Provera WHATWG-normalizovanog internog URL-a, backslash/control/encoded varijanti i auth petlji, uz očuvane validne interne linkove. |
| **S4 — audit actor** | **Potvrđena slabost sa užim objašnjenjem.** `app.ts` već postavlja `x-user-email` iz validne sesije, ali `getActor` daje prednost proizvoljnom `cf-access-authenticated-user-email`. To kvari trag autorstva; nije samo po sebi prolazak kroz autentifikaciju. Prosleđivati verifikovanog aktera kroz sve route slojeve. |
| **S5 — revoke sesije** | Logout briše browser cookie, ne poništava server-side token. Poboljšanje ima smisla, ali promena allowlist-e email-a takođe blokira buduću validaciju; nije baš samo rotacija secreta. Za jednog korisnika nije razlog da sada uvodimo ceo multitenant/RBAC sistem. |
| **S6 — dashboard headeri** | Nema jedinstvene eksplicitne politike u aplikacionom asset odgovoru. Potvrditi stvarne hosted headere; uvesti CSP nakon inventara inline koda, slika i konekcija da ne polomimo panel. `noindex` nije autentifikacija. |
| **S7 — callback URL** | Nedostaje stroga server-side validacija HTTPS/destinacije. Secret smanjuje dostupnost te putanje; samo React link nije dokaz izvršivog XSS-a. Validirati pre čuvanja, sa listom dozvoljenih deployment hostova. |
| **S8 — tela zahteva** | Na starijim parserima nema aplikacionog limita; platforma ipak ima svoje limite, pa „neograničeno” nije doslovno. Zajednički byte limit, uključujući stream bez Content-Length i login formu, uz odvojene upload limite. |

Zavisnosti: postojeći **MBA-52** je pravo mesto za audit i kompatibilan upgrade toolchain-a. „Dev dependency” ne znači bezopasno: build/CI takođe imaju ovlašćenja. Nije u ovoj proveri ponovljen ceo vulnerability/history scan. Javni account/network ID-evi nisu lozinke; promena vidljivosti repozitorijuma ne zamenjuje sigurnost aplikacije. Za stari privilegovani workflow prvo utvrditi da više nema potrebnu upotrebu, potom ga ukloniti.

## Organizacija, tipovi i UX

Arhitektonski dug je stvaran: wrapper slojevi, netipizovani config/API ugovori, DOM integracije i mnogo odvojenih workflow-a otežavaju promene. Vite build koji prolazi ne znači da `tsc` prolazi. Istovremeno, pretvaranje svakog `.mjs` fajla u `.ts` samo po sebi ne popravlja runtime, a može promeniti frozen potpise.

Predlog faza treba izmeniti: nije moguće odmah zahtevati čist `tsc` od svih PR-ova, a njegovih 63 greške ostaviti za kasniju fazu. **MBA-101** treba da dovede baseline do nule i zatim uvede obaveznu proveru. Do tada nove izmene ne smeju povećavati poznati dug. Konsolidaciju workflow-a raditi uz zadržavanje svih važnih testova, ne samo broja zelenih poslova. Endpoint za repository rulesets je vratio praznu listu; klasična branch protection pravila nisu potvrđena ovim čitanjem.

Ne raditi veliki rewrite Worker-a i generatora u jednom PR-u. Najpre characterization testovi stvarnih HTTP ruta i runtime događaja, potom izdvajanje jednog domena po promeni. Prioriteti UX-a ostaju **MBA-98** (povratak/refresh navigacije), **MBA-99** (Generate/Publish i jasni razlozi blokade) i **MBA-100** (dijalozi). Završeni MBA-96 znači da je prethodni pregled izveden, ne da je proizvod prošao sve live provere; ne koristiti ga kao release sign-off.

## Redosled rada

1. **MBA-172 — S1/S3**, uska popravka već implementirana i lokalno proverena; PR i izolovani TEST pre main-a.
2. **MBA-171 — R1/R2**, nova runtime verzija i reprodukcije sa pravim Prebid-om; zatim hosted CMP/GPT test. Meriti consent stanje, auction start/end, fallback razlog i broj requesta po slotu. GAM key-values nisu zamena za page-level telemetry i prihod.
3. **MBA-101 / MBA-52 / bezbednosni follow-up**: tipovi/CI, kontrolisan toolchain upgrade, login limiter i pouzdan audit actor. Bez prepisivanja istorijskih artefakata.
4. **MBA-48 / MBA-22**: pun tok konfiguracija → Generate → download → TEST → publish → rollback, uz stvarne ad requeste, spor/odsutan CMP/Prebid, mobilni viewport, duplicate slot/script i tuđi GPT slot. Posebno proveriti ponašanje posle neuspelog deploy-a.
5. **MBA-98/99/100**, zatim ciljane cache/GAM optimizacije i kontrolisano širenje na GPID/EID, outstream i deals. Postojeće stavke zadržati; ne praviti duple backlog-e ili automatski zatvarati neproverene funkcije.

Ne obećavati 4–8 nedelja na osnovu samog broja fajlova ili nalaza. Svaka isporuka mora imati konkretan rezultat, tačnu verziju i granice testa.

## Prva popravka — obim i granice

HTML artefakti dobijaju sandbox bez `allow-same-origin`, `no-referrer` i `private, no-store`; obuhvaćeni su built-in, legacy, channel, immutable i autentifikovani file odgovori. `no-referrer` je bitan i zbog starijeg middleware-a koji koristi Referer kao dokaz porekla. JavaScript/CSS pravila keširanja i svi sačuvani fajlovi ostaju neizmenjeni. Login sada proverava parsirano odredište.

Testovi: `auth-redirect.test.mjs`, `release-html-security.test.mjs`, `site-package-flow.test.mjs`, `site-test-page.test.mjs`; `scripts/verify-artifact-boundary.mjs` proverava kompajlirani Worker. CI pokreće nove provere. Ovo nije browser potvrda svake vrste oglasa: sandbox namerno uskraćuje admin-origin storage, pa za realan ad-serving koristiti publisher TEST origin.

Ranije keširan HTML sa jednogodišnjim immutable headerom neće retroaktivno dobiti novi CSP. Pri promociji proveriti sveže odgovore i otvoriti primer uz zaobilaženje starog browser cache-a; dugoročno odvojiti origin za publisher primere. Produkcioni glavni branch, publish kanali i publisher skripte nisu promenjeni ovom proverom.

## Primarni izvori

- [Prebid TCF: timeout, actionTimeout, defaultGdprScope](https://docs.prebid.org/dev-docs/modules/consentManagementTcf.html)
- [Google: personalized i non-personalized ads](https://support.google.com/admanager/answer/9005435?hl=en)
- [Google: web interstitial trigger-i i frequency cap](https://support.google.com/admanager/answer/9840201?hl=en)
- [Google: deklarisanje refresh inventara](https://support.google.com/admanager/answer/6286179?hl=en)
- [Cloudflare Pages: cache, ETag i kompresija](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [Better Ads Standards](https://www.betterads.org/standards/)
- [Prebid Universal Creative](https://github.com/prebid/prebid-universal-creative)
