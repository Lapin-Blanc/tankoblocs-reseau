/*
 * API HTTP (JSON) : comptes, tanks, historique, replays, classement et
 * administration. Le temps réel (salon, combats) passe par le WebSocket.
 */
import {
  hashPassword, verifyPassword, cleanPseudo, checkPassword, UserError, publicUser,
  parseCookies, sessionCookie, clearCookie, COOKIE, RateLimiter, temporaryPassword,
} from './auth.js';
import { readJson, sendJson, clientIp, lanAddresses } from './http.js';
import { publicBots, ENGINE_VERSION, TANKOBLOCS, TEMPLATE } from './tankoblocs.js';
import { runFast } from './sim/runner.js';

export function registerApi(router, { db, store, sessions, lobby, version, config }) {
  const loginLimiter = new RateLimiter(10, 10 * 60 * 1000);
  // large : avec Docker Desktop, toute la classe peut arriver avec la même adresse IP
  const registerLimiter = new RateLimiter(100, 10 * 60 * 1000);
  const replays = new ReplayCache(8);

  /* ---------- Outils ---------- */

  const token = (req) => parseCookies(req.headers.cookie)[COOKIE];

  function auth(req) {
    const u = sessions.user(token(req));
    if (!u) throw new UserError('Connecte-toi pour continuer.', 401);
    return u;
  }

  function teacher(req) {
    const u = auth(req);
    if (u.role !== 'teacher') throw new UserError('Réservé à l\'enseignant.', 403);
    return u;
  }

  const int = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new UserError('Identifiant invalide.', 400);
    return n;
  };

  function login(res, user) {
    const s = sessions.create(user.id);
    res.setHeader('Set-Cookie', sessionCookie(s.token, s.maxAge));
  }

  const ok = (req, res, data = { ok: true }, status = 200) => sendJson(req, res, status, data);

  /* ---------- État général et comptes ---------- */

  router.get('/api/status', (req, res) => {
    const settings = db.getSettings();
    ok(req, res, {
      setupNeeded: store.countUsers() === 0,
      registrationOpen: settings.registrationOpen,
      version,
      engine: ENGINE_VERSION,
      tankoblocs: TANKOBLOCS.commit ? TANKOBLOCS.commit.slice(0, 7) : null,
    });
  });

  // premier lancement : création du compte enseignant
  router.post('/api/setup', async (req, res) => {
    const body = await readJson(req);
    if (!registerLimiter.allow('setup:' + clientIp(req))) throw new UserError('Trop d\'essais, patiente quelques minutes.', 429);
    if (store.countUsers() > 0) throw new UserError('Le compte enseignant existe déjà.', 409);
    const pseudo = cleanPseudo(body.pseudo);
    const hash = await hashPassword(checkPassword(body.password));
    if (store.countUsers() > 0) throw new UserError('Le compte enseignant existe déjà.', 409);
    const user = store.createUser({ pseudo, passwordHash: hash, role: 'teacher' });
    login(res, user);
    ok(req, res, { me: publicUser(user) }, 201);
  });

  router.post('/api/register', async (req, res) => {
    const body = await readJson(req);
    if (!registerLimiter.allow('register:' + clientIp(req))) throw new UserError('Trop d\'inscriptions depuis ce poste, patiente quelques minutes.', 429);
    if (!db.getSettings().registrationOpen) throw new UserError('Les inscriptions sont fermées. Demande à l\'enseignant.', 403);
    const course = store.findCourseByCode(body.code);
    if (!course) throw new UserError('Code du cours inconnu. Vérifie-le auprès de l\'enseignant.');
    if (!course.open) throw new UserError('Les inscriptions à ce cours sont fermées.', 403);
    const pseudo = cleanPseudo(body.pseudo);
    const password = checkPassword(body.password);
    if (store.findUserByPseudo(pseudo)) throw new UserError('Ce pseudo est déjà pris.', 409);
    const user = store.createUser({ pseudo, passwordHash: await hashPassword(password), courseId: course.id });
    login(res, user);
    ok(req, res, { me: publicUser(user) }, 201);
  });

  router.post('/api/login', async (req, res) => {
    const body = await readJson(req);
    const pseudo = String(body.pseudo || '').trim();
    const key = clientIp(req) + ':' + pseudo.toLowerCase();
    if (!loginLimiter.allow(key)) throw new UserError('Trop d\'essais. Patiente quelques minutes ou demande à l\'enseignant.', 429);
    const user = pseudo ? store.findUserByPseudo(pseudo) : null;
    const good = user ? await verifyPassword(String(body.password || ''), user.password_hash) : false;
    if (!good) throw new UserError('Pseudo ou mot de passe incorrect.', 401);
    if (user.disabled) throw new UserError('Ce compte est désactivé. Demande à l\'enseignant.', 403);
    loginLimiter.reset(key);
    login(res, user);
    ok(req, res, { me: publicUser(user) });
  });

  router.post('/api/logout', async (req, res) => {
    sessions.destroy(token(req));
    res.setHeader('Set-Cookie', clearCookie());
    ok(req, res);
  });

  router.get('/api/me', (req, res) => {
    const me = auth(req);
    ok(req, res, { me, stats: store.stats(me.id) });
  });

  router.post('/api/me/password', async (req, res) => {
    const me = auth(req);
    const body = await readJson(req);
    const row = store.getUser(me.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) throw new UserError('Mot de passe actuel incorrect.', 403);
    const next = checkPassword(body.next);
    store.setPassword(me.id, await hashPassword(next), false);
    sessions.destroyAllFor(me.id, token(req));
    ok(req, res, { me: publicUser(store.getUser(me.id)) });
  });

  /* ---------- Bots et modèle de départ ---------- */

  router.get('/api/bots', (req, res) => {
    auth(req);
    ok(req, res, { bots: publicBots(), template: TEMPLATE });
  });

  /* ---------- Tanks ---------- */

  router.get('/api/tanks', (req, res) => {
    const me = auth(req);
    ok(req, res, { tanks: store.listTanks(me.id), max: db.getSettings().maxTanksPerPlayer });
  });

  router.post('/api/tanks', async (req, res) => {
    const me = auth(req);
    const body = await readJson(req);
    const tank = store.createTank(me.id, { ...body, workspace: body.workspace || TEMPLATE }, db.getSettings().maxTanksPerPlayer);
    ok(req, res, { tank }, 201);
  });

  router.get('/api/tanks/:id', (req, res, p) => {
    const me = auth(req);
    const tank = store.getTank(me.id, int(p.id));
    if (!tank) throw new UserError('Tank introuvable.', 404);
    ok(req, res, { tank });
  });

  router.put('/api/tanks/:id', async (req, res, p) => {
    const me = auth(req);
    const body = await readJson(req);
    const tank = store.updateTank(me.id, int(p.id), body);
    ok(req, res, { tank: { id: tank.id, name: tank.name, color: tank.color, updatedAt: tank.updatedAt } });
  });

  router.delete('/api/tanks/:id', (req, res, p) => {
    const me = auth(req);
    store.deleteTank(me.id, int(p.id));
    ok(req, res);
  });

  // reprendre dans l'atelier la version d'un programme utilisée dans un combat
  router.get('/api/versions/:id', (req, res, p) => {
    const me = auth(req);
    const ws = store.getVersionWorkspace(me.id, int(p.id));
    if (!ws) throw new UserError('Version introuvable.', 404);
    ok(req, res, { workspace: ws });
  });

  /* ---------- Combats terminés ---------- */

  function visibleMatch(me, uid) {
    const d = store.matchDetail(String(uid));
    if (!d) throw new UserError('Combat introuvable.', 404);
    const mine = d.participants.some((x) => x.userId === me.id);
    if (!d.public && !mine && me.role !== 'teacher') throw new UserError('Ce combat est privé.', 403);
    return d;
  }

  router.get('/api/matches', (req, res, p, url) => {
    const me = auth(req);
    const scope = url.searchParams.get('scope');
    const before = Number(url.searchParams.get('before')) || null;
    const limit = Number(url.searchParams.get('limit')) || 30;
    let list;
    if (scope === 'all') {
      list = store.listMatches({ limit, before, onlyPublic: me.role !== 'teacher' });
    } else {
      list = store.listMatches({ userId: me.id, limit, before });
    }
    ok(req, res, { matches: list });
  });

  router.get('/api/matches/:uid', (req, res, p) => {
    const me = auth(req);
    ok(req, res, { match: visibleMatch(me, p.uid) });
  });

  router.get('/api/matches/:uid/replay', async (req, res, p) => {
    const me = auth(req);
    const d = visibleMatch(me, p.uid);
    if (d.status !== 'finished') throw new UserError('Seuls les combats terminés peuvent être revus.', 409);
    let entry = replays.get(d.uid);
    if (!entry) {
      const row = store.getMatchRow(d.uid);
      const parts = store.getParticipants(row.id);
      let sim;
      try {
        sim = await runFast({
          entrants: parts.map((x) => ({ name: x.name, color: x.color, code: x.code, error: x.error || null })),
          seed: row.seed,
          maxTicks: row.max_ticks,
        });
      } catch (err) {
        throw new UserError('Impossible de recalculer ce combat (' + (err.reason || err.message) + ').', 500);
      }
      // même déroulement qu'en direct ? (sinon : moteur mis à jour entre-temps)
      const consistent = sim.results.ranking.every((r) => {
        const x = d.participants.find((q) => q.index === r.index);
        return x && x.damageDealt === r.damageDealt && x.health === r.health;
      }) && sim.results.ticks === d.ticks;
      entry = { frames: '[' + sim.frames.join(',') + ']', logs: sim.logs, consistent };
      replays.set(d.uid, entry);
    }
    const owners = new Map(d.participants.map((x) => [x.index, x.userId]));
    const logs = entry.logs.filter((l) => l.kind === 'info' || l.tank < 0 || me.role === 'teacher' || owners.get(l.tank) === me.id);
    const body = '{"match":' + JSON.stringify(d) + ',"consistent":' + entry.consistent + ',"sameEngine":' + (d.engine === ENGINE_VERSION)
      + ',"logs":' + JSON.stringify(logs) + ',"frames":' + entry.frames + '}';
    sendJson(req, res, 200, body);
  });

  /* ---------- Classement ---------- */

  router.get('/api/leaderboard', (req, res, p, url) => {
    const me = auth(req);
    const c = url.searchParams.get('course');
    const courseId = c === 'all' || !c ? null : Number(c) || null;
    ok(req, res, { rows: store.leaderboard(courseId), courses: store.listCourseNames(), myCourse: me.courseId });
  });

  /* ---------- Administration ---------- */

  router.get('/api/admin/courses', (req, res) => {
    teacher(req);
    ok(req, res, { courses: store.listCourses() });
  });

  router.post('/api/admin/courses', async (req, res) => {
    teacher(req);
    const body = await readJson(req);
    ok(req, res, { course: store.createCourse(body.name) }, 201);
  });

  router.put('/api/admin/courses/:id', async (req, res, p) => {
    teacher(req);
    const body = await readJson(req);
    ok(req, res, { course: store.updateCourse(int(p.id), body) });
  });

  router.delete('/api/admin/courses/:id', (req, res, p) => {
    teacher(req);
    store.deleteCourse(int(p.id));
    ok(req, res);
  });

  router.get('/api/admin/users', (req, res) => {
    teacher(req);
    ok(req, res, { users: store.listUsers(), courses: store.listCourses() });
  });

  router.put('/api/admin/users/:id', async (req, res, p) => {
    const me = teacher(req);
    const id = int(p.id);
    const body = await readJson(req);
    const patch = {};
    if (body.pseudo !== undefined) patch.pseudo = cleanPseudo(body.pseudo);
    if (body.courseId !== undefined) patch.courseId = body.courseId === null ? null : int(body.courseId);
    if (body.role !== undefined) patch.role = body.role;
    if (body.disabled !== undefined) {
      if (id === me.id && body.disabled) throw new UserError('Tu ne peux pas désactiver ton propre compte.');
      patch.disabled = !!body.disabled;
    }
    const u = store.updateUser(id, patch);
    if (u.disabled) {
      sessions.destroyAllFor(id);
      lobby.refreshUser(id, null);
    } else {
      lobby.refreshUser(id, publicUser(u));
    }
    ok(req, res);
  });

  router.post('/api/admin/users/:id/password', (req, res, p) => {
    teacher(req);
    const id = int(p.id);
    const u = store.getUser(id);
    if (!u) throw new UserError('Joueur introuvable.', 404);
    const pw = temporaryPassword();
    // le hachage est asynchrone : on répond quand il est fini
    return hashPassword(pw).then((h) => {
      store.setPassword(id, h, true);
      sessions.destroyAllFor(id);
      lobby.refreshUser(id, null);
      ok(req, res, { password: pw });
    });
  });

  router.delete('/api/admin/users/:id', (req, res, p) => {
    const me = teacher(req);
    const id = int(p.id);
    if (id === me.id) throw new UserError('Tu ne peux pas supprimer ton propre compte.');
    lobby.refreshUser(id, null);
    store.deleteUser(id);
    ok(req, res);
  });

  router.get('/api/admin/users/:id/tanks', (req, res, p) => {
    teacher(req);
    const id = int(p.id);
    const u = store.getUser(id);
    if (!u) throw new UserError('Joueur introuvable.', 404);
    const tanks = store.listTanks(id).map((t) => store.getTank(id, t.id));
    ok(req, res, { pseudo: u.pseudo, tanks });
  });

  router.get('/api/admin/settings', (req, res) => {
    teacher(req);
    ok(req, res, { settings: db.getSettings() });
  });

  router.put('/api/admin/settings', async (req, res) => {
    teacher(req);
    const body = await readJson(req);
    const settings = db.setSettings(body);
    lobby.scheduleBroadcast();
    ok(req, res, { settings });
  });

  // adresses à donner aux élèves
  router.get('/api/admin/network', (req, res) => {
    teacher(req);
    ok(req, res, {
      publicUrl: config.publicUrl || null,
      inDocker: config.inDocker,
      addresses: config.inDocker ? [] : lanAddresses(config.port),
      port: Number(process.env.PUBLIC_PORT) || config.port,
    });
  });

  router.get('/api/admin/live', (req, res) => {
    teacher(req);
    ok(req, res, { matches: lobby.runningMatches() });
  });
}

/** Petit cache des replays recalculés (les plus récents). */
class ReplayCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(k) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(k, v) {
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
