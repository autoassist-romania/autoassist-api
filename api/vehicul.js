module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const nr = (req.query.nr || '').toUpperCase().replace(/\s/g, '');
  if (!nr || nr.length < 4) return res.status(400).json({ error: 'Nr. înmatriculare invalid' });
 
  const result = {
    nr, judet: getJudet(nr), timestamp: new Date().toISOString(),
    rca: null, rovinieta: null,
    itp: { mesaj: 'Introdu VIN-ul din talon pentru verificare ITP', necesitaVIN: true }
  };
 
  const [rca, rov] = await Promise.allSettled([verificaRCA(nr), verificaRovinieta(nr)]);
  result.rca = rca.status === 'fulfilled' ? rca.value : { valid: null, mesaj: 'Eroare RCA' };
  result.rovinieta = rov.status === 'fulfilled' ? rov.value : { valid: null, mesaj: 'Eroare rovignetă' };
 
  const vin = (req.query.vin || '').toUpperCase().replace(/\s/g, '');
  if (vin) {
    try { result.itp = await verificaITP(vin); } catch(e) { result.itp = { valid: null, mesaj: 'Eroare ITP' }; }
  }
 
  return res.json(result);
};
 
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Cache-Control': 'max-age=0',
};
 
async function verificaRCA(nr) {
  try {
    // Sesiune inițială
    const init = await fetch('https://www.aida.info.ro/polite-rca', {
      headers: { ...HEADERS, 'Referer': 'https://www.aida.info.ro/' },
      redirect: 'follow'
    });
    const cookie = extractCookies(init.headers.get('set-cookie'));
    const html = await init.text();
    const tok = (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1] || '';
 
    const azi = new Date();
    const dataFmt = `${azi.getFullYear()}-${pad(azi.getMonth()+1)}-${pad(azi.getDate())}`;
    const body = new URLSearchParams({ CriteriuCautare: '1', NrInmatriculare: nr, DataVerificare: dataFmt, acord: 'true' });
    if (tok) body.set('__RequestVerificationToken', tok);
 
    const r = await fetch('https://www.aida.info.ro/polite-rca', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.aida.info.ro/polite-rca', 'Origin': 'https://www.aida.info.ro', 'Cookie': cookie, 'Sec-Fetch-Site': 'same-origin' },
      body: body.toString(), redirect: 'follow'
    });
    const text = await r.text();
 
    if (text.match(/nu exist[aă]|nu a fost|no result/i)) return { valid: false, mesaj: 'Nu există RCA valid' };
    const dates = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    const asig = (text.match(/(?:Allianz|Groupama|Omniasig|Euroins|Generali|Uniqa|Grawe|Asirom|Signal|Axeria)[^<\n]*/i) || [])[0];
    for (const d of dates) {
      const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
      if (dt > new Date()) return { valid: true, expira: d, asigurator: asig?.trim().slice(0,40)||null, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'RCA valid' };
    }
    return dates.length ? { valid: false, expira: dates[0], mesaj: 'RCA expirat' } : { valid: null, mesaj: 'Status nedeterminat — verifică pe aida.info.ro' };
  } catch(e) { return { valid: null, mesaj: 'Eroare: ' + e.message }; }
}
 
async function verificaRovinieta(nr) {
  // Încerc mai multe endpoint-uri
  const endpoints = [
    `https://api.erovinieta.ro/vignettes?plateNumber=${encodeURIComponent(nr)}&countryCode=RO`,
    `https://www.erovinieta.ro/api/vignettes/${encodeURIComponent(nr)}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { ...HEADERS, 'Accept': 'application/json', 'Referer': 'https://www.erovinieta.ro/', 'Origin': 'https://www.erovinieta.ro' } });
      if (r.ok) {
        const d = await r.json();
        const items = Array.isArray(d) ? d : (d?.vignettes || d?.items || []);
        const activa = items.find(v => new Date(v.endDate || v.validTo) > new Date());
        if (activa) {
          const dt = new Date(activa.endDate || activa.validTo);
          return { valid: true, expira: `${pad(dt.getDate())}.${pad(dt.getMonth()+1)}.${dt.getFullYear()}`, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: 'Rovignetă activă' };
        }
        return items.length ? { valid: false, mesaj: 'Rovignetă expirată' } : { valid: false, mesaj: 'Nu există rovignetă' };
      }
    } catch(e) { continue; }
  }
  return { valid: null, mesaj: 'Verificare manuală pe erovinieta.ro' };
}
 
async function verificaITP(vin) {
  try {
    const init = await fetch('https://prog.rarom.ro/rarpol/', { headers: HEADERS });
    const cookie = extractCookies(init.headers.get('set-cookie'));
    const html = await init.text();
    const vs = (html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/) || [])[1] || '';
    const ev = (html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/) || [])[1] || '';
    const body = new URLSearchParams({ '__VIEWSTATE': vs, '__EVENTVALIDATION': ev, 'ctl00$ContentPlaceHolder1$txtVIN': vin, 'ctl00$ContentPlaceHolder1$txtSerCIV': '', 'ctl00$ContentPlaceHolder1$txtCaptcha': '', 'ctl00$ContentPlaceHolder1$btnCauta': 'Caută' });
    const r = await fetch('https://prog.rarom.ro/rarpol/', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://prog.rarom.ro/rarpol/', 'Cookie': cookie }, body: body.toString() });
    const text = await r.text();
    const dates = text.match(/([0-9]{2}[.][0-9]{2}[.][0-9]{4})/g) || [];
    for (const d of dates) {
      const p = d.split('.'); const dt = new Date(+p[2], +p[1]-1, +p[0]);
      if (dt.getFullYear() > 2020) return { valid: dt > new Date(), expira: d, zileRamase: Math.ceil((dt-new Date())/86400000), mesaj: dt > new Date() ? 'ITP valabil' : 'ITP expirat' };
    }
  } catch(e) {}
  return { valid: null, mesaj: 'ITP necesită VIN valid', necesitaVIN: true };
}
 
function getJudet(nr) {
  const m = {'B':'București','AB':'Alba','AR':'Arad','AG':'Argeș','BC':'Bacău','BH':'Bihor','BN':'Bistrița-Năsăud','BT':'Botoșani','BV':'Brașov','BR':'Brăila','BZ':'Buzău','CS':'Caraș-Severin','CL':'Călărași','CJ':'Cluj','CT':'Constanța','CV':'Covasna','DB':'Dâmbovița','DJ':'Dolj','GL':'Galați','GR':'Giurgiu','GJ':'Gorj','HR':'Harghita','HD':'Hunedoara','IL':'Ialomița','IS':'Iași','IF':'Ilfov','MM':'Maramureș','MH':'Mehedinți','MS':'Mureș','NT':'Neamț','OT':'Olt','PH':'Prahova','SM':'Satu Mare','SJ':'Sălaj','SB':'Sibiu','SV':'Suceava','TR':'Teleorman','TM':'Timiș','TL':'Tulcea','VS':'Vaslui','VL':'Vâlcea','VN':'Vrancea'};
  return m[nr.match(/^([A-Z]{1,2})/)?.[1] || ''] || null;
}
function extractCookies(h) { return h ? h.split(',').map(c=>c.split(';')[0].trim()).join('; ') : ''; }
function pad(n) { return String(n).padStart(2,'0'); }
 
