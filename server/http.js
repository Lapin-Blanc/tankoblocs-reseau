/*
 * Petit serveur HTTP sans framework : routes JSON, fichiers statiques,
 * compression gzip et en-têtes de sécurité.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { UserError } from './auth.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // 'unsafe-eval' : l'entraînement exécute le programme dans le navigateur (new Function)
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};

/* ---------- Routeur ---------- */

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return allowed ? { notAllowed: true } : null;
  }
}

/* ---------- Requêtes et réponses ---------- */

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new UserError('Requête trop volumineuse.', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new UserError('Format de requête attendu : JSON.', 415);
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new UserError('Requête illisible (JSON invalide).');
  }
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
}

export function sendJson(req, res, status, data, extraHeaders) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (body.length > 1024 && acceptsGzip(req)) {
    const gz = zlib.gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(req, res, err) {
  if (err instanceof UserError) {
    sendJson(req, res, err.status, { error: err.message });
    return;
  }
  console.error('[http] erreur', err);
  sendJson(req, res, 500, { error: 'Erreur interne du serveur.' });
}

/* ---------- Fichiers statiques ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);

/**
 * Sert des fichiers depuis plusieurs dossiers montés sur des préfixes d'URL.
 * mounts : [{ prefix: '/vendor/blockly/', dir, allow?: (rel) => boolean }]
 */
export class StaticFiles {
  constructor(mounts) {
    this.mounts = mounts;
    this.gzCache = new Map();
  }

  resolve(pathname) {
    for (const m of this.mounts) {
      if (!pathname.startsWith(m.prefix)) continue;
      let rel;
      try { rel = decodeURIComponent(pathname.slice(m.prefix.length)); } catch { return null; }
      if (rel.includes('\0')) return null;
      const file = path.normalize(path.join(m.dir, rel));
      if (file !== m.dir && !file.startsWith(m.dir + path.sep)) return null;
      if (m.allow && !m.allow(rel)) return null;
      return file;
    }
    return null;
  }

  /** Renvoie true si la requête a été servie. */
  serve(req, res, pathname, fileOverride) {
    const file = fileOverride || this.resolve(pathname);
    if (!file) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const etag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // toujours revalider : une mise à jour du serveur est vue immédiatement
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    if (COMPRESSIBLE.has(ext) && acceptsGzip(req)) {
      let entry = this.gzCache.get(file);
      if (!entry || entry.etag !== etag) {
        entry = { etag, gz: zlib.gzipSync(fs.readFileSync(file), { level: 9 }) };
        this.gzCache.set(file, entry);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = entry.gz.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : entry.gz);
      return true;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }
}

/** Vérifie que la requête vient bien de notre propre page (protection CSRF). */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // navigateurs anciens, outils en ligne de commande
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function clientIp(req) {
  return req.socket.remoteAddress || '?';
}
