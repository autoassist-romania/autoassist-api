// server.js — Express wrapper pentru Render.com
const express = require('express');
const vehiculHandler = require('./api/vehicul');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

app.get('/api/vehicul', (req, res) => vehiculHandler(req, res));
app.options('/api/vehicul', (req, res) => res.status(204).end());

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.listen(PORT, () => console.log(`AutoAssist API running on port ${PORT}`));
