/*
 * Vue de l'arène : dessin (ArenaRenderer de TankoBlocs), tableau des tanks,
 * journal et superpositions (décompte, résultats).
 *
 * Trois sources possibles pour ce qu'on affiche :
 *  - LiveSource   : images reçues du serveur pendant un combat en direct ;
 *  - ReplaySource : toutes les images d'un combat terminé (lecture, pause, curseur) ;
 *  - LocalSource  : une partie calculée dans le navigateur (entraînement).
 */
import { h, fill, clear, clock, dot } from './ui.js';

const E = window.TankEngine;
const C = E.C;
const TICK_MS = 1000 / C.TICKS_PER_SECOND;
const DEG = Math.PI / 180;

let audio = null;
export function getAudio() {
  if (!audio) {
    audio = new window.TankAudio();
    try { audio.setEnabled(localStorage.getItem('tbr.sound') !== 'false'); } catch { /* ignoré */ }
  }
  return audio;
}

/* ---------- Partie « fantôme » reconstruite à partir des images ---------- */

function makeGhost(header) {
  return {
    tick: 0,
    maxTicks: header.maxTicks,
    finished: false,
    tanks: header.tanks.map((t) => ({
      index: t.index, name: t.name, color: t.color,
      x: 0, y: 0, heading: 0, gun: 0, radar: 0, px: 0, py: 0, ph: 0, pg: 0, pr: 0,
      health: C.MAX_HEALTH, alive: true, broken: false, radarOn: true, cooldown: 0, damageDealt: 0,
      bubble: null, queue: [], lastMask: 0,
    })),
    bullets: [],
    fx: [],
  };
}

/**
 * Applique une image. snap : sans interpolation (saut dans le temps).
 * Renvoie la liste des effets (tirs, explosions…) de cette image.
 */
function applyFrame(g, f, snap) {
  for (let i = 0; i < g.tanks.length; i++) {
    const t = g.tanks[i];
    const a = f.t[i];
    if (!a) continue;
    t.px = t.x; t.py = t.y; t.ph = t.heading; t.pg = t.gun; t.pr = t.radar;
    t.x = a[0]; t.y = a[1]; t.heading = a[2]; t.gun = a[3]; t.radar = a[4];
    t.health = a[5];
    t.alive = !!(a[6] & 1);
    t.broken = !!(a[6] & 2);
    t.radarOn = !!(a[6] & 4);
    t.cooldown = a[7];
    t.damageDealt = a[8];
    t.bubble = a[9] ? { text: a[9] } : null;
    if (snap) { t.px = t.x; t.py = t.y; t.ph = t.heading; t.pg = t.gun; t.pr = t.radar; }
  }
  g.bullets = f.b.map((b) => {
    const vx = Math.cos(b[2] * DEG) * C.BULLET_SPEED;
    const vy = Math.sin(b[2] * DEG) * C.BULLET_SPEED;
    return { x: b[0], y: b[1], px: snap ? b[0] : b[0] - vx, py: snap ? b[1] : b[1] - vy, vx, vy, owner: b[3] };
  });
  g.tick = f.k;
  return f.f || [];
}

/* ---------- Vue ---------- */

export class ArenaView {
  /**
   * @param {object} opts { meId, showLog, logTitle, compact }
   */
  constructor({ meId = null, showLog = true, logTitle = 'Journal', logHint = '' } = {}) {
    this.meId = meId;
    this.canvas = h('canvas', { class: 'arena-canvas', role: 'img', 'aria-label': 'Arène de combat' });
    this.overlay = h('div', { class: 'arena-overlay', hidden: true });
    this.wrap = h('div', { class: 'canvas-wrap' }, this.canvas, this.overlay);
    this.hudTitle = h('span', { class: 'hud-title' });
    this.hudState = h('span', { class: 'hud-state' });
    this.hudExtra = h('span', { class: 'hud-extra' });
    this.hudTime = h('span', { class: 'hud-time', title: 'Temps restant' }, '0:00');
    this.hud = h('div', { class: 'hud' }, this.hudTitle, this.hudState, this.hudExtra, this.hudTime);
    this.transport = h('div', { class: 'arena-transport' });
    this.board = h('div', { class: 'board' });
    this.logList = h('ol', { class: 'log' });
    this.logEmpty = h('p', { class: 'hint' }, logHint || 'Les messages de ton tank (blocs « afficher » et « dire ») apparaîtront ici.');
    this.logBox = h('section', { class: 'card log-card', hidden: !showLog }, h('h3', null, logTitle), this.logEmpty, this.logList);
    this.side = h('aside', { class: 'arena-side' },
      h('section', { class: 'card board-card' }, h('h3', null, 'Tanks'), this.board), this.logBox);
    this.el = h('div', { class: 'arena-view' },
      h('div', { class: 'arena-stage' }, this.hud, this.wrap, this.transport), this.side);

    this.renderer = new window.ArenaRenderer(this.canvas);
    this.match = null;
    this.info = [];
    this.source = null;
    this.raf = 0;
    this.last = 0;
    this.boardAt = 0;
    this.ro = new ResizeObserver(() => this.fit());
  }

