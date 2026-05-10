const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache pentru a nu repeta cereri identice în interval scurt
const cache = new Map();
const CACHE_TTL = 3600000; // 1 oră

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AutoAssist API online', version: '1.0' });
});

// ═══ ENDPOINT PRINCIPAL ═══
app.get('/api/vehicul', async (req, res) => {
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');

  if (!nr || nr.length < 4) {
    return res.status(400).json({ error: 'Nr. înmatriculare invalid' });
  }

  // Verifică cache
  const cacheKey = `${nr}_${vin}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const [rca, rov] = await Promise.allSettled([
      verificaRCA(browser, nr),
      verificaRovinieta(browser, nr),
    ]);

    let itp = { valid: null, mesaj: 'Introdu VIN din talon', necesitaVIN: true };
    if (vin) {
      try { itp = await verificaITP(browser, vin); } catch(e) {}
    }

    const result = {
      nr,
      judet: getJudet(nr),
      timestamp: new Date().toISOString(),
      rca: rca.status === 'fulfilled' ? rca.value : { error: true, mesaj: 'Eroare RCA' },
      rovinieta: rov.status === 'fulfilled' ? rov.value : { error: true, mesaj: 'Eroare rovignetă' },
      itp,
    };

    // Salvează în cache
    cache.set(cacheKey, { data: result, ts: Date.now() });

    return res.json(result);

  } catch(e) {
    console.error('Eroare vehicul:', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ═══ VERIFICARE RCA (AIDA) ═══
async function verificaRCA(browser, nr) {
  const page = await browser.newPage();
  try {
    // Setăm User-Agent real
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ro-RO,ro;q=0.9' });

    // Navigăm pe pagina AIDA
    await page.goto('https://www.aida.info.ro/polite-rca', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Selectăm "Număr de înmatriculare"
    await page.click('input[value="2"]'); // radio button nr inmatriculare

    // Introducem numărul
    await page.type('#NrInmatriculare', nr, { delay: 50 });

    // Bifăm acordul GDPR
    const acordCheckbox = await page.$('#acord');
    if (acordCheckbox) {
      const isChecked = await page.evaluate(el => el.checked, acordCheckbox);
      if (!isChecked) await acordCheckbox.click();
    }

    // Apăsăm Caută
    await page.click('button[type="submit"], input[type="submit"]');

    // Așteptăm rezultatul
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    const html = await page.content();

    // Parsare rezultat
    return parseRCA(html);

  } finally {
    await page.close();
  }
}

function parseRCA(html) {
  // Verifică dacă există poliță
  if (html.match(/nu exist[aă]|nu a fost g[aă]sit|no poli[tț]/i)) {
    return { valid: false, expira: null, mesaj: 'Nu există RCA valid' };
  }

  // Caută datele de expirare
  const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
  const asigMatch = html.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal|Axeria|Hellas|Casco)[^<\n]*/i);
  const asig = asigMatch ? asigMatch[0].trim().slice(0, 40) : null;

  for (const d of dates) {
    const p = d.split('.');
    const dt = new Date(+p[2], +p[1]-1, +p[0]);
    if (dt.getFullYear() >= new Date().getFullYear()) {
      const valid = dt > new Date();
      return {
        valid,
        expira: d,
        asigurator: asig,
        zileRamase: Math.ceil((dt - new Date()) / 86400000),
        mesaj: valid ? 'RCA valid' : 'RCA expirat'
      };
    }
  }

  // Dacă pagina are conținut dar nu am găsit date
  if (html.includes('aida') && html.length > 5000) {
    return { valid: null, mesaj: 'Verificare efectuată — dată expirare neprecizată' };
  }

  return { valid: null, mesaj: 'Status RCA nedeterminat' };
}

// ═══ VERIFICARE ROVIGNETĂ (erovinieta) ═══
async function verificaRovinieta(browser, nr) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    await page.goto('https://www.erovinieta.ro/verificare', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Introducem numărul de înmatriculare
    const inputNr = await page.$('input[name="plateNumber"], input[placeholder*="inmatriculare"], #plateNumber, input[type="text"]');
    if (inputNr) {
      await inputNr.click({ clickCount: 3 });
      await inputNr.type(nr, { delay: 50 });
    }

    // Submit
    const submitBtn = await page.$('button[type="submit"], input[type="submit"], .btn-primary');
    if (submitBtn) await submitBtn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const html = await page.content();
    return parseRovinieta(html);

  } finally {
    await page.close();
  }
}

function parseRovinieta(html) {
  if (html.match(/nu exist[aă]|expir[at]+|invalid/i)) {
    return { valid: false, mesaj: 'Nu există rovignetă activă' };
  }

  const dates = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g) || [];
  const categ = (html.match(/categori[ae][:\s]*([A-H])/i) || [])[1] || 'A';

  for (const d of dates) {
    const p = d.replace(/-/g,'.').split('.');
    const dt = new Date(+p[2], +p[1]-1, +p[0]);
    if (dt > new Date()) {
      return {
        valid: true,
        expira: d,
        categorie: categ,
        zileRamase: Math.ceil((dt - new Date()) / 86400000),
        mesaj: 'Rovignetă activă'
      };
    }
  }

  if (html.match(/activ[aă]|valabil[aă]/i)) {
    return { valid: true, mesaj: 'Rovignetă activă — dată neprecizată' };
  }

  return { valid: null, mesaj: 'Status rovignetă nedeterminat' };
}

// ═══ VERIFICARE ITP (RAR) ═══
async function verificaITP(browser, vin) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    await page.goto('https://prog.rarom.ro/rarpol/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Introducem VIN
    const inputVIN = await page.$('#ctl00_ContentPlaceHolder1_txtVIN, input[name*="VIN"], input[id*="VIN"]');
    if (inputVIN) {
      await inputVIN.click({ clickCount: 3 });
      await inputVIN.type(vin, { delay: 50 });
    }

    // RAR are CAPTCHA — încercăm fără
    const submitBtn = await page.$('#ctl00_ContentPlaceHolder1_btnCauta, button[type="submit"]');
    if (submitBtn) await submitBtn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    const html = await page.content();

    const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    for (const d of dates) {
      const p = d.split('.');
      const dt = new Date(+p[2], +p[1]-1, +p[0]);
      if (dt.getFullYear() >= 2020) {
        return {
          valid: dt > new Date(),
          expira: d,
          zileRamase: Math.ceil((dt - new Date()) / 86400000),
          mesaj: dt > new Date() ? 'ITP valabil' : 'ITP expirat'
        };
      }
    }

    if (html.match(/ADMIS/i)) return { valid: true, mesaj: 'ITP valabil' };
    if (html.match(/RESPINS|expirat/i)) return { valid: false, mesaj: 'ITP expirat' };

    return { valid: null, mesaj: 'CAPTCHA necesar pentru RAR — introdu VIN manual', necesitaVIN: true };

  } finally {
    await page.close();
  }
}

// ═══ HELPERS ═══
function getJudet(nr) {
  const m = {'B':'București','AB':'Alba','AR':'Arad','AG':'Argeș','BC':'Bacău','BH':'Bihor','BN':'Bistrița-Năsăud','BT':'Botoșani','BV':'Brașov','BR':'Brăila','BZ':'Buzău','CS':'Caraș-Severin','CL':'Călărași','CJ':'Cluj','CT':'Constanța','CV':'Covasna','DB':'Dâmbovița','DJ':'Dolj','GL':'Galați','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomița','IS':'Iași','IF':'Ilfov','MM':'Maramureș','MH':'Mehedinți','MS':'Mureș','NT':'Neamț','OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Sălaj','SB':'Sibiu','SV':'Suceava','TR':'Teleorman','TM':'Timiș','TL':'Tulcea','VS':'Vaslui','VL':'Vâlcea','VN':'Vrancea'};
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}

app.listen(PORT, () => {
  console.log(`AutoAssist API server pornit pe portul ${PORT}`);
});
