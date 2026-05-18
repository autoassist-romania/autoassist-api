# AutoAssist — Backend API (Vercel Edge Functions)

## Cum funcționează

Fișierele din `/api/` sunt **Vercel Edge Functions** — rulează pe serverele Vercel,
gratuit, fără să ai nevoie de un server propriu.

Când utilizatorul adaugă o mașină în garaj cu nr. înmatriculare, aplicația face:
```
GET https://www.autoassist.ro/api/vehicul?nr=B123ABC
```

Serverul Vercel (nu browserul utilizatorului) face cereri la:
- **AIDA** (aida.info.ro) → verifică RCA
- **erovinieta.ro** (CNAIR) → verifică rovignetă
- **RAR** (prog.rarom.ro) → verifică ITP (necesită VIN)

Returnează tot într-un singur răspuns JSON.

## Deploy

**Pasul 1:** Copiază folderul `api/` și `vercel.json` în root-ul repo-ului tău GitHub
```
autoassist/
├── index.html          ← existent
├── vercel.json         ← NOU
├── api/
│   ├── vehicul.js      ← NOU — endpoint principal
│   ├── verificare-rca.js
│   ├── verificare-itp.js
│   └── verificare-rovinieta.js
```

**Pasul 2:** Push pe GitHub → Vercel deployează automat în ~30 secunde

**Pasul 3:** Testează în browser:
```
https://www.autoassist.ro/api/vehicul?nr=B123ABC
```

## Limitări cunoscute

- **ITP**: RAR are CAPTCHA pe formularul web → necesită VIN introdus manual
  sau vom integra inmatriculareapi.ro (1 leu/query) pentru VIN automat
- **RCA**: AIDA poate schimba structura HTML → monitorizăm
- **Rovignetă**: funcționează cel mai bine cu VIN în plus față de nr înmatriculare

## Îmbunătățire viitoare

Când primești API key de la inmatriculareapi.ro, adaugă în Vercel:
- Environment Variable: `INMATRICULARE_API_KEY=your_key_here`
- Funcția `getDateTehnice()` din `vehicul.js` va returna automat VIN + date tehnice
- Atunci ITP funcționează 100% automat

## Cost

**Zero** — Vercel Edge Functions sunt gratuite până la 1 milion de request-uri/lună.