  mount(parent) {
    parent.appendChild(this.el);
    this.ro.observe(this.wrap);
    this.fit();
    this.last = performance.now();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    if (this.source && this.source.destroy) this.source.destroy();
    this.source = null;
    this.el.remove();
  }

  fit() {
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const aspect = window.ArenaRenderer.aspect;
    let w = r.width;
    let hh = w / aspect;
    if (hh > r.height) {
      hh = r.height;
      w = hh * aspect;
    }
    this.canvas.style.width = Math.floor(w) + 'px';
    this.canvas.style.height = Math.floor(hh) + 'px';
    this.renderer.resize();
  }

  /**
   * Partie à dessiner et description des tanks pour le tableau.
   * info : [{ name, color, sub, mine, bot }]
   */
  attach(match, info) {
    this.match = match;
    this.renderer.attach(match);
    if (info) this.info = info;
    this.buildBoard();
  }

  setSource(src) {
    if (this.source && this.source.destroy && this.source !== src) this.source.destroy();
    this.source = src;
  }

  consume(fx, speed = 1) {
    if (!fx || !fx.length) return;
    this.renderer.consumeFx(fx);
    getAudio().play(fx, speed);
  }

  frame(now) {
    const dt = Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    let alpha = 1;
    let speed = 0;
    if (this.source) {
      alpha = this.source.advance(dt);
      speed = this.source.moving ? (this.source.speed || 1) : 0;
    }
    this.renderer.update((dt * speed) / TICK_MS);
    this.renderer.draw(alpha);
    if (this.match) {
      this.hudTime.textContent = clock((this.match.maxTicks || 0) - this.match.tick);
      if (now - this.boardAt > 120) {
        this.boardAt = now;
        this.updateBoard();
      }
    }
    if (this.source && this.source.onFrame) this.source.onFrame();
  }

  setTitle(text) { this.hudTitle.textContent = text || ''; }
  setState(text, cls) {
    this.hudState.textContent = text || '';
    this.hudState.className = 'hud-state' + (cls ? ' ' + cls : '');
  }
  setExtra(...nodes) { fill(this.hudExtra, ...nodes); }

  /* ----- Tableau des tanks ----- */

  buildBoard() {
    clear(this.board);
    this.rows = [];
    if (!this.match) return;
    this.match.tanks.forEach((t, i) => {
      const inf = this.info[i] || {};
      const bar = h('span', { class: 'hp-fill', style: { background: t.color } });
      const hp = h('span', { class: 'hp-text' });
      const dmg = h('span', { class: 'dmg', title: 'Dégâts infligés' });
      const status = h('span', { class: 'tank-status' });
      const row = h('div', { class: 'board-row' + (inf.mine ? ' mine' : '') },
        dot(t.color, true),
        h('div', { class: 'board-info' },
          h('div', { class: 'board-name' }, inf.bot ? '🤖 ' : '', t.name, inf.mine ? h('span', { class: 'badge you' }, 'toi') : null),
          inf.sub ? h('div', { class: 'board-sub' }, inf.sub) : null,
          h('div', { class: 'hp' }, bar, hp)),
        h('div', { class: 'board-score' }, dmg, status));
      this.board.appendChild(row);
      this.rows.push({ bar, hp, dmg, status, row });
    });
    this.updateBoard();
  }

