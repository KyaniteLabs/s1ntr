/**
 * Start Studio backend only.
 * Canonical full Studio command: pnpm gui
 * Backend-only usage: node gui/start.js
 * Env: PORT=5174 (default), SINTER_CONFIG_PATH optional. SINTER_* names win;
 * the legacy LIMINAL_* names still work.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brandEnv = (key) => process.env[`SINTER_${key}`] ?? process.env[`LIMINAL_${key}`];
const staticDir = brandEnv('STUDIO_STATIC_DIR')
  ? path.resolve(brandEnv('STUDIO_STATIC_DIR'))
  : path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 5174;

const app = createApp(undefined, PORT);

// In development, Vite runs separately and proxies /api to this server; in production we could serve static from gui/dist
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

if (fs.existsSync(path.join(staticDir, 'index.html'))) {
  app.use(express.static(staticDir));
  app.get(/^\/(?!api\/|preview\b).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

const HOST = brandEnv('GUI_HOST') || '127.0.0.1';
const loopbackHost = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
if (!loopbackHost && !brandEnv('GUI_TOKEN')) {
  console.error(`Refusing to bind Studio to ${HOST} without SINTER_GUI_TOKEN.`);
  console.error('Set a token, or leave SINTER_GUI_HOST unset for loopback-only.');
  process.exit(1);
}
function failToListen(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on ${HOST}. Stop the other process or set PORT to a free port.`);
  } else {
    console.error(`Studio backend could not listen on ${HOST}:${PORT}: ${err.message}`);
  }
  process.exit(1);
}

// Express 5 also calls this callback with the listen error, so a busy port
// must be handled here before the banner, not only in the 'error' handler.
const server = app.listen(PORT, HOST, (err) => {
  if (err) failToListen(err);
  console.log(`Sinter GUI backend: http://${HOST}:${PORT}`);
  console.log(`  GET  /api/config`);
  console.log(`  POST /api/config`);
  console.log(`  GET  /api/gallery`);
  console.log(`  GET  /api/gallery/:project`);
  console.log(`  POST /api/preview/run`);
  console.log(`  POST /api/run`);
  console.log(`  POST /api/live-music/music`);
  console.log(`  POST /api/live-music/visuals`);
  console.log(`  GET  /preview?version=N`);
  console.log(`  GET  /api/health`);
  console.log(`\nFull Studio: pnpm gui`);
  if (fs.existsSync(path.join(staticDir, 'index.html'))) {
    console.log(`Static Studio frontend: ${staticDir}`);
  } else {
    console.log(`Backend-only mode is active; run the frontend separately with: cd gui && npm run dev`);
  }
});

// A busy port must fail loudly: otherwise the banner claims the backend is up
// while nothing is listening.
server.on('error', failToListen);

// Handle shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
