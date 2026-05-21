const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_TTL = 3600000; // 1 oră

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (req, res) => res.json({ status: 'AutoAssist API online', version: '2.0' }));
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/vehicul', async (req, res) => {
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');
  const debug = req.query.debug === '1';

  if (!nr || nr.length < 4) return res.status(400).json({ error: 'Nr. invalid' });

  const cacheKey = `${nr}_${vin}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const log = {};

  const [rcaRes, rovRes] = await Promise.allSettled([
    verificaRCA(nr, log),
    verificaRovinieta(nr, log),
  ]);

  const result = {
    nr,
    judet: getJudet(nr),
    timestamp: new Date().toISOString(),
    rca: rcaRes.status === 'fulfilled' ? rcaRes.value : { valid: null, mesaj: 'Eroare RCA', err: rcaRes.reason?.message },
    rovinieta: rovRes.status === 'fulfilled' ? rovRes.value : { valid: null, mesaj: 'Eroare rovinieta', err: rovRes.reason?.message },
    itp: { valid: null, mesaj: 'Introdu VIN din talon pentru verificare ITP', necesitaVIN: true },
  };

  if (debug) result._debug = log;

  cache.set(cacheKey, { data: result, ts: Date.now() });
  return res.json(result);
});

// ═══ RCA ═══
async function verificaRCA(nr, log) {

  // Pasul 1: GET sesiune + CSRF token
  const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
    headers: headers('https://www.aida.info.ro/')
  });

  log.aida_init_status = initRes.status;
  const cookies = extractCookies(initRes.headers.get('set-cookie'));
  const initHtml = await initRes.text();
  log.aida_init_snippet = initHtml.substring(0, 400);

  // Dacă AIDA a returnat Cloudflare challenge
  if (initHtml.includes('cf-browser-verification') || initHtml.includes('Just a moment') || initHtml.includes('Enable JavaScript')) {
    log.aida_blocked = true;
    return { valid: null, mesaj: 'AIDA blochează verificarea automată — verifică pe aida.info.ro' };
  }

  const tokenMatch = initHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';
  log.aida_token = token ? 'găsit' : 'lipsă';

  const today = new Date().toISOString().split('T')[0];
  const body = new URLSearchParams({
    'CriteriuCautare': '1',
    'NrInmatriculare': nr,
    'DataVerificare': today,
    'acord': 'true',
  });
  if (token) body.set('__RequestVerificationToken', token);

  // Pasul 2: POST cu datele
  const postRes = await fetch('https://www.aida.info.ro/polite-rca', {
    method: 'POST',
    headers: {
      ...headers('https://www.aida.info.ro/polite-rca'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.aida.info.ro',
      'Cookie': cookies,
    },
    body: body.toString()
  });

  log.aida_post_status = postRes.status;
  const html = await postRes.text();
  log.aida_post_snippet = html.substring(0, 600);

  return parseRCA(html);
}

function parseRCA(html) {
  if (!html || html.length < 100) return { valid: null, mesaj: 'Răspuns gol AIDA' };
  if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
    return { valid: null, mesaj: 'AIDA blochează verificarea automată' };
  }
  if (html.match(/nu exist[aă]|nu a fost g[aă]sit|no result/i)) {
    return { valid: false, expira: null, mesaj: 'Nu există poliță RCA validă' };
  }

  const dates = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
  const asig = (html.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal|Axeria|Casco)[^<\n]*/i) || [])[0] || null;

  for (const d of dates) {
    const p = d.split('.');
    const dt = new Date(+p[2], +p[1] - 1, +p[0]);
    if (dt > new Date()) {
      return {
        valid: true,
        expira: d,
        asigurator: asig ? asig.trim().slice(0, 40) : null,
        zileRamase: Math.ceil((dt - new Date()) / 86400000),
        mesaj: 'Poliță RCA validă'
      };
    }
  }

  if (dates.length) return { valid: false, expira: dates[0], mesaj: 'RCA expirat' };
  return { valid: null, mesaj: 'Status RCA nedeterminat — verifică pe aida.info.ro' };
}

// ═══ ROVINIETA ═══
async function verificaRovinieta(nr, log) {
  // Endpoint JSON oficial CNAIR
  const endpoints = [
    `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`,
    `https://www.erovinieta.ro/api/v1/vignettes?plateNumber=${encodeURIComponent(nr)}`,
  ];

  for (let i = 0; i < endpoints.length; i++) {
    try {
      const res = await fetch(endpoints[i], {
        headers: {
          ...headers('https://www.erovinieta.ro/'),
          'Accept': 'application/json, */*',
          'Origin': 'https://www.erovinieta.ro',
        }
      });
      log[`rov_api${i+1}_status`] = res.status;

      if (res.ok) {
        const text = await res.text();
        log[`rov_api${i+1}_snippet`] = text.substring(0, 300);
        try {
          const data = JSON.parse(text);
          const parsed = parseRovinietaJSON(data);
          if (parsed.valid !== null) return parsed;
        } catch(e) {
          log[`rov_api${i+1}_parse_err`] = e.message;
        }
      }
    } catch(e) {
      log[`rov_api${i+1}_err`] = e.message;
    }
  }

  // Fallback: scraping pagina
  try {
    const res = await fetch(`https://www.erovinieta.ro/verificare-vigneta?nr=${encodeURIComponent(nr)}`, {
      headers: headers('https://www.erovinieta.ro/')
    });
    log.rov_scrape_status = res.status;
    if (res.ok) {
      const html = await res.text();
      log.rov_scrape_snippet = html.substring(0, 400);
      return parseRovinietaHTML(html);
    }
  } catch(e) {
    log.rov_scrape_err = e.message;
  }

  return { valid: null, mesaj: 'Verificare manuală pe erovinieta.ro' };
}

