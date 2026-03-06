/**
 * server.js — Servidor sísmico en tiempo real
 *
 * PROTOCOLO:
 *   WebSocket (app → servidor): stream de muestras del acelerómetro
 *   WebSocket (servidor → dashboard): retransmisión en tiempo real
 *   REST POST /vibration-stream  : fallback si WebSocket no disponible
 *   REST POST /session/start     : iniciar sesión de medición
 *   REST POST /session/end       : cerrar sesión y guardar CSV
 *   REST GET  /sessions          : historial de sesiones
 *   REST GET  /sessions/:id/csv  : descargar CSV de una sesión
 *
 * INSTALACIÓN:
 *   npm install express cors ws uuid
 *
 * USO:
 *   node server.js
 *   Dashboard → http://localhost:3000
 */

const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors     = require('cors');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Directorio para CSVs ────────────────────────────────────────────────────
const CSV_DIR = path.join(__dirname, 'sesiones');
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR);

// ── Estado global en memoria ─────────────────────────────────────────────────
const state = {
  sesionActiva: null,
  sesiones: [],
  ultimasMuestras: [],
  stats: {
    muestrasTotal: 0,
    muestrasSegundo: 0,
    dispositivosConectados: 0,
    alerta: false,
    nivelAlerta: 'NORMAL',
  },
  _contadorSegundo: 0,
};

setInterval(() => {
  state.stats.muestrasSegundo = state._contadorSegundo;
  state._contadorSegundo = 0;
  broadcast('dashboard', { tipo: 'hz', value: state.stats.muestrasSegundo });
}, 1000);

// ── Niveles de alerta ─────────────────────────────────────────────────────────
const UMBRALES = { PRECAUCION: 1.5, PELIGRO: 3.0, CRITICO: 6.0 };

const calcularNivelAlerta = (mag) => {
  if (mag >= UMBRALES.CRITICO)    return 'CRITICO';
  if (mag >= UMBRALES.PELIGRO)    return 'PELIGRO';
  if (mag >= UMBRALES.PRECAUCION) return 'PRECAUCION';
  return 'NORMAL';
};

// ── Clientes WebSocket ────────────────────────────────────────────────────────
const clients = { app: new Set(), dashboard: new Set() };

const send = (ws, obj) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};
const broadcast = (target, obj) => {
  const msg = JSON.stringify(obj);
  clients[target].forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
};

// ── Procesar muestras ─────────────────────────────────────────────────────────
const procesarMuestras = (muestras) => {
  if (!Array.isArray(muestras) || muestras.length === 0) return;

  if (state.sesionActiva) state.sesionActiva.muestras.push(...muestras);

  state.ultimasMuestras.push(...muestras);
  if (state.ultimasMuestras.length > 2000)
    state.ultimasMuestras = state.ultimasMuestras.slice(-2000);

  state.stats.muestrasTotal += muestras.length;
  state._contadorSegundo    += muestras.length;

  let maxMag = 0;
  muestras.forEach(m => {
    const mag = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);
    if (mag > maxMag) maxMag = mag;
  });

  const nivelAnterior = state.stats.nivelAlerta;
  state.stats.nivelAlerta = calcularNivelAlerta(maxMag);
  state.stats.alerta = state.stats.nivelAlerta !== 'NORMAL';

  broadcast('dashboard', {
    tipo: 'muestras',
    muestras,
    stats: state.stats,
    sesion: state.sesionActiva
      ? { id: state.sesionActiva.id, nombre: state.sesionActiva.nombre, inicio: state.sesionActiva.inicio, total: state.sesionActiva.muestras.length }
      : null,
    alertaCambio: state.stats.nivelAlerta !== nivelAnterior ? state.stats.nivelAlerta : null,
  });
};

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let tipo = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.tipo === 'identificar') {
      tipo = msg.rol || 'dashboard';
      clients[tipo].add(ws);
      state.stats.dispositivosConectados = clients.app.size;
      console.log(`[WS] ${tipo.toUpperCase()} conectado — ${ip}`);

      if (tipo === 'dashboard') {
        send(ws, {
          tipo: 'estado_inicial',
          ultimasMuestras: state.ultimasMuestras,
          stats: state.stats,
          sesiones: state.sesiones,
          sesionActiva: state.sesionActiva
            ? { id: state.sesionActiva.id, nombre: state.sesionActiva.nombre, inicio: state.sesionActiva.inicio, total: state.sesionActiva.muestras.length }
            : null,
        });
      }
      return;
    }

    if (msg.tipo === 'muestras')      { procesarMuestras(msg.data); return; }
    if (msg.tipo === 'sesion_inicio') { iniciarSesion(msg.nombre); send(ws, { tipo: 'sesion_iniciada', id: state.sesionActiva?.id }); return; }
    if (msg.tipo === 'sesion_fin')    { const s = cerrarSesion(); send(ws, { tipo: 'sesion_cerrada', sesion: s }); return; }
  });

  ws.on('close', () => {
    if (tipo) clients[tipo].delete(ws);
    state.stats.dispositivosConectados = clients.app.size;
    broadcast('dashboard', { tipo: 'dispositivo_desconectado', stats: state.stats });
    console.log(`[WS] ${tipo || '?'} desconectado`);
  });

  // Auto-identificar como dashboard si no se identifica en 5s
  setTimeout(() => {
    if (tipo) return;
    tipo = 'dashboard';
    clients.dashboard.add(ws);
    send(ws, { tipo: 'estado_inicial', ultimasMuestras: state.ultimasMuestras, stats: state.stats, sesiones: state.sesiones, sesionActiva: null });
  }, 5000);
});