  updateBoard() {
    if (!this.match || !this.rows) return;
    this.match.tanks.forEach((t, i) => {
      const r = this.rows[i];
      if (!r) return;
      const pct = Math.max(0, Math.min(100, t.health));
      r.bar.style.width = pct + '%';
      r.hp.textContent = Math.round(t.health) + ' PV';
      r.dmg.textContent = '💥 ' + t.damageDealt;
      r.status.textContent = !t.alive ? '💀' : t.broken ? '⚠' : '';
      r.status.title = !t.alive ? 'Détruit' : t.broken ? 'Programme en panne' : '';
      r.row.classList.toggle('dead', !t.alive);
    });
  }

  /* ----- Journal ----- */

  addLogs(entries) {
    if (!entries || !entries.length) return;
    const names = this.match ? this.match.tanks : [];
    const atBottom = this.logList.scrollHeight - this.logList.scrollTop - this.logList.clientHeight < 30;
    for (const e of entries) {
      const t = names[e.tank];
      this.logList.appendChild(h('li', { class: 'log-' + (e.kind || 'log') },
        h('span', { class: 'log-time' }, (e.tick / 60).toFixed(1).replace('.', ',') + ' s'),
        t ? dot(t.color) : null,
        t ? h('b', null, t.name + ' ') : null,
        h('span', null, e.text)));
    }
    while (this.logList.children.length > 400) this.logList.firstChild.remove();
    this.logEmpty.hidden = this.logList.children.length > 0;
    if (atBottom) this.logList.scrollTop = this.logList.scrollHeight;
  }

  clearLogs() {
    clear(this.logList);
    this.logEmpty.hidden = false;
  }

  /* ----- Superposition ----- */

  showOverlay(...nodes) {
    if (!nodes.length || nodes[0] === null) {
      this.overlay.hidden = true;
      clear(this.overlay);
      return;
    }
    fill(this.overlay, h('div', { class: 'overlay-box' }, ...nodes));
    this.overlay.hidden = false;
  }
}

/** Informations du tableau à partir de l'en-tête d'un combat du serveur. */
export function headerInfo(header, meId) {
  return header.tanks.map((t) => ({
    name: t.name,
    color: t.color,
    bot: !!t.bot,
    mine: meId !== null && t.userId === meId,
    sub: t.bot ? 'bot d\'entraînement' : t.tankName,
  }));
}

/* ---------- Sources ---------- */

/** Combat en direct : les images arrivent du serveur, on les joue avec un léger retard pour lisser. */
export class LiveSource {
  constructor(view, header) {
    this.view = view;
    this.ghost = makeGhost(header);
    view.attach(this.ghost, headerInfo(header, view.meId));
    this.buffer = [];
    this.playhead = 0;
    this.started = false;
    this.moving = false;
    this.speed = 1;
  }

  push(frame, late) {
    if (late || !this.started) {
      applyFrame(this.ghost, frame, true);
      this.playhead = frame.k;
      this.started = true;
      this.buffer = [];
      return;
    }
    this.buffer.push(frame);
    if (this.buffer.length > 240) {
      // très en retard (onglet en arrière-plan) : on saute directement à la fin
      const f = this.buffer.pop();
      this.buffer = [];
      applyFrame(this.ghost, f, true);
      this.playhead = f.k;
    }
  }

  advance(dt) {
    if (!this.started) return 1;
    const newest = this.buffer.length ? this.buffer[this.buffer.length - 1].k : this.ghost.tick;
    const lag = newest - this.playhead;
    let rate = 1;
    if (lag > 6) rate = 1.3;
    else if (lag < 2) rate = 0.85;
    this.playhead = Math.min(newest, this.playhead + (dt / TICK_MS) * rate);
    while (this.buffer.length && this.buffer[0].k <= Math.floor(this.playhead)) {
      const f = this.buffer.shift();
      this.view.consume(applyFrame(this.ghost, f, false), 1);
    }
    this.moving = this.buffer.length > 0 || lag > 0;
    return Math.max(0, Math.min(1, this.playhead - this.ghost.tick));
  }

  /** Joue immédiatement les images en attente (fin de combat). */
  flush() {
    for (const f of this.buffer) this.view.consume(applyFrame(this.ghost, f, false), 1);
    this.buffer = [];
  }
}

/** Combat terminé : toutes les images sont connues. */
export class ReplaySource {
  constructor(view, header, frames, { onTick, onEnd } = {}) {
    this.view = view;
    this.frames = frames;
    this.ghost = makeGhost(header);
    this.info = headerInfo(header, view.meId);
    this.i = 0;
    this.acc = 0;
    this.playing = false;
    this.speed = 1;
    this.moving = false;
    this.onTick = onTick;
    this.onEnd = onEnd;
    this.seek(0);
  }

