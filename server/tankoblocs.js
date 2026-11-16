/*
 * Chargement des fichiers partagés avec TankoBlocs (vendor/tankoblocs).
 *
 * - Les programmes sont compilés ICI, à partir de l'état Blockly envoyé par
 *   le navigateur : le serveur n'accepte jamais de JavaScript tout fait.
 * - Les combats, eux, tournent dans des fils d'exécution séparés
 *   (sim/worker.js), qui reçoivent seulement le code compilé.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './config.js';

const require = createRequire(import.meta.url);
const VENDOR = path.join(ROOT, 'vendor', 'tankoblocs');

/** Taille maximale d'un état Blockly (octets, une fois en JSON). */
export const MAX_WORKSPACE_BYTES = 512 * 1024;
/** Taille maximale du code compilé. */
const MAX_CODE_BYTES = 512 * 1024;

function read(rel) {
  return fs.readFileSync(path.join(VENDOR, rel), 'utf8');
}

/** Sources du moteur exécutées dans les fils de simulation. */
export const SIM_SOURCES = [
  ['engine.js', read('js/engine.js')],
  ['runtime.js', read('js/runtime.js')],
];

const COMPILER_SOURCES = SIM_SOURCES.concat([
  ['blocks.js', read('js/blocks.js')],
  ['bots.js', read('js/bots.js')],
]);

/**
 * Version des règles : empreinte du moteur, de l'exécution, des blocs et
 * des tanks d'exemple. Un combat rejoué avec une autre version peut se
 * dérouler autrement.
 */
export const ENGINE_VERSION = crypto
  .createHash('sha256')
  .update(COMPILER_SOURCES.map(([, s]) => s).join('\n'))
  .digest('hex')
  .slice(0, 12);

export const TANKOBLOCS = (() => {
  try {
    return JSON.parse(read('VERSION.json'));
  } catch {
    return { commit: null };
  }
})();

/* ---------- Blockly sans affichage ---------- */

const Blockly = require('blockly');
Blockly.setLocale(require('blockly/msg/fr'));
globalThis.Blockly = Blockly;
globalThis.javascript = require('blockly/javascript');
for (const [name, src] of COMPILER_SOURCES) vm.runInThisContext(src, { filename: 'tankoblocs/' + name });

const { TankBlocks, TankBots, TankRuntime, TankEngine } = globalThis;

export const C = TankEngine.C;
export const MAX_TANKS = C.MAX_TANKS;
export const TEMPLATE = TankBots.TEMPLATE;
export const PALETTE = TankRuntime.PALETTE;

/**
 * Compile un état Blockly.
 * @returns {{ code: string|null, error: string|null, blocks: number }}
 */
export function compile(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return { code: null, error: 'programme vide ou illisible', blocks: 0 };
  }
  const json = JSON.stringify(workspace);
  if (json.length > MAX_WORKSPACE_BYTES) return { code: null, error: 'programme trop gros', blocks: 0 };
  // Blockly signale les valeurs refusées dans la console : on les garde pour nous
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const info = TankBlocks.describeState(workspace);
    const code = TankBlocks.compileState(workspace, true);
    if (code.length > MAX_CODE_BYTES) return { code: null, error: 'programme trop gros', blocks: info.blocks };
    return { code, error: null, blocks: info.blocks, warnings };
  } catch (err) {
    return { code: null, error: 'programme illisible : ' + ((err && err.message) || err), blocks: 0 };
  } finally {
    console.warn = warn;
  }
}

/* ---------- Tanks d'exemple (bots) ---------- */

export const BOTS = TankBots.EXAMPLES.map((b) => {
  const c = compile(b.workspace);
  if (c.error) throw new Error('bot ' + b.id + ' : ' + c.error);
  return {
    id: b.id.replace(/^ex-/, ''),
    name: b.name,
    color: b.color,
    level: b.level,
    description: b.description,
    code: c.code,
  };
});

const BOT_MAP = new Map(BOTS.map((b) => [b.id, b]));

export function getBot(id) {
  return BOT_MAP.get(String(id)) || null;
}

export function publicBots() {
  return BOTS.map(({ id, name, color, level, description }) => ({ id, name, color, level, description }));
}

/** Noms et couleurs distincts, exactement comme dans TankoBlocs. */
export function distinctify(specs) {
  return TankRuntime.distinctify(specs);
}

/** Empreinte stable d'un état Blockly. */
export function workspaceHash(json) {
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 24);
}

export function isColor(s) {
  return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
}