// ── Sesiones ──────────────────────────────────────────────────────────────────
const iniciarSesion = (nombre) => {
  if (state.sesionActiva) cerrarSesion();
  const n = nombre || `Sesión ${new Date().toLocaleString('es-EC')}`;
  state.sesionActiva = { id: uuidv4(), nombre: n, inicio: new Date().toISOString(), muestras: [] };
  broadcast('dashboard', { tipo: 'sesion_iniciada', sesion: { ...state.sesionActiva, muestras: undefined } });
  console.log(`[Sesión] Iniciada: ${n}`);
};

const cerrarSesion = () => {
  if (!state.sesionActiva) return null;
  const s = state.sesionActiva;
  s.fin = new Date().toISOString();
  s.totalMuestras = s.muestras.length;

  const csvPath = path.join(CSV_DIR, `${s.id}.csv`);
  const lineas  = ['timestamp,x,y,z', ...s.muestras.map(m => `${m.t},${m.x},${m.y},${m.z}`)];
  fs.writeFileSync(csvPath, lineas.join('\n'), 'utf8');

  const meta = { id: s.id, nombre: s.nombre, inicio: s.inicio, fin: s.fin, totalMuestras: s.totalMuestras };
  state.sesiones.unshift(meta);
  state.sesionActiva = null;

  broadcast('dashboard', { tipo: 'sesion_cerrada', sesion: meta, sesiones: state.sesiones });
  console.log(`[Sesión] Cerrada: ${meta.nombre} — ${meta.totalMuestras} muestras`);
  return meta;
};

// ── REST ──────────────────────────────────────────────────────────────────────
app.post('/vibration-stream', (req, res) => { procesarMuestras(req.body?.muestras); res.json({ ok: true }); });
app.post('/session/start',    (req, res) => { iniciarSesion(req.body?.nombre); res.json({ ok: true, id: state.sesionActiva?.id }); });
app.post('/session/end',      (req, res) => { res.json({ ok: true, sesion: cerrarSesion() }); });
app.get('/sessions',          (req, res) => { res.json({ ok: true, data: state.sesiones }); });
app.get('/sessions/:id/csv',  (req, res) => {
  const f = path.join(CSV_DIR, `${req.params.id}.csv`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No encontrado' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.csv"`);
  fs.createReadStream(f).pipe(res);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Servidor sísmico — puerto ${PORT}`);
  console.log(`🌐  Dashboard → http://localhost:${PORT}`);
  console.log(`📡  WebSocket → ws://localhost:${PORT}`);
  console.log(`📂  CSVs      → ${CSV_DIR}\n`);
});
