const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

module.exports = async function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!nr) return res.status(400).json({ error: 'Nr. înmatriculare lipsă' });

  try {
    const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ro-RO', 'Referer': 'https://www.aida.info.ro/' }
    });
    const cookie = initRes.headers.get('set-cookie')?.split(',').map(c=>c.split(';')[0].trim()).join('; ') || '';
    const html = await initRes.text();
    const tok = (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1] || '';
    const azi = new Date();
    const body = new URLSearchParams({
      CriteriuCautare: '1', NrInmatriculare: nr,
      DataVerificare: `${azi.getFullYear()}-${String(azi.getMonth()+1).padStart(2,'0')}-${String(azi.getDate()).padStart(2,'0')}`,
      acord: 'true'
    });
    if (tok) body.set('__RequestVerificationToken', tok);
    const r = await fetch('https://www.aida.info.ro/polite-rca', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.aida.info.ro/polite-rca', 'Origin': 'https://www.aida.info.ro', 'Cookie': cookie },
      body: body.toString()
    });
    const text = await r.text();
    if (text.match(/nu exist[aă]|nu a fost/i)) return res.json({ valid: false, mesaj: 'Nu există RCA valid' });
    const dates = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    const asig = (text.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal)[^<\n]*/i) || [])[0] || null;
    for (const d of dates) {
      const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
      if (dt > new Date()) return res.json({ valid: true, expira: d, asigurator: asig?.trim().slice(0,30)||null, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'RCA valid' });
    }
    return res.json(dates.length ? { valid: false, expira: dates[0], mesaj: 'RCA expirat' } : { valid: null, mesaj: 'Status nedeterminat' });
  } catch(e) {
    return res.status(500).json({ error: 'Eroare verificare RCA', detalii: e.message });
  }
};
