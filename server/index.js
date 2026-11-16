/*
 * TankoBlocs Réseau : point d'entrée du serveur.
 *
 *   node server/index.js        (ou : npm start)
 *
 * Variables d'environnement : voir README.md (PORT, DATA_DIR…).
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';
import { Db } from './db.js';
import { Store } from './store.js';
import { Sessions, parseCookies, COOKIE } from './auth.js';
import { Router, StaticFiles, sendJson, sendError, sameOrigin, SECURITY_HEADERS } from './http.js';
import { registerApi } from './api.js';
import { Lobby } from './lobby.js';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Fichiers de Blockly servis au navigateur (rien d'autre dans node_modules). */
const BLOCKLY_FILES = new Set(['blockly_compressed.js', 'blocks_compressed.js', 'javascript_compressed.js', 'msg/fr.js']);

/**
 * Crée le serveur (sans l'écouter).
 * @param {object} [opts] { dbFile, config }
 */
export function createApp(opts = {}) {
  const cfg = { ...config, ...(opts.config || {}) };
  const db = new Db(opts.dbFile || path.join(cfg.dataDir, 'tankoblocs.sqlite'));
  const store = new Store(db);
  store.markInterrupted();
  const sessions = new Sessions(db, cfg.sessionDays);
  sessions.purge();
  const lobby = new Lobby({ store, db, config: cfg });

  const router = new Router();
  registerApi(router, { db, store, sessions, lobby, version: PKG.version });

  const blocklyDir = path.join(ROOT, 'node_modules', 'blockly');
  const statics = new StaticFiles([
    { prefix: '/vendor/blockly/', dir: blocklyDir, allow: (rel) => BLOCKLY_FILES.has(rel) || /^media\/[\w.-]+$/.test(rel) },
    { prefix: '/vendor/tankoblocs/', dir: path.join(ROOT, 'vendor', 'tankoblocs'), allow: (rel) => /^(js\/[\w-]+\.js|guide\.(html|css)|VERSION\.json)$/.test(rel) },
    { prefix: '/', dir: path.join(ROOT, 'public') },
  ]);
  const indexFile = path.join(ROOT, 'public', 'index.html');

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
          sendJson(req, res, 403, { error: 'Requête refusée (origine inconnue).' });
          return;
        }
        const route = router.match(req.method, pathname);
        if (!route) {
          sendJson(req, res, 404, { error: 'Adresse inconnue.' });
          return;
        }
        if (route.notAllowed) {
          sendJson(req, res, 405, { error: 'Méthode non permise.' });
          return;
        }
        await route.handler(req, res, route.params, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, SECURITY_HEADERS);
        res.end();
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        if (statics.serve(req, res, pathname, indexFile)) return;
      } else if (statics.serve(req, res, pathname)) {
        return;
      }
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page introuvable');
    } catch (err) {
      if (!res.headersSent) sendError(req, res, err);
      else res.destroy();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => {
      socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\n\r\n');
      socket.destroy();
    };
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { reject(400, 'Bad Request'); return; }
    if (pathname !== '/ws') { reject(404, 'Not Found'); return; }
    if (!sameOrigin(req)) { reject(403, 'Forbidden'); return; }
    const user = sessions.user(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) { reject(401, 'Unauthorized'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => lobby.connect(ws, user));
  });

  function close() {
    lobby.shutdown();
    wss.close();
    server.close();
    server.closeAllConnections?.();
    db.close();
  }

  return { server, db, store, sessions, lobby, close, config: cfg };
}

/** Adresses où les élèves peuvent joindre le serveur. */
function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + port);
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.server.listen(config.port, config.host, () => {
    console.log('TankoBlocs Réseau ' + PKG.version + ' : prêt sur le port ' + config.port);
    const addrs = lanAddresses(config.port);
    if (addrs.length && !process.env.IN_DOCKER) console.log('Les joueurs peuvent ouvrir : ' + addrs.join('  ou  '));
    if (process.env.IN_DOCKER) console.log('Les joueurs ouvrent http://<adresse de cet ordinateur>:' + (process.env.PUBLIC_PORT || config.port));
    if (app.store.countUsers() === 0) console.log('Premier lancement : ouvrez la page pour créer le compte enseignant.');
  });
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log('Arrêt (' + sig + ')…');
    app.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
