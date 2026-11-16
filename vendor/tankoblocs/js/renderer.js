/*
 * TankoBlocs — dessin de l'arène (canvas 2D, tout est vectoriel).
 */
(function (root) {
  'use strict';

  const E = root.TankEngine;
  const C = E.C;
  const PAD = 16; // épaisseur du mur dessiné autour de l'arène
  const VIEW_W = C.WIDTH + PAD * 2;
  const VIEW_H = C.HEIGHT + PAD * 2;
  const DEG = Math.PI / 180;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) { return a + E.norm180(b - a) * t; }

  function shade(hex, amount) {
    // amount > 0 éclaircit, < 0 assombrit
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x888888;
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const f = (c) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
    r = f(r); g = f(g); b = f(b);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0x888888;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class ArenaRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = { radar: true, labels: true, debug: false };
      this.match = null;
      this.particles = [];
      this.marks = [];
      this.scans = [];
      this.trackState = new Map();
      this.zones = [];
      this.ground = null;
      this.groundSize = '';
      this.dpr = 1;
      this.scale = 1;
    }

    static get aspect() { return VIEW_W / VIEW_H; }

    attach(match, zones) {
      this.match = match;
      this.zones = zones || [];
      this.particles = [];
      this.marks = [];
      this.scans = [];
      this.trackState = new Map();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(2.5, root.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.dpr = dpr;
      this.scale = Math.min(w / VIEW_W, h / VIEW_H);
      const key = w + 'x' + h;
      if (key !== this.groundSize) {
        this.groundSize = key;
        this.ground = this._buildGround(w, h);
      }
    }

    /* Conversion monde -> coordonnées du canvas (avant mise à l'échelle) */
    X(x) { return x + C.WIDTH / 2 + PAD; }
    Y(y) { return C.HEIGHT / 2 + PAD - y; }

    _buildGround(w, h) {
      const g = document.createElement('canvas');
      g.width = w;
      g.height = h;
      const ctx = g.getContext('2d');
      const s = Math.min(w / VIEW_W, h / VIEW_H);
      ctx.setTransform(s, 0, 0, s, 0, 0);

      // mur extérieur
      ctx.fillStyle = '#0e1517';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      // rayures de sécurité
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, VIEW_W, VIEW_H);
      ctx.rect(PAD, PAD, C.WIDTH, C.HEIGHT);
      ctx.clip('evenodd');
      ctx.strokeStyle = 'rgba(255, 196, 0, 0.13)';
      ctx.lineWidth = 6;
      for (let i = -VIEW_H; i < VIEW_W + VIEW_H; i += 22) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + VIEW_H, VIEW_H);
        ctx.stroke();
      }
      ctx.restore();

      // sol
      const grd = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, 50, VIEW_W / 2, VIEW_H / 2, VIEW_W * 0.65);
      grd.addColorStop(0, '#273632');
      grd.addColorStop(1, '#1b2624');
      ctx.fillStyle = grd;
      ctx.fillRect(PAD, PAD, C.WIDTH, C.HEIGHT);

      // grain du sol (reproductible)
      const rnd = E.makeRandom(1234);
      for (let i = 0; i < 2600; i++) {
        const x = PAD + rnd() * C.WIDTH;
        const y = PAD + rnd() * C.HEIGHT;
        const sz = 1 + rnd() * 2.2;
        ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.07)';
        ctx.fillRect(x, y, sz, sz);
      }
      for (let i = 0; i < 14; i++) {
        const x = PAD + 40 + rnd() * (C.WIDTH - 80);
        const y = PAD + 40 + rnd() * (C.HEIGHT - 80);
        const r = 14 + rnd() * 34;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, 'rgba(0,0,0,0.12)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // quadrillage (tous les 64 px) et axes
      ctx.lineWidth = 1;
      for (let gx = -C.WIDTH / 2 + 64; gx < C.WIDTH / 2; gx += 64) {
        ctx.strokeStyle = gx === 0 ? 'rgba(160, 220, 210, 0.16)' : 'rgba(160, 220, 210, 0.055)';
        ctx.beginPath();
        ctx.moveTo(this.X(gx), PAD);
        ctx.lineTo(this.X(gx), PAD + C.HEIGHT);
        ctx.stroke();
      }
      for (let gy = -C.HEIGHT / 2 + 64; gy < C.HEIGHT / 2; gy += 64) {
        ctx.strokeStyle = gy === 0 ? 'rgba(160, 220, 210, 0.16)' : 'rgba(160, 220, 210, 0.055)';
        ctx.beginPath();
        ctx.moveTo(PAD, this.Y(gy));
        ctx.lineTo(PAD + C.WIDTH, this.Y(gy));
        ctx.stroke();
      }
      // repère au centre
      ctx.strokeStyle = 'rgba(160, 220, 210, 0.22)';
      ctx.beginPath();
      ctx.arc(this.X(0), this.Y(0), 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(160, 220, 210, 0.35)';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText('(0, 0)', this.X(0) + 13, this.Y(0) - 5);
      ctx.fillText('x →', PAD + C.WIDTH - 30, this.Y(0) - 5);
      ctx.fillText('↑ y', this.X(0) + 5, PAD + 14);

      // bord intérieur du mur
      ctx.strokeStyle = '#4f6266';
      ctx.lineWidth = 2;
      ctx.strokeRect(PAD - 1, PAD - 1, C.WIDTH + 2, C.HEIGHT + 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 4;
      ctx.strokeRect(PAD + 2, PAD + 2, C.WIDTH - 4, C.HEIGHT - 4);
      // rivets
      ctx.fillStyle = '#3c4a4e';
      for (const [x, y] of [[PAD / 2, PAD / 2], [VIEW_W - PAD / 2, PAD / 2], [PAD / 2, VIEW_H - PAD / 2], [VIEW_W - PAD / 2, VIEW_H - PAD / 2]]) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      return g;
    }

    /* ----- Effets produits par le moteur ----- */

    consumeFx(list) {
      const m = this.match;
      if (!m) return;
      for (const f of list) {
        const tank = f.tank !== undefined ? m.tanks[f.tank] : null;
        const color = tank ? tank.color : '#ffffff';
        switch (f.t) {
          case 'fire':
            this._burst(f.x, f.y, 6, ['#fff3c4', '#ffb347', color], 1.2, 10, f.angle, 35);
            this.particles.push({ kind: 'flash', x: f.x, y: f.y, life: 0, max: 5, size: 11 });
            break;
          case 'hit':
            this._burst(f.x, f.y, 14, ['#ffffff', '#ffd166', '#ff7b39', color], 2.2, 22);
            this.particles.push({ kind: 'ring', x: f.x, y: f.y, life: 0, max: 14, size: 26, color: '#ffd166' });
            break;
          case 'spark':
            this._burst(f.x, f.y, 7, ['#ffffff', '#ffe08a', color], 1.6, 14);
            break;
          case 'crash':
            this._burst(f.x, f.y, 8, ['#d0d6d8', '#8b979b'], 1.2, 18);
            break;
          case 'explode':
            this._burst(f.x, f.y, 40, ['#ffffff', '#ffe08a', '#ff9f43', '#ff5e3a', '#555'], 3.2, 40);
            this.particles.push({ kind: 'ring', x: f.x, y: f.y, life: 0, max: 26, size: 70, color: '#ffb347' });
            this.particles.push({ kind: 'flash', x: f.x, y: f.y, life: 0, max: 10, size: 45 });
            for (let i = 0; i < 10; i++) this._smoke(f.x, f.y, 1.4);
            this.marks.push({ kind: 'scorch', x: f.x, y: f.y, tick: m.tick, angle: Math.random() * 360 });
            break;
          case 'scan':
            this.scans.push({ x: f.x, y: f.y, color, life: 0, max: 20, kind: f.kind });
            break;
          default:
            break;
        }
      }
    }

    _burst(x, y, n, colors, speed, life, angle, spread) {
      for (let i = 0; i < n; i++) {
        const a = angle === undefined ? Math.random() * 360 : angle + (Math.random() - 0.5) * (spread || 30);
        const v = speed * (0.3 + Math.random());
        this.particles.push({
          kind: 'spark', x, y,
          vx: Math.cos(a * DEG) * v, vy: Math.sin(a * DEG) * v,
          life: 0, max: life * (0.5 + Math.random() * 0.7),
          size: 1.5 + Math.random() * 2.2,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }

    _smoke(x, y, speed) {
      const a = Math.random() * Math.PI * 2;
      const v = (speed || 0.4) * Math.random();
      this.particles.push({
        kind: 'smoke', x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v + 0.15,
        life: 0, max: 60 + Math.random() * 50, size: 6 + Math.random() * 6,
      });
    }

    /** Avance les effets ; dt en « ticks » (peut être fractionnaire). */
    update(dt) {
      if (dt <= 0) return;
      const ps = this.particles;
      for (const p of ps) {
        p.life += dt;
        if (p.vx !== undefined) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.kind === 'spark') { p.vx *= Math.pow(0.9, dt); p.vy *= Math.pow(0.9, dt); }
        }
      }
      this.particles = ps.filter((p) => p.life < p.max);
      for (const s of this.scans) s.life += dt;
      this.scans = this.scans.filter((s) => s.life < s.max);

      const m = this.match;
      if (!m) return;
      // fumée des épaves
      for (const t of m.tanks) {
        if (!t.alive && Math.random() < 0.08 * dt) this._smoke(t.x, t.y, 0.25);
      }
      // traces de chenilles
      for (const t of m.tanks) {
        let st = this.trackState.get(t.index);
        if (!st) { st = { x: t.x, y: t.y, dist: 0, roll: 0 }; this.trackState.set(t.index, st); }
        const d = Math.hypot(t.x - st.x, t.y - st.y);
        if (d > 0) {
          st.dist += d;
          st.roll += d;
          st.x = t.x;
          st.y = t.y;
        }
        if (st.dist > 9) {
          st.dist = 0;
          this.marks.push({ kind: 'track', x: t.x, y: t.y, angle: t.heading, tick: m.tick });
        }
      }
      if (this.marks.length > 1400) this.marks.splice(0, this.marks.length - 1400);
    }

    /* ----- Dessin d'une image ----- */

    draw(alpha) {
      const ctx = this.ctx;
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (this.ground) ctx.drawImage(this.ground, 0, 0);
      const s = this.scale;
      ctx.setTransform(s, 0, 0, s, 0, 0);

      const m = this.match;
      if (!m) return;
      const a = Math.max(0, Math.min(1, alpha));

      this._drawMarks(ctx, m);
      this._drawZones(ctx);

      // positions interpolées
      const view = m.tanks.map((t) => ({
        t,
        x: lerp(t.px, t.x, a),
        y: lerp(t.py, t.y, a),
        h: lerpAngle(t.ph, t.heading, a),
        g: lerpAngle(t.pg, t.gun, a),
        r: lerpAngle(t.pr, t.radar, a),
      }));

      // faisceaux radar sous les tanks
      if (this.options.radar) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD, PAD, C.WIDTH, C.HEIGHT);
        ctx.clip();
        for (const v of view) if (v.t.alive) this._drawRadar(ctx, v);
        ctx.restore();
      }

      for (const v of view) if (!v.t.alive) this._drawTank(ctx, v);
      for (const v of view) if (v.t.alive) this._drawTank(ctx, v);

      this._drawBullets(ctx, m, a);
      this._drawScans(ctx);
      this._drawParticles(ctx);

      if (this.options.labels) for (const v of view) this._drawLabels(ctx, v);
      for (const v of view) this._drawBubble(ctx, v);
    }

    _drawMarks(ctx, m) {
      const LIFE = 700;
      for (const mk of this.marks) {
        const age = m.tick - mk.tick;
        if (mk.kind === 'scorch') {
          const g = ctx.createRadialGradient(this.X(mk.x), this.Y(mk.y), 2, this.X(mk.x), this.Y(mk.y), 36);
          g.addColorStop(0, 'rgba(0,0,0,0.45)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(this.X(mk.x), this.Y(mk.y), 36, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (age > LIFE) continue;
        const op = 0.22 * (1 - Math.pow(age / LIFE, 2));
        ctx.save();
        ctx.translate(this.X(mk.x), this.Y(mk.y));
        ctx.rotate(-mk.angle * DEG);
        ctx.fillStyle = 'rgba(0,0,0,' + op.toFixed(3) + ')';
        ctx.fillRect(-2, -15, 4, 6);
        ctx.fillRect(-2, 9, 4, 6);
        ctx.restore();
      }
      this.marks = this.marks.filter((mk) => mk.kind === 'scorch' || m.tick - mk.tick <= LIFE);
    }

    /** Zones et balises des missions. */
    _drawZones(ctx) {
      if (!this.zones.length) return;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      for (const z of this.zones) {
        const X = this.X(z.x);
        const Y = this.Y(z.y);
        ctx.beginPath();
        ctx.arc(X, Y, z.r, 0, Math.PI * 2);
        ctx.fillStyle = z.done ? 'rgba(46, 204, 113, 0.32)' : 'rgba(46, 204, 113, ' + (0.08 + 0.08 * pulse).toFixed(3) + ')';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = z.done ? '#2ecc71' : 'rgba(120, 240, 170, 0.9)';
        if (!z.done) ctx.setLineDash([7, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '700 ' + (z.done ? 22 : 16) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = z.done ? '#eafff1' : 'rgba(170, 255, 200, 0.85)';
        ctx.fillText(z.done ? '✓' : '⚑', X, Y + (z.done ? 8 : 6));
      }
    }

    _drawRadar(ctx, v) {
      const t = v.t;
      const L = C.RADAR_LENGTH;
      const half = E.RADAR_HALF_ANGLE;
      const x0 = this.X(v.x);
      const y0 = this.Y(v.y);
      const a1 = (v.r + half) * DEG;
      const a2 = (v.r - half) * DEG;
      if (!t.radarOn) {
        ctx.strokeStyle = 'rgba(200,200,200,0.12)';
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + Math.cos(v.r * DEG) * 160, y0 - Math.sin(v.r * DEG) * 160);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      const ex = x0 + Math.cos(v.r * DEG) * L;
      const ey = y0 - Math.sin(v.r * DEG) * L;
      const grad = ctx.createLinearGradient(x0, y0, ex, ey);
      grad.addColorStop(0, rgba(t.color, 0.42));
      grad.addColorStop(0.45, rgba(t.color, 0.14));
      grad.addColorStop(1, rgba(t.color, 0.02));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a1) * L, y0 - Math.sin(a1) * L);
      ctx.lineTo(x0 + Math.cos(a2) * L, y0 - Math.sin(a2) * L);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    _drawTank(ctx, v) {
      const t = v.t;
      const dead = !t.alive;
      const base = dead ? '#3d4245' : t.color;
      const st = this.trackState.get(t.index);
      const roll = st ? st.roll : 0;
      const X = this.X(v.x);
      const Y = this.Y(v.y);

      // châssis
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(-v.h * DEG);
      // ombre
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(ctx, -17, -14, 36, 31, 6);
      ctx.fill();
      // chenilles
      ctx.fillStyle = dead ? '#1d2022' : '#262c30';
      roundRect(ctx, -18, -17, 36, 9, 3);
      ctx.fill();
      roundRect(ctx, -18, 8, 36, 9, 3);
      ctx.fill();
      ctx.strokeStyle = dead ? '#2a2e30' : '#3b444a';
      ctx.lineWidth = 1.2;
      const off = roll % 6;
      for (let i = -18 + off; i < 18; i += 6) {
        ctx.beginPath();
        ctx.moveTo(i, -16.5); ctx.lineTo(i, -8.5);
        ctx.moveTo(i, 8.5); ctx.lineTo(i, 16.5);
        ctx.stroke();
      }
      // coque
      ctx.fillStyle = base;
      roundRect(ctx, -15, -10.5, 30, 21, 5);
      ctx.fill();
      ctx.strokeStyle = dead ? '#24282a' : shade(t.color, -0.45);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // reflets / détails
      ctx.fillStyle = dead ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.18)';
      roundRect(ctx, -12, -8, 24, 5, 2.5);
      ctx.fill();
      ctx.fillStyle = dead ? 'rgba(0,0,0,0.2)' : shade(t.color, -0.3);
      ctx.fillRect(10, -7, 3, 14); // plaque avant
      ctx.restore();

      // canon + tourelle
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(-v.g * DEG);
      // recul du canon juste après un tir
      const recoil = !dead && t.cooldown > C.COOLDOWN - 8 ? (t.cooldown - (C.COOLDOWN - 8)) * 0.5 : 0;
      ctx.fillStyle = dead ? '#2b2f31' : '#39434a';
      ctx.strokeStyle = dead ? '#1e2123' : '#1f262b';
      ctx.lineWidth = 1;
      roundRect(ctx, 3 - recoil, -2.6, 21, 5.2, 1.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = dead ? '#24282a' : '#2a3237';
      roundRect(ctx, 21 - recoil, -3.4, 5, 6.8, 1.5);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = dead ? '#474c50' : shade(t.color, 0.22);
      ctx.fill();
      ctx.strokeStyle = dead ? '#24282a' : shade(t.color, -0.45);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // antenne radar
      if (!dead) {
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(-v.r * DEG);
        ctx.strokeStyle = t.radarOn ? '#eef6f7' : '#7d8a8f';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(-1, 0);
        ctx.lineTo(5, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(1.5, 0, 4.5, -1.1, 1.1);
        ctx.stroke();
        ctx.restore();
      }

      if (t.broken && t.alive) {
        const blink = Math.floor(performance.now() / 400) % 2 === 0;
        if (blink) {
          ctx.font = '700 16px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffd166';
          ctx.fillText('⚠', X, Y + 6);
        }
      }
    }

    _drawBullets(ctx, m, a) {
      for (const b of m.bullets) {
        const t = m.tanks[b.owner];
        const color = t ? t.color : '#fff';
        const x = this.X(lerp(b.px, b.x, a));
        const y = this.Y(lerp(b.py, b.y, a));
        const tx = x - b.vx * 5;
        const ty = y + b.vy * 5;
        const g = ctx.createLinearGradient(tx, ty, x, y);
        g.addColorStop(0, rgba(color, 0));
        g.addColorStop(1, rgba(color, 0.7));
        ctx.strokeStyle = g;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(x, y, C.BULLET_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = '#fffbe8';
        ctx.fill();
      }
    }

    _drawScans(ctx) {
      for (const s of this.scans) {
        const k = s.life / s.max;
        const r = (s.kind === 'tank' ? 22 : 9) + k * 10;
        ctx.strokeStyle = rgba(s.color, 0.9 * (1 - k));
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(this.X(s.x), this.Y(s.y), r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    _drawParticles(ctx) {
      for (const p of this.particles) {
        const k = p.life / p.max;
        const X = this.X(p.x);
        const Y = this.Y(p.y);
        if (p.kind === 'spark') {
          ctx.globalAlpha = 1 - k;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(X, Y, p.size * (1 - k * 0.5), 0, Math.PI * 2);
          ctx.fill();
        } else if (p.kind === 'smoke') {
          ctx.globalAlpha = 0.32 * (1 - k);
          ctx.fillStyle = '#9aa3a6';
          ctx.beginPath();
          ctx.arc(X, Y, p.size * (1 + k * 1.8), 0, Math.PI * 2);
          ctx.fill();
        } else if (p.kind === 'ring') {
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3 * (1 - k) + 0.5;
          ctx.beginPath();
          ctx.arc(X, Y, p.size * (0.2 + k), 0, Math.PI * 2);
          ctx.stroke();
        } else if (p.kind === 'flash') {
          const g = ctx.createRadialGradient(X, Y, 0, X, Y, p.size);
          g.addColorStop(0, 'rgba(255,250,220,' + (0.9 * (1 - k)).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(255,170,60,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(X, Y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    _drawLabels(ctx, v) {
      const t = v.t;
      const X = this.X(v.x);
      const Y = this.Y(v.y);
      // barre de santé
      if (t.alive) {
        const w = 38;
        const hp = t.health / C.MAX_HEALTH;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        roundRect(ctx, X - w / 2 - 1, Y - 32, w + 2, 6, 2);
        ctx.fill();
        ctx.fillStyle = hp > 0.5 ? '#2ecc71' : hp > 0.25 ? '#f1c40f' : '#e74c3c';
        roundRect(ctx, X - w / 2, Y - 31, Math.max(0.01, w * hp), 4, 1.5);
        ctx.fill();
        // recharge du canon
        if (t.cooldown > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.fillRect(X - w / 2, Y - 25.5, w * (1 - t.cooldown / C.COOLDOWN), 1.5);
        }
      }
      // nom
      ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = t.alive ? '#f4f7f8' : '#8d979b';
      const label = (t.index + 1) + '. ' + t.name;
      ctx.strokeText(label, X, Y + 33);
      ctx.fillText(label, X, Y + 33);
      if (this.options.debug && t.alive) {
        ctx.font = '500 10px ui-monospace, Consolas, monospace';
        const q = t.queue.reduce((n, e) => n + e.n, 0);
        const txt = maskToText(t.lastMask) + '  file:' + q;
        ctx.strokeText(txt, X, Y + 46);
        ctx.fillStyle = '#ffd166';
        ctx.fillText(txt, X, Y + 46);
      }
    }

    _drawBubble(ctx, v) {
      const t = v.t;
      if (!t.bubble) return;
      const X = this.X(v.x);
      const Y = this.Y(v.y) - 40;
      ctx.font = '600 12px system-ui, "Segoe UI", sans-serif';
      const text = t.bubble.text;
      const w = Math.min(220, ctx.measureText(text).width + 16);
      const h = 22;
      let bx = X - w / 2;
      bx = Math.max(4, Math.min(VIEW_W - w - 4, bx));
      const by = Math.max(4, Y - h - 6);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(ctx, bx, by, w, h, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X - 5, by + h);
      ctx.lineTo(X + 5, by + h);
      ctx.lineTo(X, by + h + 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#1b2427';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.beginPath();
      ctx.rect(bx + 4, by, w - 8, h);
      ctx.clip();
      ctx.fillText(text, bx + w / 2, by + 15);
      ctx.restore();
    }
  }

  /** Représentation courte d'un ordre, pour le mode débogage. */
  function maskToText(mask) {
    const K = E.CMD;
    const parts = [];
    if (mask & K.MOVE_FORWARD) parts.push('▲');
    if (mask & K.MOVE_BACKWARD) parts.push('▼');
    if (mask & K.ROTATE_TANK_CCW) parts.push('T↺');
    if (mask & K.ROTATE_TANK_CW) parts.push('T↻');
    if (mask & K.ROTATE_GUN_CCW) parts.push('C↺');
    if (mask & K.ROTATE_GUN_CW) parts.push('C↻');
    if (mask & K.ROTATE_RADAR_CCW) parts.push('R↺');
    if (mask & K.ROTATE_RADAR_CW) parts.push('R↻');
    if (mask & K.FIRE) parts.push('🔥');
    if (mask & (K.LOCK_GUN | K.LOCK_RADAR)) parts.push('🔒');
    if (mask & (K.UNLOCK_GUN | K.UNLOCK_RADAR)) parts.push('🔓');
    return parts.length ? parts.join(' ') : '·';
  }

  root.ArenaRenderer = ArenaRenderer;
  root.TankRenderUtils = { maskToText, VIEW_W, VIEW_H, shade, rgba };
})(typeof window !== 'undefined' ? window : globalThis);
