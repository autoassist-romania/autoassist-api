const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_TTL = 3600000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (req, res) => res.json({ status: 'AutoAssist API online', version: '3.0' }));
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/vehicul', async (req, res) => {
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  const debug = req.query.debug === '1';

  if (!nr || nr.length < 4) return res.status(400).json({ error: 'Nr. invalid' });

  const cacheKey = nr;
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

// === RCA ===
async function verificaRCA(nr, log) {
  // Pasul 1: GET sesiune de pe pagina BAAR
  const initRes = await fetch('https://www.aida.info.ro/verificare-polita-rca', {
    headers: browserHeaders('https://www.aida.info.ro/')
  });
  log.baar_init_status = initRes.status;
  const cookies = extractCookies(initRes.headers.get('set-cookie'));
  const initHtml = await initRes.text();
  log.baar_init_snippet = initHtml.substring(0, 300);

  const tokenMatch = initHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';
  log.baar_token = token ? 'gasit' : 'lipsa';

  // Pasul 2: POST
  const today = new Date().toISOString().split('T')[0];
  const body = new URLSearchParams({
    'NrInmatriculare': nr,
    'DataReferinta': today,
    'CriteriuCautare': '2',
  });
  if (token) body.set('__RequestVerificationToken', token);

  const postRes = await fetch('https://www.aida.info.ro/verificare-polita-rca', {
    method: 'POST',
    headers: {
      ...browserHeaders('https://www.aida.info.ro/verificare-polita-rca'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.aida.info.ro',
      'Cookie': cookies,
    },
    body: body.toString()
  });
  log.baar_post_status = postRes.status;
  const html = await postRes.text();
  log.baar_post_snippet = html.substring(0, 600);

  const result = parseRCA(html);
  if (result.valid !== null) return result;

  // Fallback: polite-rca
  return await verificaRCAv2(nr, log);
}

async function verificaRCAv2(nr, log) {
  const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
    headers: browserHeaders('https://www.aida.info.ro/')
  });
  log.aida2_init_status = initRes.status;
  const cookies = extractCookies(initRes.headers.get('set-cookie'));
  const initHtml = await initRes.text();
  log.aida2_snippet = initHtml.substring(0, 200);

  const tokenMatch = initHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';

  const today = new Date().toISOString().split('T')[0];
  const body = new URLSearchParams({
    'CriteriuCautare': '1',
    'NrInmatriculare': nr,
    'DataVerificare': today,
    'acord': 'true',
  });
  if (token) body.set('__RequestVerificationToken', token);

  const postRes = await fetch('https://www.aida.info.ro/polite-rca', {
    method: 'POST',
    headers: {
      ...browserHeaders('https://www.aida.info.ro/polite-rca'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.aida.info.ro',
      'Cookie': cookies,
    },
    body: body.toString()
  });
  log.aida2_post_status = postRes.status;
  const html = await postRes.text();
  log.aida2_post_snippet = html.substring(0, 600);

  return parseRCA(html);
}

function parseRCA(html) {
  if (!html || html.length < 100) return { valid: null, mesaj: 'Raspuns gol' };
  if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
    return { valid: null, mesaj: 'AIDA blocheaza verificarea automata' };
  }
  if (html.match(/nu exist[aă]|nu a fost g[aă]sit|no result/i)) {
    return { valid: false, expira: null, mesaj: 'Nu exista polita RCA valida' };
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
        mesaj: 'Polita RCA valida'
      };
    }
  }

  if (dates.length) return { valid: false, expira: dates[0], mesaj: 'RCA expirat' };
  return { valid: null, mesaj: 'Status RCA nedeterminat' };
}

// === ROVINIETA ===
async function verificaRovinieta(nr, log) {
  const endpoints = [
    `https://www.erovinieta.ro/api/Vignette/GetByPlateNumber?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`,
    `https://api.erovinieta.ro/api/vignette?plate=${encodeURIComponent(nr)}`,
    `https://www.erovinieta.ro/verificare?plateNumber=${encodeURIComponent(nr)}`,
  ];

  for (let i = 0; i < endpoints.length; i++) {
    try {
      const res = await fetch(endpoints[i], {
        headers: {
          ...browserHeaders('https://www.erovinieta.ro/'),
          'Accept': 'application/json, text/html, */*',
          'Origin': 'https://www.erovinieta.ro',
          'X-Requested-With': 'XMLHttpRequest',
        }
      });
      log[`rov${i+1}_status`] = res.status;
      const text = await res.text();
      log[`rov${i+1}_snippet`] = text.substring(0, 200);

      if (res.ok && text.length > 10) {
        try {
          const data = JSON.parse(text);
          const parsed = parseRovinietaJSON(data);
          if (parsed.valid !== null) return parsed;
        } catch(e) {
          const parsed = parseRovinietaHTML(text);
          if (parsed.valid !== null) return parsed;
        }
      }
    } catch(e) {
      log[`rov${i+1}_err`] = e.message;
    }
  }

  return { valid: null, mesaj: 'Verificare manuala pe erovinieta.ro' };
}

