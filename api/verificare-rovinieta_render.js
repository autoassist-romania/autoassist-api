const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

module.exports = async function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!nr) return res.status(400).json({ error: 'Nr. înmatriculare lipsă' });

  try {
    for (const url of [
      `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`,
      `https://www.erovinieta.ro/api/vignettes/${encodeURIComponent(nr)}`
    ]) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.erovinieta.ro/' } });
        if (r.ok) {
          const d = await r.json();
          const items = Array.isArray(d) ? d : (d?.vignettes || d?.items || []);
          if (items.length) {
            const activa = items.find(v => new Date(v.endDate || v.validTo) > new Date());
            if (activa) {
              const dt = new Date(activa.endDate || activa.validTo);
              const pad = n => String(n).padStart(2,'0');
              return res.json({ valid: true, expira: `${pad(dt.getDate())}.${pad(dt.getMonth()+1)}.${dt.getFullYear()}`, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'Rovignetă activă' });
            }
            return res.json({ valid: false, mesaj: 'Rovignetă expirată' });
          }
        }
      } catch(e) { continue; }
    }
    return res.json({ valid: null, mesaj: 'Status rovignetă nedeterminat' });
  } catch(e) {
    return res.status(500).json({ error: 'Eroare verificare rovignetă', detalii: e.message });
  }
};
