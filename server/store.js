/*
 * Accès aux données : joueurs, cours, tanks, versions figées, combats.
 * Toutes les requêtes SQL sont ici.
 */
import { now } from './db.js';
import { courseCode, UserError } from './auth.js';
import { compile, workspaceHash, isColor, MAX_WORKSPACE_BYTES, PALETTE } from './tankoblocs.js';

export class Store {
  constructor(db) {
    this.db = db;
  }

  /* ---------- Joueurs ---------- */

  countUsers() {
    return this.db.get('SELECT COUNT(*) AS n FROM users').n;
  }

  findUserByPseudo(pseudo) {
    return this.db.get('SELECT * FROM users WHERE pseudo_key = ?', pseudoKey(pseudo)) || null;
  }

  getUser(id) {
    return this.db.get('SELECT * FROM users WHERE id = ?', id) || null;
  }

  createUser({ pseudo, passwordHash, role = 'player', courseId = null, mustChangePassword = false }) {
    if (this.findUserByPseudo(pseudo)) throw new UserError('Ce pseudo est déjà pris.', 409);
    const r = this.db.run(
      'INSERT INTO users (pseudo, pseudo_key, password_hash, role, course_id, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      pseudo, pseudoKey(pseudo), passwordHash, role, courseId, mustChangePassword, now(),
    );
    return this.getUser(Number(r.lastInsertRowid));
  }

  setPassword(id, passwordHash, mustChange) {
    this.db.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', passwordHash, mustChange, id);
  }

  listUsers() {
    return this.db.all(`
      SELECT u.id, u.pseudo, u.role, u.course_id, u.disabled, u.must_change_password, u.created_at, u.last_seen_at,
             c.name AS course_name,
             (SELECT COUNT(*) FROM tanks t WHERE t.user_id = u.id) AS tanks,
             (SELECT COUNT(*) FROM participants p JOIN matches m ON m.id = p.match_id
               WHERE p.user_id = u.id AND m.status = 'finished') AS matches
      FROM users u LEFT JOIN courses c ON c.id = u.course_id
      ORDER BY u.role DESC, c.name, u.pseudo_key`).map((u) => ({
      id: u.id,
      pseudo: u.pseudo,
      role: u.role,
      courseId: u.course_id,
      courseName: u.course_name,
      disabled: !!u.disabled,
      mustChangePassword: !!u.must_change_password,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      tanks: u.tanks,
      matches: u.matches,
    }));
  }

  updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) throw new UserError('Joueur introuvable.', 404);
    if (patch.pseudo !== undefined && patch.pseudo !== u.pseudo) {
      const other = this.findUserByPseudo(patch.pseudo);
      if (other && other.id !== id) throw new UserError('Ce pseudo est déjà pris.', 409);
      this.db.run('UPDATE users SET pseudo = ?, pseudo_key = ? WHERE id = ?', patch.pseudo, pseudoKey(patch.pseudo), id);
    }
    if (patch.courseId !== undefined) {
      if (patch.courseId !== null && !this.getCourse(patch.courseId)) throw new UserError('Cours introuvable.', 404);
      this.db.run('UPDATE users SET course_id = ? WHERE id = ?', patch.courseId, id);
    }
    if (patch.role !== undefined) {
      if (patch.role !== 'player' && patch.role !== 'teacher') throw new UserError('Rôle inconnu.');
      if (u.role === 'teacher' && patch.role !== 'teacher' && this.countTeachers() <= 1) {
        throw new UserError('Il doit rester au moins un compte enseignant.');
      }
      this.db.run('UPDATE users SET role = ? WHERE id = ?', patch.role, id);
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && u.role === 'teacher' && this.countTeachers(true) <= 1) {
        throw new UserError('Impossible de désactiver le dernier compte enseignant.');
      }
      this.db.run('UPDATE users SET disabled = ? WHERE id = ?', !!patch.disabled, id);
    }
    return this.getUser(id);
  }

  countTeachers(activeOnly) {
    return this.db.get('SELECT COUNT(*) AS n FROM users WHERE role = \'teacher\'' + (activeOnly ? ' AND disabled = 0' : '')).n;
  }

  deleteUser(id) {
    const u = this.getUser(id);
    if (!u) throw new UserError('Joueur introuvable.', 404);
    if (u.role === 'teacher' && this.countTeachers() <= 1) throw new UserError('Impossible de supprimer le dernier compte enseignant.');
    this.db.run('DELETE FROM users WHERE id = ?', id);
  }

  /* ---------- Cours ---------- */

  getCourse(id) {
    return this.db.get('SELECT * FROM courses WHERE id = ?', id) || null;
  }

  findCourseByCode(code) {
    return this.db.get('SELECT * FROM courses WHERE code = ? COLLATE NOCASE', String(code || '').trim()) || null;
  }

  listCourses() {
    return this.db.all(`
      SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.course_id = c.id) AS players
      FROM courses c ORDER BY c.name COLLATE NOCASE`).map((c) => ({
      id: c.id, name: c.name, code: c.code, open: !!c.open, players: c.players, createdAt: c.created_at,
    }));
  }

  /** Cours visibles par tous (pour filtrer le classement). */
  listCourseNames() {
    return this.db.all('SELECT id, name FROM courses ORDER BY name COLLATE NOCASE');
  }

  uniqueCode() {
    for (let i = 0; i < 50; i++) {
      const code = courseCode();
      if (!this.findCourseByCode(code)) return code;
    }
    throw new Error('impossible de trouver un code libre');
  }

  createCourse(name) {
    const n = cleanName(name, 'Le nom du cours', 60);
    const r = this.db.run('INSERT INTO courses (name, code, open, created_at) VALUES (?, ?, 1, ?)', n, this.uniqueCode(), now());
    return this.getCourse(Number(r.lastInsertRowid));
  }

  updateCourse(id, patch) {
    const c = this.getCourse(id);
    if (!c) throw new UserError('Cours introuvable.', 404);
    if (patch.name !== undefined) this.db.run('UPDATE courses SET name = ? WHERE id = ?', cleanName(patch.name, 'Le nom du cours', 60), id);
    if (patch.open !== undefined) this.db.run('UPDATE courses SET open = ? WHERE id = ?', !!patch.open, id);
    if (patch.regenerateCode) this.db.run('UPDATE courses SET code = ? WHERE id = ?', this.uniqueCode(), id);
    return this.getCourse(id);
  }

  deleteCourse(id) {
    if (!this.getCourse(id)) throw new UserError('Cours introuvable.', 404);
    this.db.run('DELETE FROM courses WHERE id = ?', id);
  }

  /* ---------- Tanks ---------- */

  listTanks(userId) {
    return this.db.all('SELECT id, name, color, created_at, updated_at FROM tanks WHERE user_id = ? ORDER BY updated_at DESC', userId)
      .map(tankSummary);
  }

  countTanks(userId) {
    return this.db.get('SELECT COUNT(*) AS n FROM tanks WHERE user_id = ?', userId).n;
  }

  /** Tank d'un joueur (null s'il n'existe pas ou appartient à quelqu'un d'autre). */
  getTank(userId, id) {
    const t = this.db.get('SELECT * FROM tanks WHERE id = ? AND user_id = ?', id, userId);
    return t ? tankFull(t) : null;
  }

  createTank(userId, data, maxTanks) {
    if (this.countTanks(userId) >= maxTanks) throw new UserError('Tu as atteint le nombre maximal de tanks (' + maxTanks + '). Supprimes-en un d\'abord.');
    const name = cleanName(data.name || 'Mon tank', 'Le nom du tank', 40);
    const color = isColor(data.color) ? data.color.toLowerCase() : PALETTE[0];
    const workspace = workspaceJson(data.workspace);
    const t = now();
    const r = this.db.run('INSERT INTO tanks (user_id, name, color, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, name, color, workspace, t, t);
    return this.getTank(userId, Number(r.lastInsertRowid));
  }

  updateTank(userId, id, data) {
    const tank = this.getTank(userId, id);
    if (!tank) throw new UserError('Tank introuvable.', 404);
    const name = data.name !== undefined ? cleanName(data.name, 'Le nom du tank', 40) : tank.name;
    const color = data.color !== undefined && isColor(data.color) ? data.color.toLowerCase() : tank.color;
    const workspace = data.workspace !== undefined ? workspaceJson(data.workspace) : JSON.stringify(tank.workspace);
    this.db.run('UPDATE tanks SET name = ?, color = ?, workspace = ?, updated_at = ? WHERE id = ?', name, color, workspace, now(), id);
    return this.getTank(userId, id);
  }

  deleteTank(userId, id) {
    const r = this.db.run('DELETE FROM tanks WHERE id = ? AND user_id = ?', id, userId);
    if (!r.changes) throw new UserError('Tank introuvable.', 404);
  }

  /**
   * Fige la version actuelle d'un tank (programme compilé).
   * Une version identique déjà figée est réutilisée.
   */
  freezeTank(userId, tankId) {
    const row = this.db.get('SELECT * FROM tanks WHERE id = ? AND user_id = ?', tankId, userId);
    if (!row) return null;
    const hash = workspaceHash(row.workspace);
    let v = this.db.get('SELECT id, code, error FROM tank_versions WHERE tank_id = ? AND hash = ?', tankId, hash);
    if (!v) {
      let parsed = null;
      try { parsed = JSON.parse(row.workspace); } catch { /* programme abîmé */ }
      const c = compile(parsed);
      const r = this.db.run('INSERT INTO tank_versions (tank_id, user_id, hash, workspace, code, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        tankId, userId, hash, row.workspace, c.code, c.error, now());
      v = { id: Number(r.lastInsertRowid), code: c.code, error: c.error };
    }
    return { versionId: v.id, code: v.code, error: v.error, name: row.name, color: row.color, tankId };
  }

  /** Programme (état Blockly) d'une version figée, pour la reprendre dans l'atelier. */
  getVersionWorkspace(userId, versionId) {
    const v = this.db.get('SELECT workspace, user_id FROM tank_versions WHERE id = ?', versionId);
    if (!v || v.user_id !== userId) return null;
    try { return JSON.parse(v.workspace); } catch { return null; }
  }

  /* ---------- Combats ---------- */

  insertMatch(m) {
    return this.db.tx(() => {
      const r = this.db.run(
        `INSERT INTO matches (uid, title, creator_id, public, seed, max_ticks, engine, status, humans, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        m.uid, m.title, m.creatorId, m.public, m.seed, m.maxTicks, m.engine, m.humans, now(),
      );
      const id = Number(r.lastInsertRowid);
      for (const p of m.participants) {
        this.db.run(
          `INSERT INTO participants (match_id, idx, user_id, bot, version_id, name, tank_name, color, code, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, p.index, p.userId, p.bot, p.versionId, p.name, p.tankName, p.color, p.code, p.error,
        );
      }
      return id;
    });
  }

  finishMatch(id, results) {
    this.db.tx(() => {
      this.db.run('UPDATE matches SET status = \'finished\', ended_at = ?, ticks = ?, winner = ?, early = ? WHERE id = ?',
        now(), results.ticks, results.winner, results.early, id);
      results.ranking.forEach((r, i) => {
        this.db.run(
          `UPDATE participants SET rank = ?, damage_dealt = ?, damage_taken = ?, health = ?, alive = ?, kills = ?,
             shots = ?, hits = ?, broken = ?, final_error = ? WHERE match_id = ? AND idx = ?`,
          i + 1, r.damageDealt, r.damageTaken, r.health, r.alive, r.kills, r.shots, r.hits, r.broken, r.error, id, r.index,
        );
      });
    });
  }

  abortMatch(id, reason) {
    this.db.run('UPDATE matches SET status = \'aborted\', abort_reason = ?, ended_at = ? WHERE id = ?', reason, now(), id);
  }

  /** Au démarrage : les combats « en cours » d'une exécution précédente sont perdus. */
  markInterrupted() {
    this.db.run('UPDATE matches SET status = \'aborted\', abort_reason = ?, ended_at = ? WHERE status = \'running\'',
      'Combat interrompu (le serveur a redémarré).', now());
  }

  getMatchRow(uid) {
    return this.db.get('SELECT * FROM matches WHERE uid = ?', uid) || null;
  }

  getParticipants(matchId) {
    return this.db.all('SELECT * FROM participants WHERE match_id = ? ORDER BY idx', matchId);
  }

  /** Combat complet, prêt à être envoyé au navigateur (sans les programmes). */
  matchDetail(uid) {
    const m = this.getMatchRow(uid);
    if (!m) return null;
    const creator = m.creator_id ? this.getUser(m.creator_id) : null;
    const parts = this.getParticipants(m.id);
    const pseudos = new Map();
    for (const p of parts) {
      if (p.user_id && !pseudos.has(p.user_id)) {
        const u = this.getUser(p.user_id);
        pseudos.set(p.user_id, u ? u.pseudo : null);
      }
    }
    return {
      uid: m.uid,
      title: m.title,
      public: !!m.public,
      status: m.status,
      abortReason: m.abort_reason,
      creator: creator ? { id: creator.id, pseudo: creator.pseudo } : null,
      maxTicks: m.max_ticks,
      engine: m.engine,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      ticks: m.ticks,
      winner: m.winner,
      early: !!m.early,
      humans: m.humans,
      participants: parts.map((p) => ({
        index: p.idx,
        name: p.name,
        tankName: p.tank_name,
        color: p.color,
        userId: p.user_id,
        pseudo: p.user_id ? pseudos.get(p.user_id) : null,
        bot: p.bot,
        versionId: p.version_id,
        rank: p.rank,
        damageDealt: p.damage_dealt,
        damageTaken: p.damage_taken,
        health: p.health,
        alive: p.alive === null ? null : !!p.alive,
        kills: p.kills,
        shots: p.shots,
        hits: p.hits,
        broken: p.broken === null ? null : !!p.broken,
        error: p.final_error || p.error,
      })),
    };
  }

  /** Historique d'un joueur (ou de tous les combats si userId est null). */
  listMatches({ userId = null, limit = 30, before = null, onlyPublic = false }) {
    const where = ['m.status <> \'running\''];
    const params = [];
    if (userId !== null) {
      where.push('m.id IN (SELECT match_id FROM participants WHERE user_id = ?)');
      params.push(userId);
    }
    if (onlyPublic) where.push('m.public = 1');
    if (before) {
      where.push('m.id < ?');
      params.push(before);
    }
    params.push(Math.max(1, Math.min(100, limit | 0)));
    const rows = this.db.all(`SELECT m.* FROM matches m WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, ...params);
    return rows.map((m) => {
      const parts = this.db.all(
        `SELECT p.idx, p.name, p.tank_name, p.color, p.user_id, p.bot, p.rank, p.damage_dealt, p.broken
         FROM participants p WHERE p.match_id = ? ORDER BY COALESCE(p.rank, 99), p.idx`, m.id);
      return {
        id: m.id,
        uid: m.uid,
        title: m.title,
        public: !!m.public,
        status: m.status,
        abortReason: m.abort_reason,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        ticks: m.ticks,
        maxTicks: m.max_ticks,
        winner: m.winner,
        humans: m.humans,
        participants: parts.map((p) => ({
          index: p.idx, name: p.name, tankName: p.tank_name, color: p.color, userId: p.user_id, bot: p.bot,
          rank: p.rank, damageDealt: p.damage_dealt, broken: !!p.broken,
        })),
      };
    });
  }

  /** Classement : combats contre d'autres joueurs, et combats contre les bots seulement. */
  leaderboard(courseId) {
    const rows = this.db.all(`
      SELECT u.id, u.pseudo, u.course_id, c.name AS course_name,
        COUNT(CASE WHEN m.humans >= 2 THEN 1 END) AS pvp_played,
        COUNT(CASE WHEN m.humans >= 2 AND m.winner = p.idx THEN 1 END) AS pvp_wins,
        COALESCE(SUM(CASE WHEN m.humans >= 2 THEN p.damage_dealt END), 0) AS pvp_damage,
        COUNT(CASE WHEN m.humans = 1 THEN 1 END) AS bot_played,
        COUNT(CASE WHEN m.humans = 1 AND m.winner = p.idx THEN 1 END) AS bot_wins
      FROM users u
      LEFT JOIN courses c ON c.id = u.course_id
      LEFT JOIN participants p ON p.user_id = u.id
      LEFT JOIN matches m ON m.id = p.match_id AND m.status = 'finished'
      WHERE u.disabled = 0 AND (? IS NULL OR u.course_id = ?)
      GROUP BY u.id`, courseId, courseId);
    const list = rows.map((r) => ({
      id: r.id,
      pseudo: r.pseudo,
      courseId: r.course_id,
      courseName: r.course_name,
      pvpPlayed: r.pvp_played,
      pvpWins: r.pvp_wins,
      pvpRate: r.pvp_played ? r.pvp_wins / r.pvp_played : 0,
      pvpDamage: r.pvp_played ? r.pvp_damage / r.pvp_played : 0,
      botPlayed: r.bot_played,
      botWins: r.bot_wins,
    }));
    list.sort((a, b) => (b.pvpWins - a.pvpWins) || (b.pvpRate - a.pvpRate) || (b.pvpDamage - a.pvpDamage)
      || (b.botWins - a.botWins) || a.pseudo.localeCompare(b.pseudo, 'fr'));
    return list;
  }

  /** Statistiques d'un joueur. */
  stats(userId) {
    return this.leaderboard(null).find((r) => r.id === userId) || null;
  }
}

/* ---------- Outils ---------- */

/** Clé de recherche d'un pseudo : sans distinction de majuscules (accents compris). */
export function pseudoKey(pseudo) {
  return String(pseudo || '').normalize('NFC').trim().toLocaleLowerCase('fr');
}

function cleanName(value, label, max) {
  const s = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) throw new UserError(label + ' ne peut pas être vide.');
  return s.slice(0, max);
}

function workspaceJson(ws) {
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) throw new UserError('Programme illisible.');
  const json = JSON.stringify(ws);
  if (json.length > MAX_WORKSPACE_BYTES) throw new UserError('Programme trop gros.', 413);
  return json;
}

function tankSummary(t) {
  return { id: t.id, name: t.name, color: t.color, createdAt: t.created_at, updatedAt: t.updated_at };
}

function tankFull(t) {
  let workspace = {};
  try { workspace = JSON.parse(t.workspace); } catch { /* programme abîmé */ }
  return { ...tankSummary(t), workspace };
}