function parseRovinietaJSON(data) {
  const items = Array.isArray(data) ? data : (data?.vignettes || data?.items || data?.data || data?.result || []);
  if (!items || !items.length) {
    if (data?.endDate || data?.validTo || data?.dataExpirare) {
      const expStr = data.endDate || data.validTo || data.dataExpirare;
      const valid = new Date(expStr) > new Date();
      return { valid, expira: formatData(expStr), zileRamase: calcZile(expStr), mesaj: valid ? 'Rovinieta activa' : 'Rovinieta expirata' };
    }
    return { valid: null, mesaj: 'Format necunoscut' };
  }

  const azi = new Date();
  const activa = items.find(v => {
    const exp = v.endDate || v.validTo || v.expirDate || v.dataExpirare || v.EndDate || v.ValidTo;
    return exp && new Date(exp) > azi;
  });

  if (!activa) {
    const last = items[0];
    const exp = last?.endDate || last?.validTo || last?.EndDate;
    return { valid: false, expira: formatData(exp), mesaj: 'Rovinieta expirata' };
  }

  const expStr = activa.endDate || activa.validTo || activa.expirDate || activa.dataExpirare || activa.EndDate;
  return {
    valid: true,
    expira: formatData(expStr),
    categorie: activa.category || activa.vehicleCategory || activa.Category || 'A',
    zileRamase: calcZile(expStr),
    mesaj: 'Rovinieta activa'
  };
}

function parseRovinietaHTML(html) {
  if (!html) return { valid: null, mesaj: 'Raspuns gol' };
  const activa = html.match(/activ[aă]|valabil[aă]/i);
  const expirata = html.match(/expir[at]+|nu exist[aă]/i);
  const dates = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g) || [];

  if (expirata && !activa) return { valid: false, mesaj: 'Nu exista rovinieta activa' };
  for (const d of dates) {
    const p = d.replace(/[-/]/g, '.').split('.');
    const dt = new Date(+p[2], +p[1] - 1, +p[0]);
    if (dt > new Date()) return { valid: true, expira: d, zileRamase: Math.ceil((dt - new Date()) / 86400000), mesaj: 'Rovinieta activa' };
  }
  return { valid: null, mesaj: 'Verificare manuala pe erovinieta.ro' };
}

// === HELPERS ===
function browserHeaders(referer) {
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
    'B': 'Bucuresti', 'AB': 'Alba', 'AR': 'Arad', 'AG': 'Arges',
    'BC': 'Bacau', 'BH': 'Bihor', 'BN': 'Bistrita-Nasaud', 'BT': 'Botosani',
    'BV': 'Brasov', 'BR': 'Braila', 'BZ': 'Buzau', 'CS': 'Caras-Severin',
    'CL': 'Calarasi', 'CJ': 'Cluj', 'CT': 'Constanta', 'CV': 'Covasna',
    'DB': 'Dambovita', 'DJ': 'Dolj', 'GL': 'Galati', 'GR': 'Giurgiu',
    'GJ': 'Gorj', 'HR': 'Harghita', 'HD': 'Hunedoara', 'IL': 'Ialomita',
    'IS': 'Iasi', 'IF': 'Ilfov', 'MM': 'Maramures', 'MH': 'Mehedinti',
    'MS': 'Mures', 'NT': 'Neamt', 'OT': 'Olt', 'PH': 'Prahova',
    'SM': 'Satu Mare', 'SJ': 'Salaj', 'SB': 'Sibiu', 'SV': 'Suceava',
    'TR': 'Teleorman', 'TM': 'Timis', 'TL': 'Tulcea', 'VS': 'Vaslui',
    'VL': 'Valcea', 'VN': 'Vrancea'
  };
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}

app.listen(PORT, () => console.log(`AutoAssist API v3.0 pe portul ${PORT}`));
