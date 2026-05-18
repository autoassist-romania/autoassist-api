const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const nrAuto = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!nrAuto || nrAuto.length < 4) return res.status(400).json({ error: 'Nr. înmatriculare invalid' });

  const [rca, rovinieta] = await Promise.allSettled([
    verificaRCA(nrAuto),
    verificaRovinieta(nrAuto),
  ]);

  const result = {
    nr: nrAuto,
    judet: getJudet(nrAuto),
    timestamp: new Date().toISOString(),
    rca: rca.status === 'fulfilled' ? rca.value : { error: true, mesaj: 'Eroare RCA' },
    rovinieta: rovinieta.status === 'fulfilled' ? rovinieta.value : { error: true, mesaj: 'Eroare rovignetă' },
    itp: { mesaj: 'Introdu VIN-ul din talon pentru verificare ITP', necesitaVIN: true }
  };

  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');
  if (vin) {
    try { result.itp = await verificaITP(vin); }
    catch(e) { result.itp = { error: true, mesaj: 'Eroare ITP' }; }
  }

  return res.json(result);
};

async function verificaRCA(nr) {
  const initRes = await fetch('https://www.aida.info.ro/polite-rca', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ro-RO', 'Referer': 'https://www.aida.info.ro/', 'Accept': 'text/html' }
  });
  const cookie = extractCookies(initRes.headers.get('set-cookie'));
  const html = await initRes.text();
  const tok = (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1] || '';
  const azi = new Date();
  const data = `${azi.getFullYear()}-${pad(azi.getMonth()+1)}-${pad(azi.getDate())}`;
  const body = new URLSearchParams({ CriteriuCautare: '1', NrInmatriculare: nr, DataVerificare: data, acord: 'true' });
  if (tok) body.set('__RequestVerificationToken', tok);
  const r = await fetch('https://www.aida.info.ro/polite-rca', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.aida.info.ro/polite-rca', 'Origin': 'https://www.aida.info.ro', 'Cookie': cookie },
    body: body.toString()
  });
  const text = await r.text();
  if (text.match(/nu exist[aă]|nu a fost/i)) return { valid: false, mesaj: 'Nu există RCA valid' };
  const dates = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
  const asig = (text.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal)[^<\n]*/i) || [])[0] || null;
  for (const d of dates) {
    const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
    if (dt > new Date()) return { valid: true, expira: d, asigurator: asig?.trim().slice(0,30)||null, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'RCA valid' };
  }
  return dates.length ? { valid: false, expira: dates[0], mesaj: 'RCA expirat' } : { valid: null, mesaj: 'Status RCA nedeterminat' };
}

async function verificaRovinieta(nr) {
  for (const url of [
    `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`,
    `https://www.erovinieta.ro/api/vignettes/${encodeURIComponent(nr)}`
  ]) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.erovinieta.ro/' } });
      if (res.ok) {
        const d = await res.json();
        const items = Array.isArray(d) ? d : (d?.vignettes || d?.items || []);
        if (items.length) {
          const activa = items.find(v => new Date(v.endDate || v.validTo) > new Date());
          if (activa) {
            const dt = new Date(activa.endDate || activa.validTo);
            return { valid: true, expira: `${pad(dt.getDate())}.${pad(dt.getMonth()+1)}.${dt.getFullYear()}`, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'Rovignetă activă' };
          }
          return { valid: false, mesaj: 'Rovignetă expirată' };
        }
      }
    } catch(e) { continue; }
  }
  return { valid: null, mesaj: 'Status rovignetă nedeterminat' };
}

async function verificaITP(vin) {
  try {
    const init = await fetch('https://prog.rarom.ro/rarpol/', { headers: { 'User-Agent': UA } });
    const cookie = extractCookies(init.headers.get('set-cookie'));
    const html = await init.text();
    const vs = (html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/) || [])[1] || '';
    const ev = (html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/) || [])[1] || '';
    const body = new URLSearchParams({ '__VIEWSTATE': vs, '__EVENTVALIDATION': ev, 'ctl00$ContentPlaceHolder1$txtVIN': vin, 'ctl00$ContentPlaceHolder1$txtSerCIV': '', 'ctl00$ContentPlaceHolder1$txtCaptcha': '', 'ctl00$ContentPlaceHolder1$btnCauta': 'Caută' });
    const res = await fetch('https://prog.rarom.ro/rarpol/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://prog.rarom.ro/rarpol/', 'Cookie': cookie },
      body: body.toString()
    });
    const text = await res.text();
    const expMatch = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g);
    if (expMatch) {
      for (const d of expMatch) {
        const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
        if (dt.getFullYear() > 2020) return { valid: dt > new Date(), expira: d, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: dt > new Date() ? 'ITP valabil' : 'ITP expirat' };
      }
    }
    if (text.match(/RESPINS|expirat/i)) return { valid: false, mesaj: 'ITP expirat' };
    if (text.match(/ADMIS|valabil/i)) return { valid: true, mesaj: 'ITP valabil' };
  } catch(e) {}
  return { valid: null, mesaj: 'Verificare ITP indisponibilă', necesitaVIN: true };
}

function getJudet(nr) {
  const m = {'B':'București','AB':'Alba','AR':'Arad','AG':'Argeș','BC':'Bacău','BH':'Bihor','BN':'Bistrița-Năsăud','BT':'Botoșani','BV':'Brașov','BR':'Brăila','BZ':'Buzău','CS':'Caraș-Severin','CL':'Călărași','CJ':'Cluj','CT':'Constanța','CV':'Covasna','DB':'Dâmbovița','DJ':'Dolj','GL':'Galați','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomița','IS':'Iași','IF':'Ilfov','MM':'Maramureș','MH':'Mehedinți','MS':'Mureș','NT':'Neamț','OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Sălaj','SB':'Sibiu','SV':'Suceava','TR':'Teleorman','TM':'Timiș','TL':'Tulcea','VS':'Vaslui','VL':'Vâlcea','VN':'Vrancea'};
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}
function extractCookies(h) { return h ? h.split(',').map(c=>c.split(';')[0].trim()).join('; ') : ''; }
function pad(n) { return String(n).padStart(2,'0'); }
