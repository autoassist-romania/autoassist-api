const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

module.exports = async function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!vin && !nr) return res.status(400).json({ error: 'VIN sau nr. înmatriculare lipsă' });

  if (!vin) return res.json({ valid: null, mesaj: 'Introdu VIN-ul din talon pentru verificare ITP', necesitaVIN: true });

  try {
    const init = await fetch('https://prog.rarom.ro/rarpol/', { headers: { 'User-Agent': UA } });
    const cookie = init.headers.get('set-cookie')?.split(',').map(c=>c.split(';')[0].trim()).join('; ') || '';
    const html = await init.text();
    const vs = (html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/) || [])[1] || '';
    const ev = (html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/) || [])[1] || '';
    const body = new URLSearchParams({ '__VIEWSTATE': vs, '__EVENTVALIDATION': ev, 'ctl00$ContentPlaceHolder1$txtVIN': vin, 'ctl00$ContentPlaceHolder1$txtSerCIV': '', 'ctl00$ContentPlaceHolder1$txtCaptcha': '', 'ctl00$ContentPlaceHolder1$btnCauta': 'Caută' });
    const r = await fetch('https://prog.rarom.ro/rarpol/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://prog.rarom.ro/rarpol/', 'Cookie': cookie },
      body: body.toString()
    });
    const text = await r.text();
    const expMatch = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g);
    if (expMatch) {
      for (const d of expMatch) {
        const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
        if (dt.getFullYear() > 2020) return res.json({ valid: dt > new Date(), expira: d, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: dt > new Date() ? 'ITP valabil' : 'ITP expirat' });
      }
    }
    if (text.match(/RESPINS|expirat/i)) return res.json({ valid: false, mesaj: 'ITP expirat' });
    if (text.match(/ADMIS|valabil/i)) return res.json({ valid: true, mesaj: 'ITP valabil' });
    return res.json({ valid: null, mesaj: 'Verificare ITP indisponibilă (CAPTCHA)', necesitaVIN: true });
  } catch(e) {
    return res.status(500).json({ error: 'Eroare verificare ITP', detalii: e.message });
  }
};
