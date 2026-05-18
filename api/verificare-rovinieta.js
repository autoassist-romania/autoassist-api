// api/verificare-rovinieta.js — Vercel Edge Function
// Verificare rovignetă via CNAIR (erovinieta.ro)

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const nrAuto = searchParams.get('nr')?.toUpperCase().replace(/\s/g, '') || '';
  const vin = searchParams.get('vin')?.toUpperCase().replace(/\s/g, '') || '';

  if (!nrAuto) {
    return new Response(JSON.stringify({ error: 'Nr. înmatriculare lipsă' }), {
      status: 400, headers: corsHeaders()
    });
  }

  try {
    // erovinieta.ro are un endpoint JSON neoficial descoperit de comunitate
    // Folosit de integrări Home Assistant (github.com/cnecrea/erovinieta)
    const result = await verificaRovinieta(nrAuto, vin);

    return new Response(JSON.stringify(result), {
      status: 200, headers: corsHeaders()
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Eroare verificare rovignetă', detalii: err.message
    }), { status: 500, headers: corsHeaders() });
  }
}

async function verificaRovinieta(nrAuto, vin) {
  // Endpoint 1: erovinieta.ro API (folosit de aplicația oficială)
  try {
    const res = await fetch('https://www.erovinieta.ro/vignettes/GetVignettesByPlateNumber', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': 'application/json',
        'Referer': 'https://www.erovinieta.ro/',
        'Origin': 'https://www.erovinieta.ro',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        plateNumber: nrAuto,
        vin: vin || '',
        countryCode: 'RO'
      })
    });

    if (res.ok) {
      const data = await res.json();
      return parseErovinieta(data, nrAuto);
    }
  } catch(e) { /* încearcă endpoint alternativ */ }

  // Endpoint 2: fallback — scraping pagina de verificare CNAIR
  return await scrapeCNAIR(nrAuto, vin);
}

function parseErovinieta(data, nr) {
  if (!data || (Array.isArray(data) && data.length === 0)) {
    return {
      nr,
      rovinieta: { valid: false, expira: null, categorie: null, mesaj: 'Nu există rovignetă activă' }
    };
  }

  // Găsește rovigneta activă curentă
  const items = Array.isArray(data) ? data : (data.vignettes || data.items || [data]);
  const azi = new Date();
  
  const activa = items.find(v => {
    const end = new Date(v.endDate || v.validTo || v.expireDate);
    return end > azi;
  });

  if (!activa) {
    // Ultimă rovignetă expirată
    const ultima = items[0];
    return {
      nr,
      rovinieta: {
        valid: false,
        expira: formatData(ultima?.endDate || ultima?.validTo),
        categorie: ultima?.category || ultima?.vehicleCategory,
        mesaj: 'Rovignetă expirată'
      }
    };
  }

  const expira = formatData(activa.endDate || activa.validTo || activa.expireDate);
  const start = formatData(activa.startDate || activa.validFrom);
  
  return {
    nr,
    rovinieta: {
      valid: true,
      expira,
      start,
      categorie: activa.category || activa.vehicleCategory || 'A',
      zileRamase: calcZile(activa.endDate || activa.validTo),
      mesaj: 'Rovignetă activă'
    }
  };
}

async function scrapeCNAIR(nrAuto, vin) {
  // Fallback: scraping pagina verificare CNAIR
  const formData = new URLSearchParams({
    'plateNumber': nrAuto,
    'vin': vin || '',
    'countryCode': 'RO'
  });

  const res = await fetch('https://www.erovinieta.ro/verificare', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
      'Referer': 'https://www.erovinieta.ro/',
    },
    body: formData.toString()
  });

  const html = await res.text();
  
  // Parsare HTML răspuns
  const expMatch = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g);
  const validMatch = html.match(/activ[aă]|valid[aă]/i);
  const expirMatch = html.match(/expir[at]+|nu exist[aă]/i);

  if (expirMatch) {
    return { nr: nrAuto, rovinieta: { valid: false, expira: null, mesaj: 'Nu există rovignetă activă' }};
  }

  if (validMatch && expMatch) {
    const dataExp = expMatch[expMatch.length - 1];
    return {
      nr: nrAuto,
      rovinieta: {
        valid: true,
        expira: dataExp,
        zileRamase: calcZile(dataExp),
        mesaj: 'Rovignetă activă'
      }
    };
  }

  return { nr: nrAuto, rovinieta: { valid: null, mesaj: 'Verificare manuală necesară — introdu și VIN-ul' }};
}

function formatData(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
  } catch { return dateStr; }
}

function calcZile(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.autoassist.ro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  };
}
