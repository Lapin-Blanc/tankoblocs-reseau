/*
 * Outils de test : un serveur sur un port libre, une base en mémoire, et
 * des clients HTTP / WebSocket qui gardent leur cookie de session.
 */
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

export async function startServer(settings = {}) {
  const app = createApp({ dbFile: ':memory:', config: { disconnectGraceMs: 300, recentMatches: 5 } });
  app.db.setSettings({ countdownSec: 1, minDurationSec: 10, ...settings });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = 'http://127.0.0.1:' + port;
  return { app, base, port, close: () => app.close() };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(method, path, body) {
    const headers = { Origin: this.base };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }

  /** Ouvre le WebSocket du salon. */
  async socket() {
    const ws = new WebSocket(this.base.replace('http', 'ws') + '/ws', { headers: { Cookie: this.cookie, Origin: this.base } });
    const sock = new SocketReader(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
    });
    this.ws = sock;
    return sock;
  }
}

/** Mémorise les messages reçus et permet d'en attendre un. */
export class SocketReader {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Attend un message (y compris déjà reçu si `past`). */
  wait(pred, timeoutMs = 5000, past = false) {
    if (typeof pred === 'string') {
      const type = pred;
      pred = (m) => m.type === type;
    }
    if (past) {
      const found = this.messages.find(pred);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('message attendu non reçu')), timeoutMs) };
      this.waiters.push(w);
    });
  }

  close() {
    this.ws.close();
  }
}

/** Crée l'enseignant, un cours et des joueurs ; renvoie les clients connectés. */
export async function setupClass(base, pseudos = ['Alice', 'Bruno']) {
  const prof = new Client(base);
  await prof.post('/api/setup', { pseudo: 'Prof', password: 'secret123' });
  const course = (await prof.post('/api/admin/courses', { name: 'Info du soir' })).data.course;
  const players = [];
  for (const p of pseudos) {
    const c = new Client(base);
    const r = await c.post('/api/register', { pseudo: p, password: 'motdepasse', code: course.code });
    if (r.status !== 201) throw new Error('inscription impossible : ' + JSON.stringify(r.data));
    c.me = r.data.me;
    const t = await c.post('/api/tanks', { name: 'Tank de ' + p, color: '#3498db' });
    c.tank = t.data.tank;
    players.push(c);
  }
  return { prof, course, players };
}
