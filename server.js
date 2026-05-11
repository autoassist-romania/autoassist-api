const express = require('express');
const { execSync } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_TTL = 3600000;

// Găsește calea Chromium automat
function getChromiumPath() {
  const paths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', 
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/render/.cache/ms-playwright/chromium-1097/chrome-linux/chrome',
    '/opt/render/.cache/ms-playwright/chromium-1112/chrome-linux/chrome',
    '/opt/render/.cache/ms-playwright/chromium-1117/chrome-linux/chrome',
    '/opt/render/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  
  const { readdirSync, existsSync } = require('fs');
  
  // Caută dinamic în cache playwright
  try {
    const playwrightCache = '/opt/render/.cache/ms-playwright';
    if (existsSync(playwrightCache)) {
      const dirs = readdirSync(playwrightCache);
      for (const dir of dirs) {
        const possibles = [
          `${playwrightCache}/${dir}/chrome-linux/chrome`,
          `${playwrightCache}/${dir}/chrome-headless-shell-linux64/chrome-headless-shell`,
          `${playwrightCache}/${dir}/chrome-linux64/chrome`,
        ];
        for (const p of possibles) {
          if (existsSync(p)) return p;
        }
      }
    }
  } catch(e) {}
  
  // Încearcă căile fixe
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  
  // Ultima soluție: which
  try {
    return execSync('which google-chrome chromium chromium-browser 2>/dev/null | head -1').toString().trim();
  } catch(e) {}
  
  return null;
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (req, res) => {
  const chromePath = getChromiumPath();
  res.json({ status: 'AutoAssist API online', chromePath: chromePath || 'not found' });
});

app.get('/api/vehicul', async (req, res) => {
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');

  if (!nr || nr.length < 4) return res.status(400).json({ error: 'Nr. invalid' });

  const cacheKey = `${nr}_${vin}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const chromePath = getChromiumPath();
  if (!chromePath) {
    return res.status(500).json({ 
      error: 'Chromium nu este instalat pe server',
      hint: 'Adaugă buildCommand: npm install && npx playwright install chromium --with-deps în render.yaml'
    });
  }

  let browser;
  try {
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
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
      nr, judet: getJudet(nr),
      timestamp: new Date().toISOString(),
      rca: rca.status === 'fulfilled' ? rca.value : { error: true, mesaj: 'Eroare RCA' },
      rovinieta: rov.status === 'fulfilled' ? rov.value : { error: true, mesaj: 'Eroare rovignetă' },
      itp,
    };

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return res.json(result);

  } catch(e) {
    console.error('Eroare:', e.message);
    return res.status(500).json({ error: e.message, chromePath });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

async function verificaRCA(browser, nr) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.aida.info.ro/polite-rca', { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('input[value="2"]').catch(() => {});
    await page.fill('#NrInmatriculare', nr).catch(() => page.fill('input[name="NrInmatriculare"]', nr).catch(() => {}));
    const acord = page.locator('#acord, input[name="acord"]').first();
    const checked = await acord.isChecked().catch(() => false);
    if (!checked) await acord.click().catch(() => {});
    await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return parseRCA(await page.content());
  } finally { await ctx.close(); }
}

async function verificaRovinieta(browser, nr) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/124.0.0.0' });
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.erovinieta.ro/verificare', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name="plateNumber"], #plateNumber, input[type="text"]', nr).catch(() => {});
    await page.click('button[type="submit"], .btn-primary').catch(() => {});
    await page.waitForTimeout(3000);
    return parseRovinieta(await page.content());
  } finally { await ctx.close(); }
}

async function verificaITP(browser, vin) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/124.0.0.0' });
  const page = await ctx.newPage();
  try {
    await page.goto('https://prog.rarom.ro/rarpol/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[id*="VIN"]', vin).catch(() => {});
    await page.click('input[id*="btnCauta"]').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const html = await page.content();
    const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    for (const d of dates) {
      const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
      if (dt.getFullYear() >= 2020) return { valid: dt > new Date(), expira: d, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: dt > new Date() ? 'ITP valabil' : 'ITP expirat' };
    }
    return { valid: null, mesaj: 'CAPTCHA necesar pentru ITP' };
  } finally { await ctx.close(); }
}

function parseRCA(html) {
  if (html.match(/nu exist[aă]|nu a fost/i)) return { valid: false, mesaj: 'Nu există RCA valid' };
  const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
  const asig = (html.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal)[^<\n]*/i)||[])[0]||null;
  for (const d of dates) {
    const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
    if (dt > new Date()) return { valid: true, expira: d, asigurator: asig?.trim().slice(0,30)||null, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'RCA valid' };
  }
  return dates.length ? { valid: false, expira: dates[0], mesaj: 'RCA expirat' } : { valid: null, mesaj: 'Status nedeterminat' };
}

function parseRovinieta(html) {
  if (html.match(/nu exist[aă]|expir[at]+/i)) return { valid: false, mesaj: 'Nu există rovignetă' };
  const dates = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g) || [];
  for (const d of dates) {
    const p = d.replace(/-/g,'.').split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
    if (dt > new Date()) return { valid: true, expira: d, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'Rovignetă activă' };
  }
  return html.match(/activ[aă]/i) ? { valid: true, mesaj: 'Rovignetă activă' } : { valid: null, mesaj: 'Status nedeterminat' };
}

function getJudet(nr) {
  const m = {'B':'București','AB':'Alba','AR':'Arad','AG':'Argeș','BC':'Bacău','BH':'Bihor','BN':'Bistrița-Năsăud','BT':'Botoșani','BV':'Brașov','BR':'Brăila','BZ':'Buzău','CS':'Caraș-Severin','CL':'Călărași','CJ':'Cluj','CT':'Constanța','CV':'Covasna','DB':'Dâmbovița','DJ':'Dolj','GL':'Galați','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomița','IS':'Iași','IF':'Ilfov','MM':'Maramureș','MH':'Mehedinți','MS':'Mureș','NT':'Neamț','OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Sălaj','SB':'Sibiu','SV':'Suceava','TR':'Teleorman','TM':'Timiș','TL':'Tulcea','VS':'Vaslui','VL':'Vâlcea','VN':'Vrancea'};
  return m[nr.match(/^([A-Z]{1,2})/)?.[1]||'']||null;
}

app.listen(PORT, () => console.log(`AutoAssist API pe portul ${PORT}`));