function parseRovinietaJSON(data) {
  const items = Array.isArray(data) ? data : (data?.vignettes || data?.items || data?.data || []);
  if (!items || !items.length) return { valid: false, mesaj: 'Nu există rovinieta activă' };

  const azi = new Date();
  const activa = items.find(v => {
    const exp = v.endDate || v.validTo || v.expirDate || v.dataExpirare;
    return exp && new Date(exp) > azi;
  });

  if (!activa) {
    const last = items[0];
    const exp = last?.endDate || last?.validTo || last?.expirDate;
    return { valid: false, expira: formatData(exp), mesaj: 'Rovinieta expirată' };
  }

  const expStr = activa.endDate || activa.validTo || activa.expirDate || activa.dataExpirare;
  return {
    valid: true,
    expira: formatData(expStr),
    categorie: activa.category || activa.vehicleCategory || 'A',
    zileRamase: calcZile(expStr),
    mesaj: 'Rovinieta activă'
  };
}

function parseRovinietaHTML(html) {
  if (!html) return { valid: null, mesaj: 'Răspuns gol' };
  if (html.match(/nu exist[aă]|expir[at]+/i) && !html.match(/activ[aă]/i)) {
    return { valid: false, mesaj: 'Nu există rovinieta activă' };
  }
  const dates = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g) || [];
  for (const d of dates) {
    const p = d.replace(/[-/]/g, '.').split('.');
    const dt = new Date(+p[2], +p[1] - 1, +p[0]);
    if (dt > new Date()) {
      return { valid: true, expira: d, zileRamase: Math.ceil((dt - new Date()) / 86400000), mesaj: 'Rovinieta activă' };
    }
  }
  return { valid: null, mesaj: 'Verificare manuală pe erovinieta.ro' };
}

// ═══ HELPERS ═══
function headers(referer) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': referer,
  };
}

function extractCookies(cookieHeader) {
  if (!cookieHeader) return '';
  return cookieHeader.split(',').map(c => c.split(';')[0].trim()).join('; ');
}

function formatData(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  } catch { return dateStr; }
}

function calcZile(dateStr) {
  if (!dateStr) return null;
  try { return Math.ceil((new Date(dateStr) - new Date()) / 86400000); }
  catch { return null; }
}

function getJudet(nr) {
  const m = {
    'B': 'București', 'AB': 'Alba', 'AR': 'Arad', 'AG': 'Argeș',
    'BC': 'Bacău', 'BH': 'Bihor', 'BN': 'Bistrița-Năsăud', 'BT': 'Botoșani',
    'BV': 'Brașov', 'BR': 'Brăila', 'BZ': 'Buzău', 'CS': 'Caraș-Severin',
    'CL': 'Călărași', 'CJ': 'Cluj', 'CT': 'Constanța', 'CV': 'Covasna',
    'DB': 'Dâmbovița', 'DJ': 'Dolj', 'GL': 'Galați', 'GR': 'Giurgiu',
    'GJ': 'Gorj', 'HR': 'Harghita', 'HD': 'Hunedoara', 'IL': 'Ialomița',
    'IS': 'Iași', 'IF': 'Ilfov', 'MM': 'Maramureș', 'MH': 'Mehedinți',
    'MS': 'Mureș', 'NT': 'Neamț', 'OT': 'Olt', 'PH': 'Prahova',
    'SM': 'Satu Mare', 'SJ': 'Sălaj', 'SB': 'Sibiu', 'SV': 'Suceava',
    'TR': 'Teleorman', 'TM': 'Timiș', 'TL': 'Tulcea', 'VS': 'Vaslui',
    'VL': 'Vâlcea', 'VN': 'Vrancea'
  };
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}

app.listen(PORT, () => console.log(`AutoAssist API v2.0 pe portul ${PORT}`));
