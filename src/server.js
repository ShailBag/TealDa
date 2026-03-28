'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { KotakMonitor } = require('./services/kotak/kotakMonitor');

const PORT = Number(process.env.PORT || 3000);
const clientDist = path.join(__dirname, '../client/dist');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

app.use(express.static(clientDist));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const monitor = new KotakMonitor(process.env, io);

io.on('connection', (socket) => {
  try {
    socket.emit('dashboard', monitor.getSnapshot());
  } catch (_) {
    socket.emit('dashboard', { loginOk: false, lastError: 'warming up' });
  }
});

app.get('/api/debug/indices', (_req, res) => {
  res.json({
    cache: monitor.indexLtpCache || null,
    lastIndexTicks: monitor.lastIndexTicks || []
  });
});

monitor
  .start()
  .catch((err) => {
    console.error('[kotak]', err.message);
    io.emit('dashboard', {
      ts: Date.now(),
      loginOk: false,
      lastError: err.message,
      connections: { hsi: false, hsm: false },
      buy: null,
      sell: null,
      pnl: null,
      indices: { nifty: null, sensex: null }
    });
  });

process.on('SIGINT', () => {
  monitor.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  monitor.stop();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log('[server] http://localhost:' + PORT);
});
