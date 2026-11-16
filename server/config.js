/*
 * Configuration lue dans les variables d'environnement.
 * Les réglages de jeu (durées, nombre d'adversaires…) se changent ensuite
 * dans l'administration et sont gardés dans la base.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  /** Durée de vie d'une session (jours). */
  sessionDays: int('SESSION_DAYS', 30),
  /** Délai de grâce avant de libérer la place d'un joueur déconnecté (ms). */
  disconnectGraceMs: int('DISCONNECT_GRACE_MS', 20000),
  /** Temps maximal de calcul d'un tick (ms) avant d'arrêter un combat. */
  stepTimeoutMs: int('STEP_TIMEOUT_MS', 400),
  /** Mémoire maximale d'un combat (Mo). */
  matchMemoryMb: int('MATCH_MEMORY_MB', 128),
  /** Nombre de combats terminés gardés dans le salon. */
  recentMatches: int('RECENT_MATCHES', 12),
  /** Adresse à donner aux élèves (utile avec Docker, où le serveur ne voit pas l'adresse de l'ordinateur). */
  publicUrl: process.env.PUBLIC_URL || '',
  inDocker: !!process.env.IN_DOCKER,
};

/** Réglages modifiables dans l'administration (valeurs par défaut). */
export const DEFAULT_SETTINGS = Object.freeze({
  registrationOpen: true,
  minDurationSec: 30,
  maxDurationSec: 300,
  maxOpponents: 3,
  countdownSec: 5,
  maxRunningMatches: 16,
  maxTanksPerPlayer: 30,
});

/** Bornes imposées aux réglages. */
export const SETTINGS_LIMITS = Object.freeze({
  minDurationSec: [10, 600],
  maxDurationSec: [10, 600],
  maxOpponents: [1, 3],
  countdownSec: [0, 30],
  maxRunningMatches: [1, 64],
  maxTanksPerPlayer: [1, 200],
});
