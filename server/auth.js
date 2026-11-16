/*
 * Comptes et sessions.
 *
 * - Mots de passe : scrypt (node:crypto) avec un sel aléatoire.
 * - Session : jeton aléatoire dans un cookie HttpOnly ; la base ne garde
 *   que son empreinte SHA-256.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const COOKIE = 'tbr_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* ---------- Validation ---------- */

const PSEUDO_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

/** Renvoie le pseudo nettoyé, ou lève une erreur lisible. */
export function cleanPseudo(value) {
  const s = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2) throw new UserError('Le pseudo doit faire au moins 2 caractères.');
  if (s.length > 20) throw new UserError('Le pseudo doit faire au plus 20 caractères.');
  if (!PSEUDO_RE.test(s)) throw new UserError('Le pseudo ne peut contenir que des lettres, des chiffres, des espaces et . _ \' -');
  return s;
}

export function checkPassword(value) {
  const s = String(value || '');
  if (s.length < 6) throw new UserError('Le mot de passe doit faire au moins 6 caractères.');
  if (s.length > 200) throw new UserError('Le mot de passe est trop long.');
  return s;
}

/** Erreur affichée telle quelle à l'utilisateur. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------- Mots de passe et codes lisibles ---------- */

const CONS = 'bdfgjklmnprstvz';
const VOW = 'aeiou';

function syllables(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CONS[crypto.randomInt(CONS.length)] + VOW[crypto.randomInt(VOW.length)];
  return s;
}

/** Mot de passe provisoire facile à dicter, par exemple « bado-kiru-37 ». */
export function temporaryPassword() {
  return syllables(2) + '-' + syllables(2) + '-' + String(crypto.randomInt(10, 100));
}

/** Code d'inscription d'un cours, par exemple « BAKO-4821 ». */
export function courseCode() {
  return syllables(2).toUpperCase() + '-' + String(crypto.randomInt(1000, 10000));
}

/* ---------- Sessions ---------- */

export class Sessions {
  constructor(db, days) {
    this.db = db;
    this.ms = days * 24 * 3600 * 1000;
    this.lastSeenWrites = new Map();
  }

  create(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.ms).toISOString();
    this.db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, now(), expires);
    return { token, maxAge: Math.floor(this.ms / 1000) };
  }

  /** Utilisateur de la session, ou null (session absente, expirée ou compte désactivé). */
  user(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const row = this.db.get(
      `SELECT u.id, u.pseudo, u.role, u.course_id, u.disabled, u.must_change_password, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (!row || row.disabled || row.expires_at < now()) return null;
    this.touch(row.id);
    return publicUser(row);
  }

  /** Note la dernière visite (au plus une écriture par minute et par joueur). */
  touch(userId) {
    const t = Date.now();
    if ((this.lastSeenWrites.get(userId) || 0) > t - 60000) return;
    this.lastSeenWrites.set(userId, t);
    this.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), userId);
  }

  destroy(token) {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(String(token)));
  }

  destroyAllFor(userId, exceptToken) {
    if (exceptToken) this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, sha256(exceptToken));
    else this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  purge() {
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  }
}

export function publicUser(row) {
  return {
    id: row.id,
    pseudo: row.pseudo,
    role: row.role,
    courseId: row.course_id ?? null,
    mustChangePassword: !!row.must_change_password,
  };
}

/* ---------- Cookies ---------- */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignoré */ }
  }
  return out;
}

export function sessionCookie(token, maxAge) {
  return COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

export function clearCookie() {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ---------- Limitation des tentatives ---------- */

export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Renvoie false si la clé a dépassé la limite. */
  allow(key) {
    const t = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset < t) {
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
    }
    h.n++;
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
    }
    return h.n <= this.max;
  }

  reset(key) {
    this.hits.delete(key);
  }
}
