/*
 * Échanges avec le serveur : API HTTP (JSON) et WebSocket du salon.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const listeners = { unauthorized: [] };

export function onUnauthorized(fn) {
  listeners.unauthorized.push(fn);
}

export async function api(method, path, body, { keepalive = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin', keepalive };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('Serveur injoignable. Vérifie la connexion au réseau.', 0);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) || 'Erreur ' + res.status;
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me/password')) {
      for (const fn of listeners.unauthorized) fn();
    }
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const GET = (p) => api('GET', p);
export const POST = (p, b = {}) => api('POST', p, b);
export const PUT = (p, b = {}) => api('PUT', p, b);
export const DELETE = (p) => api('DELETE', p);

/* ---------- WebSocket ---------- */

/**
 * Connexion temps réel, reconnectée automatiquement.
 * Événements : 'status' (connecting | open | closed) et chaque type de message.
 */
export class Socket {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.status = 'closed';
    this.offset = 0; // heure du serveur - heure locale
    this.retry = 0;
    this.stopped = false;
    this.queue = [];
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, data) {
    const set = this.handlers.get(type);
    if (set) for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  }

  setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  connect() {
    this.stopped = false;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    this.setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (typeof msg.now === 'number') this.offset = msg.now - Date.now();
      this.emit(msg.type, msg);
      this.emit('*', msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed');
      if (this.stopped) return;
      if (e.code === 4001) {
        this.emit('kicked', e.reason);
        return;
      }
      const delay = Math.min(8000, 600 * 2 ** this.retry++);
      setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
    };
  }

  send(msg) {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === 1) this.ws.send(s);
    else if (this.queue.length < 20) this.queue.push(s);
  }

  /** Heure du serveur (ms). */
  now() {
    return Date.now() + this.offset;
  }

  close() {
    this.stopped = true;
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
