// api/verificare-itp.js — Vercel Edge Function
// Verificare ITP via RAR (prog.rarom.ro) — necesită VIN sau CIV
// + date tehnice vehicul (marca, model, an) via DRPCIV

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const nrAuto = searchParams.get('nr')?.toUpperCase().replace(/\s/g, '') || '';
  const vin = searchParams.get('vin')?.toUpperCase().replace(/\s/g, '') || '';
  const civ = searchParams.get('civ')?.toUpperCase().replace(/\s/g, '') || '';

  if (!nrAuto && !vin && !civ) {
    return new Response(JSON.stringify({ error: 'Nr. înmatriculare sau VIN lipsă' }), {
      status: 400, headers: corsHeaders()
    });
  }

  try {
    // Strategia: încearcă să obținem VIN din DRPCIV dacă nu îl avem
    let vinFinal = vin;
    let dateTehnice = {};

    // Pasul 1: Date tehnice vehicul din DRPCIV (dacă avem nr auto)
    if (nrAuto) {
      try {
        dateTehnice = await getDateVehicul(nrAuto);
        if (dateTehnice.vin) vinFinal = dateTehnice.vin;
      } catch(e) { /* continua fara date tehnice */ }
    }

    // Pasul 2: Verificare ITP la RAR — necesită VIN sau CIV
    let itpResult = { valid: null, expira: null, mesaj: 'VIN necesar pentru verificare ITP' };
    
    if (vinFinal || civ) {
      itpResult = await verificaITPRar(vinFinal, civ);
    }

    return new Response(JSON.stringify({
      nr: nrAuto,
      ...dateTehnice,
      itp: itpResult
    }), {
      status: 200, headers: corsHeaders()
    });

  } catch (err) {
    return new Response(JSON.stringify({ 
      error: 'Eroare verificare ITP', detalii: err.message 
    }), { status: 500, headers: corsHeaders() });
  }
}

async function getDateVehicul(nrAuto) {
  // DRPCIV — verificare stare înmatriculare + date vehicul
  // Endpoint public, fără CAPTCHA pentru stare înmatriculare
  const url = `https://www.drpciv.ro/prod/epay-query?plateNumber=${encodeURIComponent(nrAuto)}`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.drpciv.ro/',
    }
  });

  if (res.ok) {
    const data = await res.json();
    // DRPCIV returnează date despre vehicul: marca, model, an, VIN
    return {
      marca: data.marca || data.brand || null,
      model: data.model || null,
      an: data.anFabricatie || data.year || null,
      vin: data.vin || data.serialNumber || null,
      combustibil: data.combustibil || data.fuelType || null,
    };
  }
  
  return {};
}

async function verificaITPRar(vin, civ) {
  // RAR — verificare ITP după VIN sau CIV serie
  const searchId = vin || civ;
  const searchType = vin ? 'VIN' : 'CIV';
  
  // Pasul 1: GET pagina RAR pentru a obține sesiune
  const initRes = await fetch('https://prog.rarom.ro/rarpol/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ro-RO,ro;q=0.9',
    }
  });

  const cookies = initRes.headers.get('set-cookie') || '';
  const html = await initRes.text();

  // Extrage CAPTCHA value și eventToken
  // RAR folosește un CAPTCHA simplu bazat pe sesiune, nu pe imagine
  const viewstateMatch = html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/);
  const eventvalMatch = html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/);
  const viewstate = viewstateMatch ? viewstateMatch[1] : '';
  const eventval = eventvalMatch ? eventvalMatch[1] : '';

  // Pasul 2: POST cerere ITP
  const formData = new URLSearchParams({
    '__VIEWSTATE': viewstate,
    '__EVENTVALIDATION': eventval,
    'ctl00$ContentPlaceHolder1$txtSerCIV': searchType === 'CIV' ? searchId : '',
    'ctl00$ContentPlaceHolder1$txtVIN': searchType === 'VIN' ? searchId : '',
    'ctl00$ContentPlaceHolder1$txtCaptcha': '', // CAPTCHA — problema principală
    'ctl00$ContentPlaceHolder1$btnCauta': 'Caută'
  });

  const searchRes = await fetch('https://prog.rarom.ro/rarpol/', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://prog.rarom.ro/rarpol/',
      'Cookie': cookies.split(',').map(c => c.split(';')[0]).join('; '),
    },
    body: formData.toString()
  });

  const resultHtml = await searchRes.text();
  return parseRAR(resultHtml);
}

function parseRAR(html) {
  // Caută data expirare ITP în răspunsul RAR
  const expMatch = html.match(/valabilit[aă][^\d]*([0-9]{2}[.][0-9]{2}[.][0-9]{4})/i);
  const validMatch = html.match(/ADMIS|valid|valabil/i);
  const respinMatch = html.match(/RESPINS|expirat|nu are/i);
  
  if (expMatch) {
    const dataStr = expMatch[1];
    const parts = dataStr.split('.');
    const data = new Date(parts[2], parts[1]-1, parts[0]);
    const valid = data > new Date();
    return {
      valid,
      expira: dataStr,
      zileRamase: Math.ceil((data - new Date()) / (1000 * 60 * 60 * 24)),
      mesaj: valid ? 'ITP valabil' : 'ITP expirat'
    };
  }

  if (respinMatch) return { valid: false, expira: null, mesaj: 'ITP expirat sau lipsă' };
  if (validMatch) return { valid: true, expira: null, mesaj: 'ITP valabil — dată neprecizată' };
  
  return { valid: null, expira: null, mesaj: 'Verificare manuală necesară — VIN invalid sau vehicul nou' };
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.autoassist.ro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  };
}
