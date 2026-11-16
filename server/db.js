/*
 * Base de données SQLite (module node:sqlite intégré à Node, aucune
 * dépendance à compiler).
 *
 * Le schéma est versionné avec PRAGMA user_version : chaque migration
 * s'applique une seule fois, dans l'ordre.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from './config.js';

const MIGRATIONS = [
  // 1 : schéma initial
  `
  CREATE TABLE courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    open INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    pseudo TEXT NOT NULL,
    pseudo_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'teacher')),
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE tanks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    workspace TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tanks_user ON tanks(user_id);

  -- Version figée d'un programme, créée quand un tank entre dans un combat.
  CREATE TABLE tank_versions (
    id INTEGER PRIMARY KEY,
    tank_id INTEGER REFERENCES tanks(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    hash TEXT NOT NULL,
    workspace TEXT NOT NULL,
    code TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tank_versions_tank ON tank_versions(tank_id, hash);

  CREATE TABLE matches (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    public INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    max_ticks INTEGER NOT NULL,
    engine TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'aborted')),
    abort_reason TEXT,
    humans INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    ticks INTEGER,
    winner INTEGER,
    early INTEGER
  );
  CREATE INDEX matches_started ON matches(started_at);

  CREATE TABLE participants (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    bot TEXT,
    version_id INTEGER REFERENCES tank_versions(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    tank_name TEXT NOT NULL,
    color TEXT NOT NULL,
    code TEXT,
    error TEXT,
    rank INTEGER,
    damage_dealt INTEGER,
    damage_taken INTEGER,
    health INTEGER,
    alive INTEGER,
    kills INTEGER,
    shots INTEGER,
    hits INTEGER,
    broken INTEGER,
    final_error TEXT,
    PRIMARY KEY (match_id, idx)
  );
  CREATE INDEX participants_user ON participants(user_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function now() {
  return new Date().toISOString();
}

export class Db {
  /** @param {string} file chemin du fichier, ou ':memory:' */
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.cache = new Map();
    this.db.exec('PRAGMA foreign_keys = ON');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.migrate();
  }

  migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec('PRAGMA user_version = ' + (v + 1));
      });
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) { return this.stmt(sql).get(...params.map(norm)); }
  all(sql, ...params) { return this.stmt(sql).all(...params.map(norm)); }
  run(sql, ...params) { return this.stmt(sql).run(...params.map(norm)); }

  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  close() {
    this.db.close();
  }

  /* ---------- Réglages ---------- */

  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of this.all('SELECT key, value FROM settings')) {
      if (!(row.key in DEFAULT_SETTINGS)) continue;
      try { out[row.key] = JSON.parse(row.value); } catch { /* valeur ignorée */ }
    }
    return out;
  }

  /** Enregistre les réglages valides ; renvoie les réglages complets. */
  setSettings(patch) {
    const current = this.getSettings();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[key];
      if (typeof def === 'boolean') next[key] = !!value;
      else if (typeof def === 'number') {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) continue;
        const [lo, hi] = SETTINGS_LIMITS[key] || [-Infinity, Infinity];
        next[key] = Math.max(lo, Math.min(hi, n));
      }
    }
    if (next.minDurationSec > next.maxDurationSec) next.minDurationSec = next.maxDurationSec;
    this.tx(() => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(next[key]));
      }
    });
    return next;
  }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