  get length() { return this.frames.length; }

  seek(k) {
    k = Math.max(0, Math.min(this.frames.length - 1, k | 0));
    this.view.attach(this.ghost, this.info);
    applyFrame(this.ghost, this.frames[k], true);
    this.i = k;
    this.acc = 0;
    if (this.onTick) this.onTick(this.i);
  }

  play() {
    if (this.i >= this.frames.length - 1) this.seek(0);
    this.playing = true;
  }

  pause() { this.playing = false; }

  step() {
    this.playing = false;
    if (this.i < this.frames.length - 1) {
      this.i++;
      this.view.consume(applyFrame(this.ghost, this.frames[this.i], false), 1);
      if (this.onTick) this.onTick(this.i);
    }
  }

  advance(dt) {
    this.moving = this.playing;
    if (!this.playing) return 1;
    this.acc += dt * this.speed;
    let n = 0;
    while (this.acc >= TICK_MS && n < 40) {
      this.acc -= TICK_MS;
      n++;
      if (this.i >= this.frames.length - 1) break;
      this.i++;
      this.view.consume(applyFrame(this.ghost, this.frames[this.i], false), this.speed);
    }
    if (n && this.onTick) this.onTick(this.i);
    if (this.i >= this.frames.length - 1) {
      this.playing = false;
      this.moving = false;
      if (this.onEnd) this.onEnd();
      return 1;
    }
    return this.acc / TICK_MS;
  }
}

/** Entraînement : partie calculée dans le navigateur, avec le vrai moteur. */
export class LocalSource {
  constructor(view, match, info, { onEnd, onLog } = {}) {
    this.view = view;
    this.match = match;
    view.attach(match, info);
    this.acc = 0;
    this.running = false;
    this.speed = 1;
    this.moving = false;
    this.onEnd = onEnd;
    this.onLog = onLog;
    this.flushFx();
  }

  play() { if (!this.match.finished) this.running = true; }
  pause() { this.running = false; }

  stepOnce() {
    this.running = false;
    this.tick();
  }

  tick() {
    if (this.match.finished) return;
    this.match.step();
    this.flushFx();
    if (this.match.finished) {
      this.running = false;
      if (this.onEnd) this.onEnd(this.match.results);
    }
  }

  flushFx() {
    const fx = this.match.fx;
    if (!fx.length) return;
    this.match.fx = [];
    this.view.consume(fx, this.speed);
  }

  advance(dt) {
    this.moving = this.running;
    if (!this.running) return 1;
    this.acc += dt * this.speed;
    const maxSteps = Math.max(3, Math.ceil(this.speed * 3));
    let n = 0;
    while (this.acc >= TICK_MS && n < maxSteps && this.running) {
      this.acc -= TICK_MS;
      n++;
      this.tick();
    }
    if (n >= maxSteps) this.acc = Math.min(this.acc, TICK_MS);
    return this.running ? this.acc / TICK_MS : 1;
  }
}

/** Tableau des résultats (fin de combat). */
export function resultsTable(results, meId) {
  const rows = results.ranking.map((r) => h('tr', { class: (r.userId && r.userId === meId ? 'mine' : '') + (results.winner === r.index ? ' winner' : '') },
    h('td', { class: 'num' }, results.winner === r.index ? '🏆' : String(r.rank)),
    h('td', null, dot(r.color), ' ', h('b', null, r.name), r.bot ? h('span', { class: 'muted' }, ' 🤖') : null,
      r.tankName && !r.bot ? h('div', { class: 'muted small' }, r.tankName) : null),
    h('td', { class: 'num' }, String(r.damageDealt)),
    h('td', { class: 'num' }, r.alive ? String(r.health) : '💀'),
    h('td', { class: 'num' }, r.shots ? r.hits + '/' + r.shots : '0'),
    h('td', { class: 'small' }, r.broken ? h('span', { class: 'error-text', title: r.error || '' }, '⚠ ' + (r.error || 'en panne')) : '')));
  return h('table', { class: 'results' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Tank'), h('th', { class: 'num' }, 'Dégâts'), h('th', { class: 'num' }, 'Santé'), h('th', { class: 'num' }, 'Tirs'), h('th', null, ''))),
    h('tbody', null, rows));
}
