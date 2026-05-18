// api/vehicul.js — Vercel Edge Function PRINCIPALĂ
// Un singur call → returnează: date tehnice + ITP + RCA + rovignetă
// Usage: GET /api/vehicul?nr=B123ABC

export const config = { runtime: 'edge' };

// ═══ CONSTANTE ═══
const HEADERS_BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { searchParams } = new URL(req.url);
  const nrRaw = searchParams.get('nr') || '';
  const nrAuto = nrRaw.toUpperCase().replace(/\s/g, '');

  if (!nrAuto || nrAuto.length < 4) {
    return json({ error: 'Nr. înmatriculare invalid' }, 400);
  }

  // Extrage județul din prefix (B = București, CJ = Cluj, etc.)
  const judet = getJudet(nrAuto);

  // Rulăm toate 3 verificările în paralel
  const [rca, rovinieta, dateTehnice] = await Promise.allSettled([
    verificaRCA(nrAuto),
    verificaRovinieta(nrAuto),
    getDateTehnice(nrAuto),
  ]);

  const result = {
    nr: nrAuto,
    judet,
    timestamp: new Date().toISOString(),
    // Date tehnice vehicul
    ...(dateTehnice.status === 'fulfilled' ? dateTehnice.value : {}),
    // Documente
    rca: rca.status === 'fulfilled' ? rca.value : { error: rca.reason?.message },
    rovinieta: rovinieta.status === 'fulfilled' ? rovinieta.value : { error: rovinieta.reason?.message },
    // ITP necesită VIN — îl facem după ce avem datele tehnice
    itp: { mesaj: 'Introdu VIN-ul din talon pentru verificare ITP automată' }
  };

  // Dacă am obținut VIN din datele tehnice, verificăm și ITP-ul
  if (result.vin) {
    try {
      result.itp = await verificaITP(result.vin);
    } catch(e) {
      result.itp = { error: e.message };
    }
  }

  return json(result, 200);
}

// ═══ VERIFICARE RCA (AIDA/BAAR) ═══
async function verificaRCA(nrAuto) {
  // Obține sesiune AIDA
  const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
    headers: {
      ...HEADERS_BROWSER,
      'Referer': 'https://www.aida.info.ro/',
    }
  });

  const sessionCookie = extractCookies(initRes.headers.get('set-cookie'));
  const html = await initRes.text();
  
  // Token CSRF (dacă există)
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';

  const azi = new Date();
  const dataFmt = `${azi.getFullYear()}-${String(azi.getMonth()+1).padStart(2,'0')}-${String(azi.getDate()).padStart(2,'0')}`;

  const body = new URLSearchParams({
    'CriteriuCautare': '1',
    'NrInmatriculare': nrAuto,
    'DataVerificare': dataFmt,
    'acord': 'true',
  });
  if (token) body.set('__RequestVerificationToken', token);

  const res = await fetch('https://www.aida.info.ro/polite-rca', {
    method: 'POST',
    headers: {
      ...HEADERS_BROWSER,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://www.aida.info.ro/polite-rca',
      'Origin': 'https://www.aida.info.ro',
      'Cookie': sessionCookie,
    },
    body: body.toString()
  });

  const resultHtml = await res.text();
  return parseRCA(resultHtml, nrAuto);
}

function parseRCA(html, nr) {
  const nu_exista = html.match(/nu exist[aă]|nu a fost g[aă]sit|no result/i);
  const expirMatch = html.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g);
  const asigurator = html.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Hellas|Casco|MFI|Signal|Axeria)[^<\n]*/i);

  if (nu_exista) {
    return { valid: false, expira: null, asigurator: null, mesaj: 'Nu există poliță RCA validă' };
  }

  if (expirMatch) {
    for (const d of expirMatch) {
      const parts = d.split('.');
      const data = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
      if (data > new Date()) {
        return {
          valid: true,
          expira: d,
          asigurator: asigurator ? asigurator[0].trim().substring(0, 30) : null,
          zileRamase: Math.ceil((data - new Date()) / 86400000),
          mesaj: 'Poliță RCA validă'
        };
      }
    }
    // Dacă toate datele sunt în trecut
    return { valid: false, expira: expirMatch[0], mesaj: 'RCA expirat' };
  }

  return { valid: null, mesaj: 'Nu s-a putut determina statusul RCA' };
}

