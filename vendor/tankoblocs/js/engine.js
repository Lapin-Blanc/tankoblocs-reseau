/*
 * TankoBlocs — moteur de simulation.
 *
 * Ce fichier ne dépend d'aucun élément graphique : il peut tourner seul
 * (tests, championnat en calcul rapide).
 *
 * Les règles reprennent celles du projet open source « code-tanks » :
 *  - arène de 1024 × 640, origine au centre, axe Y vers le haut ;
 *  - 60 ticks par seconde ; à chaque tick, chaque tank exécute UN ordre
 *    (combinaison de bits) pris en tête de sa file d'ordres ;
 *  - un tank = un châssis, un canon et un radar. Le canon verrouillé suit
 *    le châssis, le radar verrouillé suit le canon ;
 *  - un obus, une collision avec un mur ou un autre tank : 10 dégâts ;
 *  - le vainqueur est celui qui a infligé le plus de dégâts.
 *
 * Unités exposées aux programmes : pixels, ticks et degrés.
 * Angles : 0° = vers la droite (est), 90° = vers le haut (nord), sens
 * inverse des aiguilles d'une montre (comme en mathématiques).
 */
(function (root) {
  'use strict';

  const C = Object.freeze({
    WIDTH: 1024,
    HEIGHT: 640,
    TICKS_PER_SECOND: 60,
    TANK_RADIUS: 19,
    BULLET_RADIUS: 5,
    MOVE_SPEED: 100 / 60, // pixels par tick
    BULLET_SPEED: 200 / 60, // pixels par tick
    ROT_SPEED: 0.9, // degrés par tick (π × 0,3 rad/s)
    COOLDOWN: 60, // ticks entre deux tirs
    MAX_HEALTH: 100,
    DAMAGE: 10,
    RADAR_LENGTH: 1024 + 640,
    RADAR_HALF_WIDTH: 25,
    DEFAULT_MAX_TICKS: 3600,
    MAX_TANKS: 4,
  });

  /* Ordres élémentaires : mêmes valeurs que l'API d'origine. */
  const CMD = Object.freeze({
    NONE: 0,
    MOVE_FORWARD: 1 << 0,
    MOVE_BACKWARD: 1 << 1,
    ROTATE_TANK_CW: 1 << 2,
    ROTATE_TANK_CCW: 1 << 3,
    FIRE: 1 << 4,
    ROTATE_GUN_CW: 1 << 5,
    ROTATE_GUN_CCW: 1 << 6,
    ROTATE_RADAR_CW: 1 << 7,
    ROTATE_RADAR_CCW: 1 << 8,
    LOCK_GUN: 1 << 9,
    UNLOCK_GUN: 1 << 10,
    LOCK_RADAR: 1 << 11,
    UNLOCK_RADAR: 1 << 12,
    REQUEST_INFO: 1 << 13,
    CLEAR_COMMANDS: 1 << 14,
    DISABLE_RADAR: 1 << 15,
    ENABLE_RADAR: 1 << 16,
    SELF_DESTRUCT: 1 << 31,
  });

  const MAX_TICKS_PER_ORDER = 1000000;
  const HALF_W = C.WIDTH / 2;
  const HALF_H = C.HEIGHT / 2;
  const DEG = Math.PI / 180;
  const RADAR_SLOPE = C.RADAR_HALF_WIDTH / C.RADAR_LENGTH;
  const RADAR_EDGE_FACTOR = Math.sqrt(1 + RADAR_SLOPE * RADAR_SLOPE);
  const RADAR_HALF_ANGLE = Math.atan(RADAR_SLOPE) / DEG;
  const WALL_NAMES = { N: 'mur nord', S: 'mur sud', E: 'mur est', W: 'mur ouest' };

  /* ---------- Outils mathématiques ---------- */

  /** Ramène un angle dans [0, 360). */
  function norm360(a) {
    a %= 360;
    if (a < 0) a += 360;
    // évite -0 et 360 dus aux arrondis
    return a >= 360 || Object.is(a, -0) ? 0 : a;
  }

  /** Ramène un angle dans (-180, 180]. */
  function norm180(a) {
    a = norm360(a);
    return a > 180 ? a - 360 : a;
  }

  function angleTo(fromX, fromY, toX, toY) {
    if (fromX === toX && fromY === toY) return 0;
    return norm360(Math.atan2(toY - fromY, toX - fromX) / DEG);
  }

  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function toTicks(v) {
    const n = Math.round(toNumber(v));
    return Math.max(0, Math.min(MAX_TICKS_PER_ORDER, n));
  }

  /** Générateur pseudo-aléatoire reproductible (mulberry32). */
  function makeRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Effet d'un ordre sur les rotations et les verrouillages.
   * Reprend exactement la logique d'origine : le canon suit le châssis
   * s'il est verrouillé, le radar suit le canon s'il est verrouillé
   * (et suit donc le châssis seulement si les deux le sont).
   * Rotations renvoyées en « crans » : +1 = gauche (anti-horaire).
   */
  function rotationEffect(mask, gunLocked, radarLocked) {
    if (mask & CMD.LOCK_GUN) gunLocked = true;
    if (mask & CMD.UNLOCK_GUN) gunLocked = false;
    if (mask & CMD.LOCK_RADAR) radarLocked = true;
    if (mask & CMD.UNLOCK_RADAR) radarLocked = false;
    let a = 0;
    let g = 0;
    let r = 0;
    if (mask & CMD.ROTATE_TANK_CW) {
      a -= 1;
      if (gunLocked) {
        g -= 1;
        if (radarLocked) r -= 1;
      }
    }
    if (mask & CMD.ROTATE_TANK_CCW) {
      a += 1;
      if (gunLocked) {
        g += 1;
        if (radarLocked) r += 1;
      }
    }
    if (mask & CMD.ROTATE_GUN_CW) {
      g -= 1;
      if (radarLocked) r -= 1;
    }
    if (mask & CMD.ROTATE_GUN_CCW) {
      g += 1;
      if (radarLocked) r += 1;
    }
    if (mask & CMD.ROTATE_RADAR_CW) r -= 1;
    if (mask & CMD.ROTATE_RADAR_CCW) r += 1;
    return { a, g, r, gunLocked, radarLocked };
  }

  /** Recharge du canon après n ticks d'un même ordre. */
  function cooldownAfter(cd, mask, n) {
    if (!(mask & CMD.FIRE)) return Math.max(0, cd - n);
    if (n <= cd) return cd - n;
    const m = n - cd - 1; // ticks écoulés après le premier tir
    return C.COOLDOWN - 1 - (m % C.COOLDOWN);
  }

  const PART_MASKS = {
    tank: [CMD.ROTATE_TANK_CW, CMD.ROTATE_TANK_CCW],
    canon: [CMD.ROTATE_GUN_CW, CMD.ROTATE_GUN_CCW],
    radar: [CMD.ROTATE_RADAR_CW, CMD.ROTATE_RADAR_CCW],
  };

  /** Masque de rotation d'une partie ; sens > 0 : gauche, sens < 0 : droite. */
  function turnMask(part, sens) {
    const pair = PART_MASKS[part] || PART_MASKS.tank;
    if (sens > 0) return pair[1];
    if (sens < 0) return pair[0];
    return 0;
  }

  /* ---------- Contrôleur : ce que le programme d'un tank peut faire ---------- */

  class Controller {
    constructor(match, tank) {
      this.match = match;
      this.tank = tank;
      this.event = null;
      this.mode = null;
      this.pending = [];
      this.cleared = false;
      this.plan = null;
    }

    _begin(mode) {
      this.mode = mode;
      this.pending = [];
      this.cleared = false;
      this._resetPlan();
    }

    _resetPlan() {
      const t = this.tank;
      this.plan = {
        tank: t.heading,
        canon: t.gun,
        radar: t.radar,
        gunLocked: t.gunLocked,
        radarLocked: t.radarLocked,
        cooldown: t.cooldown,
      };
    }

    _end() {
      const t = this.tank;
      const pending = this.pending;
      let queue;
      if (this.cleared) queue = pending;
      else if (this.mode === 'events') queue = pending.concat(t.queue);
      else queue = t.queue.concat(pending);
      t.queue = mergeQueue(queue);
      this.pending = [];
      this.mode = null;
      this.event = null;
    }

    /** Ajoute un ordre (masque) répété pendant n ticks. */
    push(mask, ticks) {
      const n = toTicks(ticks);
      if (n <= 0) return;
      mask |= 0;
      const p = this.pending;
      const last = p[p.length - 1];
      if (last && last.m === mask) last.n += n;
      else p.push({ m: mask, n });
      // mise à jour de l'état prévu (les rotations sont déterministes)
      const plan = this.plan;
      const fx = rotationEffect(mask, plan.gunLocked, plan.radarLocked);
      plan.gunLocked = fx.gunLocked;
      plan.radarLocked = fx.radarLocked;
      plan.tank = norm360(plan.tank + fx.a * C.ROT_SPEED * n);
      plan.canon = norm360(plan.canon + fx.g * C.ROT_SPEED * n);
      plan.radar = norm360(plan.radar + fx.r * C.ROT_SPEED * n);
      plan.cooldown = cooldownAfter(plan.cooldown, mask, n);
    }

    /* --- Actions de haut niveau utilisées par les blocs --- */

    move(sens, ticks) {
      const s = toNumber(sens);
      if (s === 0) return this.push(CMD.NONE, ticks);
      this.push(s > 0 ? CMD.MOVE_FORWARD : CMD.MOVE_BACKWARD, ticks);
    }

    moveDistance(sens, pixels) {
      let d = toNumber(pixels) * (toNumber(sens) < 0 ? -1 : 1);
      const ticks = Math.round(Math.abs(d) / C.MOVE_SPEED);
      this.push(d >= 0 ? CMD.MOVE_FORWARD : CMD.MOVE_BACKWARD, ticks);
    }

    turn(part, sens, ticks) {
      this.push(turnMask(part, toNumber(sens)), ticks);
    }

    turnDegrees(part, degrees) {
      const d = toNumber(degrees);
      const ticks = Math.round(Math.abs(d) / C.ROT_SPEED);
      this.push(turnMask(part, d >= 0 ? 1 : -1), ticks);
    }

    turnToAngle(part, angle) {
      const current = this.plan[part] !== undefined ? this.plan[part] : this.plan.tank;
      this.turnDegrees(part, norm180(toNumber(angle) - current));
    }

    turnToPoint(part, x, y) {
      const t = this.tank;
      this.turnToAngle(part, angleTo(t.x, t.y, toNumber(x), toNumber(y)));
    }

    wait(ticks) {
      this.push(CMD.NONE, ticks);
    }

    /** spec : { deplacement: -1|0|1, tank: -1|0|1, canon: …, radar: …, tirer: bool } */
    combine(ticks, spec) {
      spec = spec || {};
      let mask = 0;
      const mv = toNumber(spec.deplacement);
      if (mv > 0) mask |= CMD.MOVE_FORWARD;
      if (mv < 0) mask |= CMD.MOVE_BACKWARD;
      mask |= turnMask('tank', toNumber(spec.tank));
      mask |= turnMask('canon', toNumber(spec.canon));
      mask |= turnMask('radar', toNumber(spec.radar));
      if (spec.tirer) mask |= CMD.FIRE;
      this.push(mask, ticks);
    }

    fire(whenReady) {
      if (whenReady && this.plan.cooldown > 0) this.push(CMD.NONE, this.plan.cooldown);
      this.push(CMD.FIRE, 1);
    }

    lock(part, locked) {
      if (part === 'radar') this.push(locked ? CMD.LOCK_RADAR : CMD.UNLOCK_RADAR, 1);
      else this.push(locked ? CMD.LOCK_GUN : CMD.UNLOCK_GUN, 1);
    }

    radarPower(on) {
      this.push(on ? CMD.ENABLE_RADAR : CMD.DISABLE_RADAR, 1);
    }

    /** Annule immédiatement tous les ordres prévus (file + ordres en cours d'ajout). */
    clear() {
      this.pending = [];
      this.cleared = true;
      this._resetPlan();
    }

    selfDestruct() {
      this.push(CMD.SELF_DESTRUCT, 1);
    }

    /* --- Capteurs --- */

    read(name) {
      const t = this.tank;
      const m = this.match;
      switch (name) {
        case 'x': return t.x;
        case 'y': return t.y;
        case 'direction': return t.heading;
        case 'directionCanon': return t.gun;
        case 'directionRadar': return t.radar;
        case 'sante': return t.health;
        case 'recharge': return t.cooldown;
        case 'ordres': return (this.cleared ? 0 : queueTicks(t.queue)) + queueTicks(this.pending);
        case 'tick': return m.tick;
        case 'tempsRestant': return Math.max(0, m.maxTicks - m.tick);
        case 'tanksEnVie': return m.tanks.filter((o) => o.alive).length;
        case 'adversairesEnVie': return m.tanks.filter((o) => o.alive && o !== t).length;
        case 'degatsInfliges': return t.damageDealt;
        case 'numero': return t.index + 1;
        case 'vitesseX': return t.x - t.px;
        case 'vitesseY': return t.y - t.py;
        default: return 0;
      }
    }

    readBool(name) {
      const t = this.tank;
      switch (name) {
        case 'canonPret': return t.cooldown === 0;
        case 'canonVerrouille': return t.gunLocked;
        case 'radarVerrouille': return t.radarLocked;
        case 'radarAllume': return t.radarOn;
        case 'fileVide': return (this.cleared || t.queue.length === 0) && this.pending.length === 0;
        case 'presDunMur': {
          const margin = C.TANK_RADIUS + 40;
          return Math.abs(t.x) > HALF_W - margin || Math.abs(t.y) > HALF_H - margin;
        }
        default: return false;
      }
    }

    angleTo(x, y) {
      return angleTo(this.tank.x, this.tank.y, toNumber(x), toNumber(y));
    }

    distanceTo(x, y) {
      return Math.hypot(toNumber(x) - this.tank.x, toNumber(y) - this.tank.y);
    }

    /* --- Informations sur l'objet de l'événement en cours --- */

    eventValue(name) {
      const e = this.event;
      if (!e) return name === 'type' || name === 'nom' ? '' : 0;
      switch (name) {
        case 'x': return e.x;
        case 'y': return e.y;
        case 'direction': return e.heading;
        case 'vitesseX': return e.vx;
        case 'vitesseY': return e.vy;
        case 'vitesse': return Math.hypot(e.vx, e.vy);
        case 'vitesseAngulaire': return e.angvel;
        case 'distance': return e.distance;
        case 'angle': return e.bearing;
        case 'numero': return e.id;
        case 'type': return e.kind;
        case 'nom': return e.name;
        case 'evenement': return e.type;
        default: return 0;
      }
    }

    eventIs(kind) {
      return !!this.event && this.event.kind === kind;
    }

    /* --- Outils --- */

    log(text) {
      this.match._log(this.tank, String(text), 'log');
    }

    say(text) {
      const s = String(text);
      this.match._log(this.tank, '💬 ' + s, 'say');
      this.tank.bubble = { text: s.slice(0, 80), until: this.match.tick + 120 };
      this.match.fx.push({ t: 'say', tank: this.tank.index });
    }
  }

  function queueTicks(q) {
    let n = 0;
    for (const e of q) n += e.n;
    return n;
  }

  function mergeQueue(q) {
    const out = [];
    for (const e of q) {
      if (!e || e.n <= 0) continue;
      const last = out[out.length - 1];
      if (last && last.m === e.m) last.n += e.n;
      else out.push({ m: e.m, n: e.n });
    }
    return out;
  }

  /* ---------- Partie ---------- */

  class Match {
    /**
     * @param {object} opts
     *  - entrants : [{ name, color, brain, pilot }]
     *       brain : { start(ctrl), run(ctrl), events(ctrl, liste) } ou null
     *  - seed : graine (placement + hasard des programmes)
     *  - maxTicks : durée maximale
     *  - input(index) : masque d'ordres clavier pour un tank piloté
     *  - onLog(entrée) : appelé pour chaque message du journal
     */
    constructor(opts) {
      this.seed = (opts.seed >>> 0) || 1;
      this.maxTicks = Math.max(1, toTicks(opts.maxTicks || C.DEFAULT_MAX_TICKS));
      this.input = opts.input || null;
      this.onLog = opts.onLog || null;
      this.tick = 0;
      this.tanks = [];
      this.bullets = [];
      this.fx = [];
      this.logs = [];
      this.finished = false;
      this.results = null;
      this.nextBulletId = 1;
      this.contacts = new Set();
      this.random = makeRandom(this.seed);

      const entrants = (opts.entrants || []).slice(0, C.MAX_TANKS);
      entrants.forEach((e, i) => this.tanks.push(this._createTank(e, i)));
      this._spawn();
      for (const t of this.tanks) {
        t.controller = new Controller(this, t);
        this._call(t, 'start');
      }
    }

    _createTank(e, index) {
      return {
        index,
        name: String(e.name || 'Tank ' + (index + 1)),
        color: e.color || '#e74c3c',
        brain: e.brain || null,
        pilot: !!e.pilot,
        spawn: e.spawn || null,
        x: 0, y: 0, heading: 0, gun: 0, radar: 0,
        px: 0, py: 0, ph: 0, pg: 0, pr: 0,
        vx: 0, vy: 0, va: 0, vg: 0, vr: 0,
        health: C.MAX_HEALTH,
        alive: true,
        deathTick: null,
        killedBy: null,
        broken: !!e.error,
        error: e.error || null,
        cooldown: 0,
        gunLocked: true,
        radarLocked: true,
        radarOn: true,
        queue: [],
        events: [],
        radarSeen: new Set(),
        lastMask: 0,
        damageDealt: 0,
        damageTaken: 0,
        wallHits: 0,
        crashes: 0,
        distance: 0,
        kills: 0,
        shots: 0,
        hits: 0,
        bubble: null,
        controller: null,
      };
    }

    _spawn() {
      const rnd = this.random;
      const margin = 70;
      const placed = [];
      for (const t of this.tanks) {
        let best = null;
        let bestScore = -1;
        for (let attempt = 0; attempt < 400; attempt++) {
          const x = -HALF_W + margin + rnd() * (C.WIDTH - 2 * margin);
          const y = -HALF_H + margin + rnd() * (C.HEIGHT - 2 * margin);
          let minD = Infinity;
          for (const p of placed) minD = Math.min(minD, Math.hypot(p.x - x, p.y - y));
          if (minD >= 220) { best = { x, y }; break; }
          if (minD > bestScore) { bestScore = minD; best = { x, y }; }
        }
        placed.push(best);
        t.x = t.px = best.x;
        t.y = t.py = best.y;
        const h = Math.floor(rnd() * 360);
        t.heading = t.gun = t.radar = h;
        t.ph = t.pg = t.pr = h;
      }
      // positions imposées (missions) : appliquées après le tirage pour ne
      // pas changer la suite des nombres aléatoires
      for (const t of this.tanks) {
        if (!t.spawn) continue;
        t.x = t.px = clamp(toNumber(t.spawn.x), -HALF_W + C.TANK_RADIUS, HALF_W - C.TANK_RADIUS);
        t.y = t.py = clamp(toNumber(t.spawn.y), -HALF_H + C.TANK_RADIUS, HALF_H - C.TANK_RADIUS);
        const h = norm360(toNumber(t.spawn.heading));
        t.heading = t.gun = t.radar = t.ph = t.pg = t.pr = h;
      }
    }

    /** Appelle le programme d'un tank en protégeant la partie contre ses erreurs. */
    _call(t, kind, events) {
      if (!t.brain || t.broken || !t.alive) return;
      const ctrl = t.controller;
      ctrl._begin(kind === 'events' ? 'events' : kind);
      try {
        if (kind === 'start') t.brain.start(ctrl);
        else if (kind === 'run') t.brain.run(ctrl);
        else t.brain.events(ctrl, events);
        ctrl._end();
      } catch (err) {
        ctrl.pending = [];
        ctrl.mode = null;
        ctrl.event = null;
        t.queue = [];
        t.broken = true;
        t.error = (err && err.message) || String(err);
        this._log(t, '⚠ Programme en panne : ' + t.error, 'error');
      }
    }

    _log(t, text, kind) {
      const entry = { tick: this.tick, tank: t ? t.index : -1, text, kind: kind || 'log' };
      if (this.logs.length < 5000) this.logs.push(entry);
      if (this.onLog) this.onLog(entry);
    }

    /* ----- Un tick de simulation ----- */
    step() {
      if (this.finished) return;
      this.tick++;
      const tanks = this.tanks;

      for (const t of tanks) {
        t.px = t.x; t.py = t.y; t.ph = t.heading; t.pg = t.gun; t.pr = t.radar;
      }
      for (const b of this.bullets) { b.px = b.x; b.py = b.y; }

      // 1. demander des ordres aux tanks dont la file est vide
      for (const t of tanks) {
        if (t.alive && !t.broken && t.queue.length === 0) {
          this._call(t, 'run');
        }
      }

      // 2. appliquer un ordre par tank
      for (const t of tanks) this._apply(t);

      // 3. physique
      this._moveTanks();
      this._moveBullets();
      this._tankContacts();
      this._bulletCollisions();
      this._radars();

      // 4. événements
      for (const t of tanks) {
        if (t.events.length === 0) continue;
        const list = t.events;
        t.events = [];
        if (t.alive && !t.broken) this._call(t, 'events', list);
      }

      for (const t of tanks) {
        if (t.bubble && t.bubble.until <= this.tick) t.bubble = null;
      }

      this._checkEnd();
    }

    _apply(t) {
      t.vx = t.vy = t.va = t.vg = t.vr = 0;
      if (!t.alive) { t.lastMask = 0; return; }
      let mask = 0;
      if (t.queue.length) {
        const head = t.queue[0];
        mask = head.m;
        if (--head.n <= 0) t.queue.shift();
      }
      if (t.pilot && this.input) mask |= this.input(t.index) | 0;
      t.lastMask = mask;

      if (mask & CMD.SELF_DESTRUCT) {
        this._log(t, '☠ Autodestruction !', 'info');
        t.damageTaken += t.health;
        t.health = 0;
        this._kill(t, null);
        return;
      }

      let mv = 0;
      if (mask & CMD.MOVE_FORWARD) mv += 1;
      if (mask & CMD.MOVE_BACKWARD) mv -= 1;
      const rad = t.heading * DEG;
      t.vx = Math.cos(rad) * C.MOVE_SPEED * mv;
      t.vy = Math.sin(rad) * C.MOVE_SPEED * mv;

      const fx = rotationEffect(mask, t.gunLocked, t.radarLocked);
      t.gunLocked = fx.gunLocked;
      t.radarLocked = fx.radarLocked;
      t.va = fx.a * C.ROT_SPEED;
      t.vg = fx.g * C.ROT_SPEED;
      t.vr = fx.r * C.ROT_SPEED;

      if ((mask & CMD.FIRE) && t.cooldown === 0) this._fire(t);

      if (mask & CMD.DISABLE_RADAR) t.radarOn = false;
      if (mask & CMD.ENABLE_RADAR) t.radarOn = true;
      if (mask & CMD.CLEAR_COMMANDS) t.queue = [];

      if (t.cooldown > 0) t.cooldown--;
    }

    _fire(t) {
      const rad = t.gun * DEG;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const off = C.TANK_RADIUS + C.BULLET_RADIUS * 2;
      const b = {
        id: this.nextBulletId++,
        owner: t.index,
        x: t.x + dx * off,
        y: t.y + dy * off,
        vx: dx * C.BULLET_SPEED,
        vy: dy * C.BULLET_SPEED,
        heading: t.gun,
        dead: false,
        born: this.tick,
      };
      // l'obus n'avance pas pendant son tick de création (comme une apparition au canon)
      b.px = b.x - b.vx;
      b.py = b.y - b.vy;
      b.x -= b.vx;
      b.y -= b.vy;
      this.bullets.push(b);
      t.cooldown = C.COOLDOWN;
      t.shots++;
      this.fx.push({ t: 'fire', tank: t.index, x: t.x + dx * (C.TANK_RADIUS + 6), y: t.y + dy * (C.TANK_RADIUS + 6), angle: t.gun });
    }

    _moveTanks() {
      const tanks = this.tanks;
      const R = C.TANK_RADIUS;
      for (const t of tanks) {
        if (!t.alive) continue;
        t.heading = norm360(t.heading + t.va);
        t.gun = norm360(t.gun + t.vg);
        t.radar = norm360(t.radar + t.vr);
        t.x += t.vx;
        t.y += t.vy;
      }
      // séparation des tanks qui se chevauchent (masses égales), puis murs
      for (let iter = 0; iter < 4; iter++) {
        for (let i = 0; i < tanks.length; i++) {
          for (let j = i + 1; j < tanks.length; j++) {
            const a = tanks[i];
            const b = tanks[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            if (d >= 2 * R) continue;
            if (d < 1e-9) { dx = 1; dy = 0; d = 1; } else { dx /= d; dy /= d; }
            const push = (2 * R - d) / 2;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
          }
        }
        for (const t of tanks) {
          t.x = Math.max(-HALF_W + R, Math.min(HALF_W - R, t.x));
          t.y = Math.max(-HALF_H + R, Math.min(HALF_H - R, t.y));
        }
      }
      for (const t of tanks) t.distance += Math.hypot(t.x - t.px, t.y - t.py);
    }

    _moveBullets() {
      for (const b of this.bullets) {
        b.x += b.vx;
        b.y += b.vy;
      }
    }

    _info(kind, o, receiver) {
      let info;
      if (kind === 'tank') {
        info = {
          kind: 'tank', id: o.index + 1, name: o.name,
          x: o.x, y: o.y, heading: o.heading,
          vx: o.x - o.px, vy: o.y - o.py, angvel: o.alive ? o.va : 0,
          alive: o.alive,
        };
      } else if (kind === 'obus') {
        const owner = this.tanks[o.owner];
        info = {
          kind: 'obus', id: 1000 + o.id, name: owner ? owner.name : '',
          x: o.x, y: o.y, heading: o.heading,
          vx: o.vx, vy: o.vy, angvel: 0, alive: true,
        };
      } else {
        info = {
          kind: 'mur', id: 0, name: WALL_NAMES[o.side],
          x: o.x, y: o.y, heading: { N: 270, S: 90, E: 180, W: 0 }[o.side],
          vx: 0, vy: 0, angvel: 0, alive: true,
        };
      }
      info.distance = Math.hypot(info.x - receiver.x, info.y - receiver.y);
      info.bearing = angleTo(receiver.x, receiver.y, info.x, info.y);
      return info;
    }

    _event(receiver, type, kind, obj) {
      const info = this._info(kind, obj, receiver);
      info.type = type;
      receiver.events.push(info);
    }

    _damage(t, amount, shooter) {
      if (!t.alive) return false;
      t.health = Math.max(0, t.health - amount);
      t.damageTaken += amount;
      if (t.health <= 0) {
        this._kill(t, shooter);
        return true;
      }
      return false;
    }

    _kill(t, shooter) {
      if (!t.alive && t.deathTick !== null) return;
      t.alive = false;
      t.health = 0;
      t.deathTick = this.tick;
      t.queue = [];
      t.radarSeen.clear();
      t.vx = t.vy = t.va = t.vg = t.vr = 0;
      if (shooter && shooter !== t) {
        shooter.kills++;
        t.killedBy = shooter.index;
        this._log(t, '💀 détruit par ' + shooter.name, 'info');
      } else {
        this._log(t, '💀 détruit', 'info');
      }
      this.fx.push({ t: 'explode', tank: t.index, x: t.x, y: t.y });
    }

    _tankContacts() {
      const tanks = this.tanks;
      const R = C.TANK_RADIUS;
      const TOUCH = 0.5;
      const RELEASE = 1.5;
      for (let i = 0; i < tanks.length; i++) {
        for (let j = i + 1; j < tanks.length; j++) {
          const a = tanks[i];
          const b = tanks[j];
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          const key = 't' + i + '-' + j;
          const was = this.contacts.has(key);
          if (!was && d <= 2 * R + TOUCH) {
            this.contacts.add(key);
            if (a.alive || b.alive) {
              const infoForA = a.alive ? b : null;
              const infoForB = b.alive ? a : null;
              if (infoForA) { this._event(a, 'touche', 'tank', b); a.crashes++; }
              if (infoForB) { this._event(b, 'touche', 'tank', a); b.crashes++; }
              this._damage(a, C.DAMAGE, null);
              this._damage(b, C.DAMAGE, null);
              this.fx.push({ t: 'crash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            }
          } else if (was && d > 2 * R + RELEASE) {
            this.contacts.delete(key);
          }
        }
      }
      for (const t of tanks) {
        const gaps = {
          W: t.x - R + HALF_W,
          E: HALF_W - (t.x + R),
          S: t.y - R + HALF_H,
          N: HALF_H - (t.y + R),
        };
        for (const side in gaps) {
          const key = 'w' + t.index + side;
          const was = this.contacts.has(key);
          const gap = gaps[side];
          if (!was && gap <= TOUCH) {
            this.contacts.add(key);
            if (!t.alive) continue;
            t.wallHits++;
            const wall = wallPoint(side, t.x, t.y);
            this._event(t, 'touche', 'mur', wall);
            this._damage(t, C.DAMAGE, null);
            this.fx.push({ t: 'crash', x: wall.x, y: wall.y });
          } else if (was && gap > RELEASE) {
            this.contacts.delete(key);
          }
        }
      }
    }

    _bulletCollisions() {
      const R = C.TANK_RADIUS;
      const r = C.BULLET_RADIUS;
      const bullets = this.bullets;
      for (const b of bullets) {
        if (b.dead) continue;
        const shooter = this.tanks[b.owner];

        // mur
        let side = null;
        if (b.x + r >= HALF_W) side = 'E';
        else if (b.x - r <= -HALF_W) side = 'W';
        else if (b.y + r >= HALF_H) side = 'N';
        else if (b.y - r <= -HALF_H) side = 'S';
        if (side) {
          b.dead = true;
          const wall = wallPoint(side, b.x, b.y);
          if (shooter) this._event(shooter, 'impact', 'mur', wall);
          this.fx.push({ t: 'spark', x: wall.x, y: wall.y, tank: b.owner });
          continue;
        }

        // tank
        let hitTank = null;
        for (const t of this.tanks) {
          if (Math.hypot(t.x - b.x, t.y - b.y) <= R + r) { hitTank = t; break; }
        }
        if (hitTank) {
          b.dead = true;
          const wasAlive = hitTank.alive;
          if (wasAlive) {
            this._event(hitTank, 'touche', 'obus', b);
            if (shooter && shooter !== hitTank) {
              shooter.damageDealt += C.DAMAGE;
              shooter.hits++;
            }
            this._damage(hitTank, C.DAMAGE, shooter);
          }
          if (shooter) this._event(shooter, 'impact', 'tank', hitTank);
          this.fx.push({ t: 'hit', x: b.x, y: b.y, tank: b.owner, target: hitTank.index, alive: wasAlive });
          continue;
        }

        // autre obus
        for (const o of bullets) {
          if (o === b || o.dead) continue;
          if (Math.hypot(o.x - b.x, o.y - b.y) <= 2 * r) {
            b.dead = true;
            o.dead = true;
            const other = this.tanks[o.owner];
            if (shooter) this._event(shooter, 'impact', 'obus', o);
            if (other) this._event(other, 'impact', 'obus', b);
            this.fx.push({ t: 'spark', x: (b.x + o.x) / 2, y: (b.y + o.y) / 2, tank: b.owner });
            break;
          }
        }
      }
      if (bullets.some((b) => b.dead)) this.bullets = bullets.filter((b) => !b.dead);
    }

    /** Le radar est un triangle très fin partant du tank ; un événement
     *  est produit quand un objet ENTRE dans le faisceau. */
    _radars() {
      for (const t of this.tanks) {
        if (!t.alive) { t.radarSeen.clear(); continue; }
        const seen = new Set();
        const found = [];
        const rad = t.radar * DEG;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const inBeam = (px, py, radius) => {
          const dx = px - t.x;
          const dy = py - t.y;
          if (dx * dx + dy * dy <= radius * radius) return true;
          const u = dx * c + dy * s;
          if (u <= 0 || u > C.RADAR_LENGTH + radius) return false;
          const v = -dx * s + dy * c;
          return (Math.abs(v) - RADAR_SLOPE * u) / RADAR_EDGE_FACTOR <= radius;
        };
        for (const o of this.tanks) {
          if (o === t || !o.alive) continue;
          if (inBeam(o.x, o.y, C.TANK_RADIUS)) {
            const key = 't' + o.index;
            seen.add(key);
            if (!t.radarSeen.has(key)) found.push(['tank', o]);
          }
        }
        for (const b of this.bullets) {
          if (b.owner === t.index) continue;
          if (inBeam(b.x, b.y, C.BULLET_RADIUS)) {
            const key = 'b' + b.id;
            seen.add(key);
            if (!t.radarSeen.has(key)) found.push(['obus', b]);
          }
        }
        // murs touchés par les bords du faisceau
        const center = rayExit(t.x, t.y, t.radar);
        const walls = [rayExit(t.x, t.y, t.radar + RADAR_HALF_ANGLE), rayExit(t.x, t.y, t.radar - RADAR_HALF_ANGLE)];
        for (const w of walls) {
          const key = 'w' + w.side;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!t.radarSeen.has(key)) {
            const p = center.side === w.side ? center : w;
            found.push(['mur', { side: w.side, x: p.x, y: p.y }]);
          }
        }
        t.radarSeen = seen;
        if (t.radarOn) {
          for (const [kind, o] of found) {
            this._event(t, 'radar', kind, o);
            if (kind !== 'mur') this.fx.push({ t: 'scan', tank: t.index, x: o.x, y: o.y, kind });
          }
        }
      }
    }

    _checkEnd() {
      const alive = this.tanks.filter((t) => t.alive).length;
      const early = this.tanks.length > 1 && alive <= 1;
      if (early || this.tick >= this.maxTicks) this._finish(early);
    }

    _finish(early) {
      this.finished = true;
      const ranking = this.tanks.slice().sort(compareTanks);
      let winner = ranking[0] || null;
      if (ranking.length > 1 && compareTanks(ranking[0], ranking[1]) === 0) winner = null;
      if (this.tanks.length === 1) winner = null;
      this.results = {
        early,
        ticks: this.tick,
        winner: winner ? winner.index : -1,
        ranking: ranking.map((t) => ({
          index: t.index,
          name: t.name,
          color: t.color,
          damageDealt: t.damageDealt,
          damageTaken: t.damageTaken,
          health: t.health,
          alive: t.alive,
          deathTick: t.deathTick,
          kills: t.kills,
          shots: t.shots,
          hits: t.hits,
          broken: t.broken,
          error: t.error,
        })),
      };
      this.fx.push({ t: 'end' });
    }
  }

  /** Classement : dégâts infligés, puis santé restante, puis durée de survie. */
  function compareTanks(a, b) {
    if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;
    if (b.health !== a.health) return b.health - a.health;
    const da = a.deathTick === null ? Infinity : a.deathTick;
    const db = b.deathTick === null ? Infinity : b.deathTick;
    if (da !== db) return db > da ? 1 : -1;
    return 0;
  }

  function wallPoint(side, x, y) {
    switch (side) {
      case 'N': return { side, x: clamp(x, -HALF_W, HALF_W), y: HALF_H };
      case 'S': return { side, x: clamp(x, -HALF_W, HALF_W), y: -HALF_H };
      case 'E': return { side, x: HALF_W, y: clamp(y, -HALF_H, HALF_H) };
      default: return { side: 'W', x: -HALF_W, y: clamp(y, -HALF_H, HALF_H) };
    }
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  /** Point où un rayon partant de (x, y) avec l'angle donné sort de l'arène. */
  function rayExit(x, y, angle) {
    const dx = Math.cos(angle * DEG);
    const dy = Math.sin(angle * DEG);
    let best = Infinity;
    let side = 'E';
    if (dx > 1e-12) { const k = (HALF_W - x) / dx; if (k < best) { best = k; side = 'E'; } }
    if (dx < -1e-12) { const k = (-HALF_W - x) / dx; if (k < best) { best = k; side = 'W'; } }
    if (dy > 1e-12) { const k = (HALF_H - y) / dy; if (k < best) { best = k; side = 'N'; } }
    if (dy < -1e-12) { const k = (-HALF_H - y) / dy; if (k < best) { best = k; side = 'S'; } }
    if (!Number.isFinite(best)) best = 0;
    return { side, x: clamp(x + dx * best, -HALF_W, HALF_W), y: clamp(y + dy * best, -HALF_H, HALF_H) };
  }

  root.TankEngine = {
    C,
    CMD,
    Match,
    Controller,
    rotationEffect,
    cooldownAfter,
    norm360,
    norm180,
    angleTo,
    makeRandom,
    rayExit,
    compareTanks,
    RADAR_HALF_ANGLE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
