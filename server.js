const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});
app.options('*', (req, res) => res.status(204).end());
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Browser singleton — nu deschidem browser nou la fiecare request
let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });
  }
  return browser;
}

app.get('/api/vehicul', async (req, res) => {
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!nr || nr.length < 4) return res.status(400).json({ error: 'Nr. invalid' });

  const result = {
    nr,
    judet: getJudet(nr),
    timestamp: new Date().toISOString(),
    rca: null,
    rovinieta: null,
    itp: { mesaj: 'Introdu VIN-ul din talon', necesitaVIN: true }
  };

  const b = await getBrowser();

  // RCA via AIDA
  try {
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto('https://www.aida.info.ro/polite-rca', { waitUntil: 'networkidle2', timeout: 20000 });
    await page.select('select[name="CriteriuCautare"]', '1').catch(() => {});
    await page.type('input[name="NrInmatriculare"]', nr);
    const azi = new Date();
    const dataFmt = `${azi.getFullYear()}-${String(azi.getMonth()+1).padStart(2,'0')}-${String(azi.getDate()).padStart(2,'0')}`;
    await page.evaluate((d) => {
      const el = document.querySelector('input[name="DataVerificare"]');
      if (el) el.value = d;
    }, dataFmt);
    await page.click('input[name="acord"]').catch(() => {});
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]')
    ]);
    const html = await page.content();
    await page.close();

    const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    const asig = (html.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal)[^<\n]*/i) || [])[0] || null;
    let rcaResult = { valid: null, mesaj: 'Status nedeterminat' };
    if (html.match(/nu exist[aă]|nu a fost/i)) {
      rcaResult = { valid: false, mesaj: 'Nu există RCA valid' };
    } else {
      for (const d of dates) {
        const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
        if (dt > new Date()) { rcaResult = { valid: true, expira: d, asigurator: asig?.trim().slice(0,30)||null, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'RCA valid' }; break; }
      }
    }
    result.rca = rcaResult;
  } catch(e) { result.rca = { valid: null, mesaj: 'Eroare verificare RCA: ' + e.message }; }

  // Rovinieta via erovinieta API
  try {
    const page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    const apiUrl = `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`;
    await page.goto(apiUrl, { timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    await page.close();
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : (data?.vignettes || data?.items || []);
    const activa = items.find(v => new Date(v.endDate || v.validTo) > new Date());
    if (activa) {
      const dt = new Date(activa.endDate || activa.validTo);
      const pad = n => String(n).padStart(2,'0');
      result.rovinieta = { valid: true, expira: `${pad(dt.getDate())}.${pad(dt.getMonth()+1)}.${dt.getFullYear()}`, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'Rovignetă activă' };
    } else if (items.length) {
      result.rovinieta = { valid: false, mesaj: 'Rovignetă expirată' };
    } else {
      result.rovinieta = { valid: false, mesaj: 'Nu există rovignetă' };
    }
  } catch(e) { result.rovinieta = { valid: null, mesaj: 'Eroare verificare rovignetă' }; }

  return res.json(result);
});

function getJudet(nr) {
  const m = {'B':'București','AB':'Alba','AR':'Arad','AG':'Argeș','BC':'Bacău','BH':'Bihor','BN':'Bistrița-Năsăud','BT':'Botoșani','BV':'Brașov','BR':'Brăila','BZ':'Buzău','CS':'Caraș-Severin','CL':'Călărași','CJ':'Cluj','CT':'Constanța','CV':'Covasna','DB':'Dâmbovița','DJ':'Dolj','GL':'Galați','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomița','IS':'Iași','IF':'Ilfov','MM':'Maramureș','MH':'Mehedinți','MS':'Mureș','NT':'Neamț','OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Sălaj','SB':'Sibiu','SV':'Suceava','TR':'Teleorman','TM':'Timiș','TL':'Tulcea','VS':'Vaslui','VL':'Vâlcea','VN':'Vrancea'};
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}

app.listen(PORT, () => console.log(`AutoAssist API cu Puppeteer pe portul ${PORT}`));
