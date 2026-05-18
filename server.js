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
app.get('/api/vehicul', require('./api/vehicul'));
app.get('/api/verificare-rca', require('./api/verificare-rca'));
app.get('/api/verificare-itp', require('./api/verificare-itp'));
app.get('/api/verificare-rovinieta', require('./api/verificare-rovinieta'));

app.listen(PORT, () => console.log(`AutoAssist API running on port ${PORT}`));
