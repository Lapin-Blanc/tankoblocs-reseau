/*
 * Le salon : joueurs connectés, combats en préparation, en cours et
 * récemment terminés. Tout passe par un WebSocket par onglet.
 *
 * Cycle d'un combat :
 *   waiting   des places « joueur » sont encore libres
 *   countdown toutes les places sont prises : décompte avant le départ
 *   queued    trop de combats en cours : attente d'une place
 *   running   le combat tourne (fil d'exécution séparé, 60 ticks/s)
 *   finished  terminé, résultat enregistré
 *   aborted   arrêté (programme trop lent, enseignant, serveur arrêté…)
 *
 * Le programme de chaque joueur est figé au moment du départ : c'est la
 * dernière version enregistrée dans l'atelier.
 */
import crypto from 'node:crypto';
import { BOTS, getBot, distinctify, ENGINE_VERSION, C } from './tankoblocs.js';
import { startLive, abortMessage } from './sim/runner.js';
import { UserError } from './auth.js';

const ACTIVE = new Set(['waiting', 'countdown', 'queued', 'running']);
const PENDING = new Set(['waiting', 'countdown', 'queued']);
const MAX_OPEN_MATCHES = 60;
const MAX_MSG_PER_SEC = 25;
const PUBLIC_LOG_KINDS = new Set(['info']);
const MAX_LOGS_KEPT = 400;

function uid() {
  return crypto.randomBytes(6).toString('base64url');
}

function cleanTitle(s, fallback) {
  const t = String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
  return t || fallback;
}

export class Lobby {
  /**
   * @param {object} deps { store, db, config }
   */
  constructor({ store, db, config }) {
    this.store = store;
    this.db = db;
    this.config = config;
    this.clients = new Set();
    this.online = new Map(); // userId -> { user, sockets: Set, grace }
    this.matches = new Map(); // uid -> combat (actifs et récents)
    this.recent = []; // uid des combats terminés, du plus récent au plus ancien
    this.queue = []; // uid des combats en attente d'une place
    this.broadcastTimer = null;
    this.heartbeat = setInterval(() => this.ping(), 30000);
    this.heartbeat.unref?.();
  }

  settings() {
    return this.db.getSettings();
  }

  /* ================= Connexions ================= */

  /** Nouveau WebSocket authentifié. */
  connect(ws, user) {
    const client = { ws, user, watching: null, alive: true, window: Date.now(), count: 0 };
    this.clients.add(client);
    let entry = this.online.get(user.id);
    if (!entry) {
      entry = { user, sockets: new Set(), grace: null };
      this.online.set(user.id, entry);
    }
    entry.user = user;
    entry.sockets.add(client);
    if (entry.grace) {
      clearTimeout(entry.grace);
      entry.grace = null;
    }

    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.disconnect(client));
    ws.on('error', () => {});