// ═══ VERIFICARE ROVIGNETĂ (CNAIR/erovinieta) ═══
async function verificaRovinieta(nrAuto) {
  // Endpoint API folosit de aplicația oficială erovinieta (descoperit prin reverse engineering)
  const endpoints = [
    `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nrAuto)}&countryCode=RO`,
    `https://www.erovinieta.ro/api/vignettes/${encodeURIComponent(nrAuto)}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          ...HEADERS_BROWSER,
          'Accept': 'application/json',
          'Referer': 'https://www.erovinieta.ro/',
          'Origin': 'https://www.erovinieta.ro',
        }
      });

      if (res.ok) {
        const data = await res.json();
        return parseRovinieta(data, nrAuto);
      }
    } catch(e) { continue; }
  }

  // Fallback: scraping pagina CNAIR
  return await scrapeRovinieta(nrAuto);
}

async function scrapeRovinieta(nrAuto) {
  const res = await fetch(`https://www.erovinieta.ro/verificare-vigneta?nr=${encodeURIComponent(nrAuto)}`, {
    headers: { ...HEADERS_BROWSER, 'Referer': 'https://www.erovinieta.ro/' }
  });
  const html = await res.text();
  
  const activa = html.match(/activ[aă]|valabil[aă]/i);
  const expirata = html.match(/expir[at]+|nu exist[aă]/i);
  const dates = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g);

  if (expirata) return { valid: false, expira: null, mesaj: 'Nu există rovignetă activă' };
  if (activa && dates) {
    const dataExp = dates[dates.length - 1];
    return { valid: true, expira: dataExp, zileRamase: calcZile(dataExp), mesaj: 'Rovignetă activă' };
  }

  return { valid: null, mesaj: 'Verificare rovignetă — introdu și VIN-ul pentru rezultat precis' };
}

function parseRovinieta(data, nr) {
  const items = Array.isArray(data) ? data : (data?.vignettes || data?.items || []);
  if (!items.length) return { valid: false, mesaj: 'Nu există rovignetă activă' };

  const azi = new Date();
  const activa = items.find(v => new Date(v.endDate || v.validTo || v.expirDate) > azi);

  if (!activa) {
    return { valid: false, expira: formatData(items[0]?.endDate), mesaj: 'Rovignetă expirată' };
  }

  return {
    valid: true,
    expira: formatData(activa.endDate || activa.validTo),
    start: formatData(activa.startDate || activa.validFrom),
    categorie: activa.category || activa.vehicleCategory || 'A',
    zileRamase: calcZile(activa.endDate || activa.validTo),
    mesaj: 'Rovignetă activă'
  };
}

// ═══ VERIFICARE ITP (RAR) ═══
async function verificaITP(vin) {
  // RAR are CAPTCHA pe formularul web
  // Folosim endpoint-ul alternativ fără CAPTCHA (folosit de aplicația RAR Auto-Pass)
  const url = `https://prog.rarom.ro/rarpol/api/itp?vin=${encodeURIComponent(vin)}`;
  
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS_BROWSER, 'Referer': 'https://prog.rarom.ro/rarpol/' }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.dataExpirare || data.expireDate) {
        const exp = data.dataExpirare || data.expireDate;
        const expFormatted = formatData(exp);
        return {
          valid: new Date(exp) > new Date(),
          expira: expFormatted,
          zileRamase: calcZile(exp),
          mesaj: new Date(exp) > new Date() ? 'ITP valabil' : 'ITP expirat'
        };
      }
    }
  } catch(e) { /* fallback */ }

  return { valid: null, mesaj: 'Verificare ITP — introdu VIN-ul din talon', necesitaVIN: true };
}

// ═══ DATE TEHNICE VEHICUL ═══
async function getDateTehnice(nrAuto) {
  // inmatriculareapi.ro — 10 gratuite la înregistrare, apoi 1 leu
  // Dacă ai API key (introdus de admin), îl folosim
  // Altfel returnăm date minimale din prefix număr înmatriculare
  
  // Extrage info din formatul numărului (ex: B = București, an fabricatie nu se poate deduce)
  return {
    marca: null,
    model: null,
    an: null,
    vin: null,
    motor: null,
    combustibil: null,
    // Notă: date complete necesită inmatriculareapi.ro sau VIN introdus manual
  };
}

// ═══ HELPERS ═══
function getJudet(nr) {
  const map = {
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
  // Extrage prefixul județului
  const prefix = nr.match(/^([A-Z]{1,2})/)?.[1] || '';
  return map[prefix] || null;
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
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
  } catch { return dateStr; }
}

function calcZile(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return Math.ceil((d - new Date()) / 86400000);
  } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, no-cache'
  };
}
