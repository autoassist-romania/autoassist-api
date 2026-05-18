// api/verificare-rca.js — Vercel Edge Function
// Verificare RCA via AIDA (aida.info.ro) — scraping server-side
// Deploy: push pe GitHub → Vercel auto-deploy

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const nrAuto = searchParams.get('nr')?.toUpperCase().replace(/\s/g, '') || '';

  if (!nrAuto) {
    return new Response(JSON.stringify({ error: 'Nr. înmatriculare lipsă' }), {
      status: 400,
      headers: corsHeaders()
    });
  }

  try {
    // Pasul 1: Obținem token-ul CSRF + cookie de sesiune de la AIDA
    const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Referer': 'https://www.aida.info.ro/',
      }
    });

    const cookies = initRes.headers.get('set-cookie') || '';
    const html = await initRes.text();

    // Extrage token verificare (CSRF sau __RequestVerificationToken)
    const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    const token = tokenMatch ? tokenMatch[1] : '';

    // Pasul 2: Trimite cererea POST cu nr înmatriculare
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const formData = new URLSearchParams({
      'CriteriuCautare': '1', // 1 = dupa nr inmatriculare
      'NrInmatriculare': nrAuto,
      'DataVerificare': today,
      'acord': 'true',
      '__RequestVerificationToken': token
    });

    const searchRes = await fetch('https://www.aida.info.ro/polite-rca', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Referer': 'https://www.aida.info.ro/polite-rca',
        'Cookie': cookies.split(',').map(c => c.split(';')[0]).join('; '),
        'Origin': 'https://www.aida.info.ro',
      },
      body: formData.toString()
    });

    const resultHtml = await searchRes.text();

    // Parsare rezultat
    const result = parseAIDA(resultHtml, nrAuto);
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (err) {
    return new Response(JSON.stringify({ 
      error: 'Eroare verificare RCA', 
      detalii: err.message 
    }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

function parseAIDA(html, nr) {
  // Caută data expirare în tabelul de rezultate
  const validMatch = html.match(/valabil[aă]?\s*p[aâ]n[aă]\s*la[:\s]*([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/i);
  const expMatch = html.match(/([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})/g);
  const asiguratorMatch = html.match(/asigurator[:\s]*([A-ZĂÂÎȘȚ][^\n<]{3,40})/i);
  
  // Verifică dacă există poliță validă
  const arePolita = html.includes('valabil') && !html.includes('nu există');
  const expirată = html.includes('expira') || html.includes('expirată') || html.includes('Nu există');
  
  if (!arePolita && expirată) {
    return {
      nr,
      rca: { valid: false, expira: null, asigurator: null, mesaj: 'Nu există poliță RCA validă' }
    };
  }

  // Extrage prima dată care pare a fi data expirare
  let dataExpirare = null;
  if (expMatch && expMatch.length > 0) {
    // Ia ultima dată găsită care e în viitor
    for (const d of expMatch) {
      const parts = d.split(/[./-]/);
      const data = new Date(parts[2], parts[1]-1, parts[0]);
      if (data > new Date()) {
        dataExpirare = d;
        break;
      }
    }
  }

  return {
    nr,
    rca: {
      valid: arePolita,
      expira: dataExpirare,
      asigurator: asiguratorMatch ? asiguratorMatch[1].trim() : null,
      zileRamase: dataExpirare ? calcZile(dataExpirare) : null,
      mesaj: arePolita ? 'Poliță RCA validă' : 'RCA expirat sau lipsă'
    }
  };
}

function calcZile(dataStr) {
  const parts = dataStr.split(/[./-]/);
  const data = new Date(parts[2], parts[1]-1, parts[0]);
  const azi = new Date();
  return Math.ceil((data - azi) / (1000 * 60 * 60 * 24));
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.autoassist.ro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  };
}