    this.send(client, {
      type: 'hello',
      me: user,
      now: Date.now(),
      engine: ENGINE_VERSION,
      bots: BOTS.map(({ id, name, color, level }) => ({ id, name, color, level })),
      settings: this.publicSettings(),
    });
    this.send(client, this.lobbyState());
    this.scheduleBroadcast();
  }

  disconnect(client) {
    if (!this.clients.delete(client) || this.closed) return;
    this.unwatch(client);
    const entry = this.online.get(client.user.id);
    if (entry) {
      entry.sockets.delete(client);
      if (entry.sockets.size === 0) {
        // laisse le temps de recharger la page avant de libérer sa place
        entry.grace = setTimeout(() => {
          entry.grace = null;
          if (entry.sockets.size > 0) return;
          this.online.delete(client.user.id);
          this.leaveAllPending(client.user.id, 'déconnecté');
          this.scheduleBroadcast();
        }, this.config.disconnectGraceMs);
      }
    }
    this.scheduleBroadcast();
  }

  ping() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignoré */ }
    }
  }

  send(client, msg) {
    if (client.ws.readyState !== 1) return;
    client.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  sendToUser(userId, msg) {
    const entry = this.online.get(userId);
    if (!entry) return;
    const s = JSON.stringify(msg);
    for (const c of entry.sockets) this.send(c, s);
  }

  toast(userId, text, level = 'info') {
    this.sendToUser(userId, { type: 'toast', text, level });
  }

  /** Après une modification par l'enseignant (pseudo, rôle, compte désactivé…). */
  refreshUser(userId, user) {
    const entry = this.online.get(userId);
    if (!user) {
      // compte supprimé ou désactivé : on ferme ses connexions
      this.leaveAllPending(userId, 'compte désactivé');
      if (entry) for (const c of [...entry.sockets]) c.ws.close(4001, 'compte désactivé');
      return;
    }
    if (entry) {
      entry.user = user;
      for (const c of entry.sockets) {
        c.user = user;
        this.send(c, { type: 'me', me: user });
      }
    }
    for (const m of this.matches.values()) {
      for (const s of m.slots) if (s.userId === userId) s.pseudo = user.pseudo;
      if (m.creatorId === userId) m.creatorPseudo = user.pseudo;
    }
    this.scheduleBroadcast();
  }

  /* ================= Messages ================= */

  onMessage(client, data, isBinary) {
    const t = Date.now();
    if (t - client.window > 1000) {
      client.window = t;
      client.count = 0;
    }
    if (++client.count > MAX_MSG_PER_SEC) return;
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    try {
      this.handle(client, msg);
    } catch (err) {
      if (err instanceof UserError) this.send(client, { type: 'error', text: err.message, ref: msg.ref ?? null });
      else {
        console.error('[salon] erreur', err);
        this.send(client, { type: 'error', text: 'Erreur interne du serveur.', ref: msg.ref ?? null });
      }
    }
  }

  handle(client, msg) {
    const user = client.user;
    switch (msg.type) {
      case 'create': {
        const m = this.create(user, msg);
        this.send(client, { type: 'created', uid: m.uid, ref: msg.ref ?? null });
        break;
      }
      case 'join': this.join(user, this.need(msg.uid), msg.tankId); break;
      case 'leave': this.leave(user, this.need(msg.uid)); break;
      case 'kick': this.kick(user, this.need(msg.uid), msg.slot); break;
      case 'setSlot': this.setSlot(user, this.need(msg.uid), msg.slot, msg.kind, msg.botId); break;
      case 'fillBots': this.fillBots(user, this.need(msg.uid)); break;
      case 'setTank': this.setTank(user, this.need(msg.uid), msg.tankId); break;
      case 'cancel': this.cancelBy(user, this.need(msg.uid)); break;
      case 'watch': this.watch(client, String(msg.uid || '')); break;
      case 'unwatch': this.unwatch(client); break;
      case 'ping': this.send(client, { type: 'pong', now: Date.now() }); break;
      default: break;
    }
  }

  need(id) {
    const m = this.matches.get(String(id || ''));
    if (!m) throw new UserError('Ce combat n\'existe plus.', 404);
    return m;
  }

  /* ================= Préparation des combats ================= */

  activeMatchOf(userId) {
    for (const m of this.matches.values()) {
      if (ACTIVE.has(m.status) && m.slots.some((s) => s.userId === userId)) return m;
    }
    return null;
  }

  checkFree(userId) {
    const m = this.activeMatchOf(userId);
    if (m) throw new UserError(m.status === 'running'
      ? 'Ton tank est déjà en train de combattre. Attends la fin du combat.'
      : 'Tu es déjà inscrit à un combat. Quitte-le d\'abord.');
  }

  tankFor(user, tankId) {
    const id = Number(tankId);
    const tank = Number.isInteger(id) ? this.store.getTank(user.id, id) : null;
    if (!tank) throw new UserError('Choisis d\'abord un de tes tanks.');
    return tank;
  }

  create(user, msg) {
    this.checkFree(user.id);
    const s = this.settings();
    const open = [...this.matches.values()].filter((m) => PENDING.has(m.status)).length;
    if (open >= MAX_OPEN_MATCHES) throw new UserError('Trop de combats sont en préparation. Rejoins-en un !');
    const tank = this.tankFor(user, msg.tankId);

    let duration = Math.round(Number(msg.durationSec) / 5) * 5;
    if (!Number.isFinite(duration)) duration = 60;
    duration = Math.max(s.minDurationSec, Math.min(s.maxDurationSec, duration));

    const opponents = Array.isArray(msg.opponents) ? msg.opponents : [];
    const maxOpp = Math.min(s.maxOpponents, C.MAX_TANKS - 1);
    if (opponents.length < 1) throw new UserError('Il faut au moins un adversaire.');
    if (opponents.length > maxOpp) throw new UserError('Au plus ' + maxOpp + ' adversaires.');

    const slots = [{ kind: 'player', userId: user.id, pseudo: user.pseudo, tankId: tank.id, tankName: tank.name, color: tank.color }];
    for (const o of opponents) {
      if (o && o.kind === 'bot') {
        const bot = getBot(o.botId);
        if (!bot) throw new UserError('Bot inconnu.');
        slots.push({ kind: 'bot', botId: bot.id });
      } else {
        slots.push({ kind: 'player', userId: null });
      }
    }

    const m = {
      uid: uid(),
      title: cleanTitle(msg.title, 'Combat de ' + user.pseudo),
      creatorId: user.id,
      creatorPseudo: user.pseudo,
      public: msg.public !== false,
      durationSec: duration,
      maxTicks: duration * C.TICKS_PER_SECOND,
      status: 'waiting',
      slots,
      createdAt: Date.now(),
      countdownEndsAt: null,
      timer: null,
      watchers: new Set(),
    };
    this.matches.set(m.uid, m);
    this.update(m);
    return m;
  }

  join(user, m, tankId) {
    if (m.status !== 'waiting') throw new UserError('Ce combat n\'accepte plus de joueurs.');
    if (m.slots.some((s) => s.userId === user.id)) return;
    this.checkFree(user.id);
    const slot = m.slots.find((s) => s.kind === 'player' && !s.userId);
    if (!slot) throw new UserError('Ce combat est complet.');
    const tank = this.tankFor(user, tankId);
    Object.assign(slot, { userId: user.id, pseudo: user.pseudo, tankId: tank.id, tankName: tank.name, color: tank.color });
    this.toast(m.creatorId, user.pseudo + ' a rejoint ton combat.');
    this.update(m);
  }

  leave(user, m) {
    if (!PENDING.has(m.status)) throw new UserError('Le combat a déjà commencé.');
    if (m.creatorId === user.id) {
      this.cancel(m, m.creatorPseudo + ' a annulé le combat.');
      return;
    }
    const slot = m.slots.find((s) => s.userId === user.id);
    if (!slot) return;
    clearSlot(slot);
    this.toast(m.creatorId, user.pseudo + ' a quitté ton combat.');
    this.update(m);
  }

  /** Retire un joueur de tous les combats qui n'ont pas commencé. */
  leaveAllPending(userId, why) {
    for (const m of [...this.matches.values()]) {
      if (!PENDING.has(m.status)) continue;
      if (m.creatorId === userId) {
        this.cancel(m, 'Combat annulé : ' + m.creatorPseudo + ' (' + why + ').');
        continue;
      }
      const slot = m.slots.find((s) => s.userId === userId);
      if (slot) {
        const pseudo = slot.pseudo;
        clearSlot(slot);
        this.toast(m.creatorId, pseudo + ' a quitté ton combat (' + why + ').');
        this.update(m);
      }
    }
  }

  requireCreator(user, m) {
    if (m.creatorId !== user.id && user.role !== 'teacher') throw new UserError('Seul le créateur du combat peut faire cela.', 403);
    if (!PENDING.has(m.status)) throw new UserError('Le combat a déjà commencé.');
  }

  kick(user, m, slotIndex) {
    this.requireCreator(user, m);
    const i = Number(slotIndex);
    const slot = m.slots[i];
    if (!slot || i === 0 || slot.kind !== 'player' || !slot.userId) return;
    const kicked = slot.userId;
    clearSlot(slot);
    this.toast(kicked, 'Tu as été retiré du combat « ' + m.title + ' ».', 'warn');
    this.update(m);
  }

  setSlot(user, m, slotIndex, kind, botId) {
    this.requireCreator(user, m);
    const i = Number(slotIndex);
    const slot = m.slots[i];
    if (!slot || i === 0) return;
    if (slot.kind === 'player' && slot.userId) throw new UserError('Cette place est occupée par un joueur : retire-le d\'abord.');
    if (kind === 'bot') {
      const bot = getBot(botId);
      if (!bot) throw new UserError('Bot inconnu.');
      m.slots[i] = { kind: 'bot', botId: bot.id };
    } else if (kind === 'player') {
      m.slots[i] = { kind: 'player', userId: null };
    } else if (kind === 'remove') {
      if (m.slots.length <= 2) throw new UserError('Il faut au moins un adversaire.');
      m.slots.splice(i, 1);
    } else if (kind === 'add') {
      const maxOpp = Math.min(this.settings().maxOpponents, C.MAX_TANKS - 1);
      if (m.slots.length - 1 >= maxOpp) throw new UserError('Au plus ' + maxOpp + ' adversaires.');
      m.slots.push({ kind: 'player', userId: null });
    }
    this.update(m);
  }

  /** Remplit les places libres avec des bots, du plus facile au plus fort. */
  fillBots(user, m) {
    this.requireCreator(user, m);
    const order = ['sentinelle', 'vagabond', 'chasseur', 'toupie'];
    let k = 0;
    m.slots.forEach((s, i) => {
      if (i > 0 && s.kind === 'player' && !s.userId) {
        m.slots[i] = { kind: 'bot', botId: order[k % order.length] };
        k++;
      }
    });
    this.update(m);
  }

  setTank(user, m, tankId) {
    if (!PENDING.has(m.status)) throw new UserError('Le combat a déjà commencé.');
    const slot = m.slots.find((s) => s.userId === user.id);
    if (!slot) return;
    const tank = this.tankFor(user, tankId);
    Object.assign(slot, { tankId: tank.id, tankName: tank.name, color: tank.color });
    this.scheduleBroadcast();
  }

  cancelBy(user, m) {
    if (m.status === 'running') {
      if (user.role !== 'teacher') throw new UserError('Seul l\'enseignant peut arrêter un combat en cours.', 403);
      this.abortRunning(m, 'Combat arrêté par ' + user.pseudo + '.');
      return;
    }
    if (!PENDING.has(m.status)) return;
    if (m.creatorId !== user.id && user.role !== 'teacher') throw new UserError('Seul le créateur du combat peut l\'annuler.', 403);
    this.cancel(m, m.creatorId === user.id ? m.creatorPseudo + ' a annulé le combat.' : 'Combat annulé par ' + user.pseudo + '.');
  }

  cancel(m, reason) {
    clearTimeout(m.timer);
    m.status = 'cancelled';
    this.queue = this.queue.filter((u) => u !== m.uid);
    this.matches.delete(m.uid);
    const msg = JSON.stringify({ type: 'cancelled', uid: m.uid, reason });
    for (const s of m.slots) {
      if (s.userId && s.userId !== m.creatorId) this.toast(s.userId, reason, 'warn');
    }
    for (const c of m.watchers) {
      this.send(c, msg);
      c.watching = null;
    }
    m.watchers.clear();
    this.scheduleBroadcast();
  }

  /** Réévalue l'état d'un combat en préparation après un changement. */
  update(m) {
    const full = m.slots.every((s) => s.kind === 'bot' || s.userId);
    if (full && m.status === 'waiting') {
      const sec = this.settings().countdownSec;
      m.status = 'countdown';
      m.countdownEndsAt = Date.now() + sec * 1000;
      clearTimeout(m.timer);
      m.timer = setTimeout(() => this.launch(m), sec * 1000);
      const msg = { type: 'countdown', uid: m.uid, endsAt: m.countdownEndsAt, now: Date.now() };
      for (const s of m.slots) if (s.userId) this.sendToUser(s.userId, msg);
    } else if (!full && (m.status === 'countdown' || m.status === 'queued')) {
      clearTimeout(m.timer);
      m.status = 'waiting';
      m.countdownEndsAt = null;
      this.queue = this.queue.filter((u) => u !== m.uid);
    }
    this.scheduleBroadcast();
  }

  /* ================= Combat en cours ================= */

  runningCount() {
    let n = 0;
    for (const m of this.matches.values()) if (m.status === 'running') n++;
    return n;
  }

  launch(m) {
    if (m.status !== 'countdown' && m.status !== 'queued') return;
    if (this.runningCount() >= this.settings().maxRunningMatches) {
      if (m.status !== 'queued') {
        m.status = 'queued';
        this.queue.push(m.uid);
        this.scheduleBroadcast();
      }
      return;
    }
    this.queue = this.queue.filter((u) => u !== m.uid);

    // programmes figés : dernière version enregistrée de chaque tank
    const specs = [];
    for (const s of m.slots) {
      if (s.kind === 'bot') {
        const bot = getBot(s.botId);
        specs.push({ name: bot.name, color: bot.color, code: bot.code, error: null, userId: null, bot: bot.id, versionId: null, tankName: bot.name, pseudo: null });
        continue;
      }
      const frozen = this.store.freezeTank(s.userId, s.tankId);
      if (!frozen) {
        const who = s.userId;
        clearSlot(s);
        this.toast(who, 'Ton tank n\'existe plus : choisis-en un autre et rejoins à nouveau le combat.', 'error');
        m.status = 'waiting';
        m.countdownEndsAt = null;
        this.update(m);
        return;
      }
      specs.push({
        name: s.pseudo, color: frozen.color, code: frozen.code, error: frozen.error ? 'programme invalide : ' + frozen.error : null,
        userId: s.userId, bot: null, versionId: frozen.versionId, tankName: frozen.name, pseudo: s.pseudo,
      });
    }

    // ordre de jeu tiré au sort (le premier tank agit en premier à chaque tick)
    for (let i = specs.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [specs[i], specs[j]] = [specs[j], specs[i]];
    }
    const distinct = distinctify(specs.map((s) => ({ name: s.name, color: s.color })));
    specs.forEach((s, i) => { s.name = distinct[i].name; s.color = distinct[i].color; });

    const seed = crypto.randomInt(1, 1000000);
    const humans = specs.filter((s) => s.userId).length;
    m.seed = seed;
    m.dbId = this.store.insertMatch({
      uid: m.uid, title: m.title, creatorId: m.creatorId, public: m.public, seed, maxTicks: m.maxTicks,
      engine: ENGINE_VERSION, humans,
      participants: specs.map((s, index) => ({ ...s, index })),
    });
    m.header = {
      uid: m.uid,
      title: m.title,
      public: m.public,
      maxTicks: m.maxTicks,
      tanks: specs.map((s, index) => ({ index, name: s.name, color: s.color, tankName: s.tankName, userId: s.userId, pseudo: s.pseudo, bot: s.bot })),
    };
    m.owners = specs.map((s) => s.userId);
    m.logs = specs.map(() => []);
    m.publicLogs = [];
    m.status = 'running';
    m.startedAt = Date.now();
    m.lastFrame = null;

    m.sim = startLive({ entrants: specs, seed, maxTicks: m.maxTicks }, {
      tick: (frame, logs) => this.onTick(m, frame, logs),
      end: (results) => this.onEnd(m, results),
      abort: (reason, culprit) => {
        const name = culprit >= 0 && m.header.tanks[culprit] ? m.header.tanks[culprit].name : null;
        this.onAbort(m, abortMessage(reason, name));
      },
    });

    const start = JSON.stringify({ type: 'start', uid: m.uid, header: m.header, startedAt: m.startedAt, now: Date.now() });
    for (const c of m.watchers) this.send(c, start);
    this.scheduleBroadcast();
  }

  onTick(m, frame, logs) {
    m.lastFrame = frame;
    const msg = '{"type":"frame","uid":' + JSON.stringify(m.uid) + ',"d":' + JSON.stringify(frame) + '}';
    for (const c of m.watchers) {
      // spectateur trop lent : on saute des images plutôt que de saturer sa connexion
      if (c.ws.bufferedAmount > 512 * 1024) continue;
      this.send(c, msg);
    }
    if (logs && logs.length) this.routeLogs(m, logs);
  }

  /** Journaux : chacun ne voit que ceux de son tank (l'enseignant voit tout). */
  routeLogs(m, logs) {
    for (const l of logs) {
      if (PUBLIC_LOG_KINDS.has(l.kind) || l.tank < 0) {
        m.publicLogs.push(l);
        if (m.publicLogs.length > MAX_LOGS_KEPT) m.publicLogs.shift();
      } else if (m.logs[l.tank]) {
        m.logs[l.tank].push(l);
        if (m.logs[l.tank].length > MAX_LOGS_KEPT) m.logs[l.tank].shift();
      }
    }
    for (const c of m.watchers) {
      const mine = logs.filter((l) => this.canSeeLog(c.user, m, l));
      if (mine.length) this.send(c, { type: 'logs', uid: m.uid, entries: mine });
    }
  }

  canSeeLog(user, m, l) {
    if (PUBLIC_LOG_KINDS.has(l.kind) || l.tank < 0) return true;
    return user.role === 'teacher' || m.owners[l.tank] === user.id;
  }

  onEnd(m, results) {
    if (m.status !== 'running') return;
    try {
      this.store.finishMatch(m.dbId, results);
    } catch (err) {
      console.error('[salon] enregistrement du résultat impossible', err);
    }
    m.status = 'finished';
    m.endedAt = Date.now();
    m.results = this.describeResults(m, results);
    m.sim = null;
    const msg = JSON.stringify({ type: 'end', uid: m.uid, results: m.results });
    for (const c of m.watchers) this.send(c, msg);
    this.archive(m);
  }

  onAbort(m, reason) {
    if (m.status !== 'running') return;
    try {
      this.store.abortMatch(m.dbId, reason);
    } catch (err) {
      console.error('[salon] enregistrement de l\'arrêt impossible', err);
    }
    m.status = 'aborted';
    m.endedAt = Date.now();
    m.abortReason = reason;
    m.sim = null;
    const msg = JSON.stringify({ type: 'end', uid: m.uid, aborted: true, reason });
    for (const c of m.watchers) this.send(c, msg);
    this.archive(m);
  }

  abortRunning(m, reason) {
    if (m.status !== 'running') return;
    if (m.sim) m.sim.stop();
    this.onAbort(m, reason);
  }

  describeResults(m, r) {
    return {
      early: r.early,
      ticks: r.ticks,
      winner: r.winner,
      ranking: r.ranking.map((x, i) => {
        const t = m.header.tanks[x.index];
        return {
          rank: i + 1, index: x.index, name: x.name, color: x.color, tankName: t.tankName, pseudo: t.pseudo, userId: t.userId, bot: t.bot,
          damageDealt: x.damageDealt, damageTaken: x.damageTaken, health: x.health, alive: x.alive, kills: x.kills,
          shots: x.shots, hits: x.hits, broken: x.broken, error: x.error,
        };
      }),
    };
  }

  /** Garde un combat terminé dans le salon pendant un moment, puis l'oublie (il reste dans l'historique). */
  archive(m) {
    this.recent.unshift(m.uid);
    while (this.recent.length > this.config.recentMatches) {
      const old = this.recent.pop();
      const om = this.matches.get(old);
      if (om && !ACTIVE.has(om.status)) {
        for (const c of om.watchers) c.watching = null;
        this.matches.delete(old);
      }
    }
    this.startQueued();
    this.scheduleBroadcast();
  }

  startQueued() {
    while (!this.closed && this.queue.length && this.runningCount() < this.settings().maxRunningMatches) {
      const m = this.matches.get(this.queue[0]);
      if (!m || m.status !== 'queued') {
        this.queue.shift();
        continue;
      }
      this.launch(m);
    }
  }

  /* ================= Spectateurs ================= */

  canWatch(user, m) {
    return m.public || user.role === 'teacher' || m.slots.some((s) => s.userId === user.id);
  }

  watch(client, id) {
    this.unwatch(client);
    const m = this.matches.get(id);
    if (!m) {
      // plus dans le salon : le navigateur ira chercher le combat dans l'historique
      this.send(client, { type: 'gone', uid: id });
      return;
    }
    if (!this.canWatch(client.user, m)) throw new UserError('Ce combat est privé : seuls ses participants peuvent le regarder.', 403);
    client.watching = id;
    m.watchers.add(client);
    this.send(client, { type: 'watching', uid: id, match: this.summary(m), now: Date.now() });
    if (m.status === 'running' || m.status === 'finished' || m.status === 'aborted') {
      if (m.header) this.send(client, { type: 'start', uid: m.uid, header: m.header, startedAt: m.startedAt, now: Date.now() });
      if (m.status === 'running' && m.lastFrame) {
        const f = { ...m.lastFrame, f: [] };
        this.send(client, { type: 'frame', uid: m.uid, d: f, late: true });
      }
      if (m.logs) {
        const visible = [...m.publicLogs];
        m.logs.forEach((list, i) => {
          if (client.user.role === 'teacher' || m.owners[i] === client.user.id) visible.push(...list);
        });
        visible.sort((a, b) => a.tick - b.tick);
        if (visible.length) this.send(client, { type: 'logs', uid: m.uid, entries: visible, history: true });
      }
      if (m.status === 'finished') this.send(client, { type: 'end', uid: m.uid, results: m.results });
      if (m.status === 'aborted') this.send(client, { type: 'end', uid: m.uid, aborted: true, reason: m.abortReason });
    }
    this.scheduleBroadcast();
  }

  unwatch(client) {
    if (!client.watching) return;
    const m = this.matches.get(client.watching);
    if (m) m.watchers.delete(client);
    client.watching = null;
    this.scheduleBroadcast();
  }

  /* ================= État du salon ================= */

  publicSettings() {
    const s = this.settings();
    return {
      minDurationSec: s.minDurationSec,
      maxDurationSec: s.maxDurationSec,
      maxOpponents: Math.min(s.maxOpponents, C.MAX_TANKS - 1),
      countdownSec: s.countdownSec,
    };
  }

  summary(m) {
    const spectators = new Set();
    for (const c of m.watchers) if (!m.slots.some((s) => s.userId === c.user.id)) spectators.add(c.user.id);
    return {
      uid: m.uid,
      title: m.title,
      status: m.status,
      public: m.public,
      durationSec: m.durationSec,
      maxTicks: m.maxTicks,
      creator: { id: m.creatorId, pseudo: m.creatorPseudo },
      createdAt: m.createdAt,
      countdownEndsAt: m.countdownEndsAt,
      startedAt: m.startedAt || null,
      endedAt: m.endedAt || null,
      queuePosition: m.status === 'queued' ? this.queue.indexOf(m.uid) + 1 : null,
      spectators: spectators.size,
      slots: m.slots.map((s) => {
        if (s.kind === 'bot') {
          const b = getBot(s.botId);
          return { kind: 'bot', botId: s.botId, name: b.name, color: b.color };
        }
        return s.userId
          ? { kind: 'player', user: { id: s.userId, pseudo: s.pseudo }, tankName: s.tankName, color: s.color }
          : { kind: 'player', user: null };
      }),
      results: m.results || null,
      abortReason: m.abortReason || null,
    };
  }

  lobbyState() {
    const players = [];
    for (const [id, e] of this.online) {
      const m = this.activeMatchOf(id);
      let status = 'idle';
      if (m) status = m.status === 'running' ? 'playing' : 'waiting';
      else if ([...e.sockets].some((c) => c.watching)) status = 'watching';
      players.push({
        id, pseudo: e.user.pseudo, role: e.user.role, status,
        matchUid: m ? m.uid : null, away: e.sockets.size === 0,
      });
    }
    players.sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr'));
    const order = { countdown: 0, queued: 1, waiting: 2, running: 3, finished: 4, aborted: 5 };
    const matches = [...this.matches.values()]
      .map((m) => this.summary(m))
      .sort((a, b) => (order[a.status] - order[b.status]) || ((b.endedAt || b.createdAt) - (a.endedAt || a.createdAt)));
    return { type: 'lobby', now: Date.now(), players, matches, settings: this.publicSettings() };
  }

  scheduleBroadcast() {
    if (this.broadcastTimer || this.closed) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const s = JSON.stringify(this.lobbyState());
      for (const c of this.clients) this.send(c, s);
    }, 80);
  }

  /** Combats en cours, pour l'administration. */
  runningMatches() {
    return [...this.matches.values()].filter((m) => ACTIVE.has(m.status)).map((m) => this.summary(m));
  }

  /** Arrêt du serveur : les combats en cours sont notés comme interrompus. */
  shutdown() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const m of this.matches.values()) {
      if (m.status === 'running') this.abortRunning(m, 'Combat interrompu (le serveur s\'est arrêté).');
      clearTimeout(m.timer);
    }
    clearTimeout(this.broadcastTimer);
    for (const e of this.online.values()) clearTimeout(e.grace);
    for (const c of this.clients) c.ws.close(1001, 'arrêt du serveur');
  }
}

function clearSlot(slot) {
  delete slot.pseudo;
  delete slot.tankId;
  delete slot.tankName;
  delete slot.color;
  slot.userId = null;
}
