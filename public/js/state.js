/*
 * État partagé par les vues : joueur connecté, ses tanks, le salon.
 */
import { GET, Socket } from './net.js';
import { prefs } from './ui.js';

const listeners = new Map();

export const state = {
  me: null,
  bots: [], // { id, name, color, level, description }
  template: null,
  tanks: [], // { id, name, color, updatedAt }
  maxTanks: 30,
  lobby: { players: [], matches: [] },
  settings: { minDurationSec: 30, maxDurationSec: 300, maxOpponents: 3, countdownSec: 5 },
  socket: new Socket(),
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, data) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

export async function loadTanks() {
  const r = await GET('/api/tanks');
  state.tanks = r.tanks;
  state.maxTanks = r.max;
  emit('tanks', state.tanks);
  return state.tanks;
}

export async function loadBots() {
  const r = await GET('/api/bots');
  state.bots = r.bots;
  state.template = r.template;
}

/** Met à jour un tank dans la liste locale (après enregistrement). */
export function patchTank(t) {
  const i = state.tanks.findIndex((x) => x.id === t.id);
  if (i >= 0) state.tanks[i] = { ...state.tanks[i], ...t };
  else state.tanks.unshift(t);
  emit('tanks', state.tanks);
}

/* ---------- Tank choisi pour les combats ---------- */

export function selectedTankId() {
  const id = prefs.get('tank.' + (state.me && state.me.id), null);
  if (id && state.tanks.some((t) => t.id === id)) return id;
  return state.tanks[0] ? state.tanks[0].id : null;
}

export function setSelectedTank(id) {
  prefs.set('tank.' + state.me.id, id);
  emit('selectedTank', id);
}

export function botById(id) {
  return state.bots.find((b) => b.id === id) || null;
}

/** Combat actif (pas terminé) auquel participe le joueur. */
export function myActiveMatch() {
  if (!state.me) return null;
  return state.lobby.matches.find((m) => ['waiting', 'countdown', 'queued', 'running'].includes(m.status)
    && m.slots.some((s) => s.user && s.user.id === state.me.id)) || null;
}

export function isTeacher() {
  return !!state.me && state.me.role === 'teacher';
}

/* ---------- Programmes : compilation dans le navigateur (entraînement) ---------- */

export function compileWorkspace(ws) {
  try {
    return { code: window.TankBlocks.compileState(ws, true), error: null };
  } catch (err) {
    return { code: '', error: 'programme illisible : ' + ((err && err.message) || err) };
  }
}

let botCodes = null;

/** Code compilé des bots (dans le navigateur, pour l'entraînement). */
export function botCode(id) {
  if (!botCodes) {
    botCodes = new Map();
    for (const b of window.TankBots.EXAMPLES) {
      botCodes.set(b.id.replace(/^ex-/, ''), compileWorkspace(b.workspace).code);
    }
  }
  return botCodes.get(id) || '';
}

export function botWorkspace(id) {
  const b = window.TankBots.EXAMPLES.find((x) => x.id === 'ex-' + id);
  return b ? b.workspace : null;
}
