const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});
app.options('*', (req, res) => res.status(204).end());
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

try { app.get('/api/vehicul', require('./api/vehicul')); } catch(e) { console.log('vehicul.js:', e.message); }
try { app.get('/api/verificare-rca', require('./api/verificare-rca')); } catch(e) {}
try { app.get('/api/verificare-itp', require('./api/verificare-itp')); } catch(e) {}
try { app.get('/api/verificare-rovinieta', require('./api/verificare-rovinieta')); } catch(e) {}

app.listen(PORT, () => console.log(`AutoAssist API pe portul ${PORT}`));
