/*
 * Fil d'exécution d'un combat.
 *
 * Le moteur et les programmes des tanks tournent dans un contexte vm vide :
 * pas de `process`, pas de `require`, aucun objet du serveur. On n'y fait
 * entrer que des chaînes (JSON) et on n'en fait sortir que des chaînes.
 *
 * Le module vm n'est pas une barrière de sécurité à toute épreuve : la
 * première protection est que le serveur compile lui-même les programmes à
 * partir des blocs (server/tankoblocs.js, safeWorkspace et safeCode).
 *
 * Protections :
 *  - chaque tick est limité dans le temps (option timeout de vm) ;
 *  - la mémoire du fil est plafonnée (resourceLimits, voir runner.js) ;
 *  - les boucles des programmes sont déjà limitées par TankRuntime.
 *
 * Modes :
 *  - « live » : 60 ticks par seconde en temps réel, une image par tick ;
 *  - « fast » : tout le combat d'un coup (revoir un combat terminé).
 */
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const BOOT = `
(function (g) {
  'use strict';
  var E = g.TankEngine;
  var RT = g.TankRuntime;
  var match = null;
  var logIndex = 0;
  var MAX_LOG_TEXT = 300;
  var MAX_LOGS_PER_TICK = 40;
  g.__cur = -1;

  function guard(i, fn) {
    return function (a, b) {
      g.__cur = i;
      try { return fn(a, b); } finally { g.__cur = -1; }
    };
  }
  function wrap(brain, i) {
    if (!brain) return null;
    return { handlers: brain.handlers, start: guard(i, brain.start), run: guard(i, brain.run), events: guard(i, brain.events) };
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function roundFx(f) {
    var o = {};
    for (var k in f) {
      var v = f[k];
      o[k] = typeof v === 'number' ? r2(v) : v;
    }
    return o;
  }

  function snapshot() {
    var tanks = [];
    for (var i = 0; i < match.tanks.length; i++) {
      var t = match.tanks[i];
      var flags = (t.alive ? 1 : 0) | (t.broken ? 2 : 0) | (t.radarOn ? 4 : 0);
      tanks.push([r2(t.x), r2(t.y), r2(t.heading), r2(t.gun), r2(t.radar), t.health, flags, t.cooldown, t.damageDealt,
        t.bubble ? String(t.bubble.text) : null]);
    }
    var bullets = [];
    for (var j = 0; j < match.bullets.length; j++) {
      var b = match.bullets[j];
      if (!b.dead) bullets.push([r2(b.x), r2(b.y), r1(b.heading), b.owner]);
    }
    var fx = [];
    for (var k = 0; k < match.fx.length; k++) fx.push(roundFx(match.fx[k]));
    match.fx = [];
    var logs = [];
    var end = Math.min(match.logs.length, logIndex + MAX_LOGS_PER_TICK);
    for (var n = logIndex; n < end; n++) {
      var e = match.logs[n];
      logs.push({ tick: e.tick, tank: e.tank, kind: e.kind, text: String(e.text).slice(0, MAX_LOG_TEXT) });
    }
    logIndex = match.logs.length;
    var out = { frame: { k: match.tick, t: tanks, b: bullets, f: fx }, logs: logs };
    if (match.finished) out.end = match.results;
    return out;
  }

  g.__init = function () {
    var input = JSON.parse(g.__input);
    g.__input = null;
    var specs = RT.distinctify(input.entrants);
    var entrants = specs.map(function (s, i) {
      g.__cur = i;
      var e = RT.makeEntrant(s, i, input.seed);
      g.__cur = -1;
      if (s.error) { e.error = s.error; e.brain = null; }
      e.brain = wrap(e.brain, i);
      return e;
    });
    match = new E.Match({ entrants: entrants, seed: input.seed, maxTicks: input.maxTicks });
    return JSON.stringify(snapshot());
  };

  g.__step = function () {
    match.step();
    return JSON.stringify(snapshot());
  };

  // plusieurs ticks d'un coup (mode rapide) : un seul appel, donc un seul minuteur
  g.__steps = function (n) {
    var list = [];
    for (var i = 0; i < n && !match.finished; i++) {
      match.step();
      list.push(snapshot());
    }
    return JSON.stringify(list);
  };
})(globalThis);
`;

class SimAbort extends Error {
  constructor(reason, culprit) {
    super(reason);
    this.culprit = culprit;
  }
}

const data = workerData;
// Objet global SANS prototype : avec un objet ordinaire ({}), le code du
// contexte pourrait remonter globalThis.constructor.constructor jusqu'au
// Function du serveur, donc jusqu'à process. (vm.constants.DONT_CONTEXTIFY
// fermerait aussi ce chemin, mais Node n'applique alors plus la limite de
// mémoire du fil : un programme gourmand bloquerait tout le serveur.)
const ctx = vm.createContext(Object.create(null), { name: 'combat', codeGeneration: { strings: true, wasm: false } });
for (const [name, src] of data.sources) new vm.Script(src, { filename: name }).runInContext(ctx);
new vm.Script(BOOT, { filename: 'boot.js' }).runInContext(ctx);
const initScript = new vm.Script('__init()', { filename: 'init.js' });
const stepScript = new vm.Script('__step()', { filename: 'step.js' });

function exec(script, timeout) {
  try {
    const out = script.runInContext(ctx, { timeout, breakOnSigint: false });
    if (typeof out !== 'string') throw new SimAbort('réponse inattendue du moteur', -1);
    return JSON.parse(out);
  } catch (err) {
    if (err instanceof SimAbort) throw err;
    const cur = ctx.__cur;
    const culprit = typeof cur === 'number' ? cur : -1;
    if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SimAbort('timeout', culprit);
    let msg = 'erreur du moteur';
    try { msg += ' : ' + String(err && err.message).slice(0, 200); } catch { /* ignoré */ }
    throw new SimAbort(msg, culprit);
  }
}

function abort(err) {
  parentPort.postMessage({ type: 'aborted', reason: err.message, culprit: err.culprit ?? -1 });
}

ctx.__input = JSON.stringify({ entrants: data.entrants, seed: data.seed, maxTicks: data.maxTicks });

if (data.mode === 'fast') runFast();
else runLive();

function runFast() {
  const BATCH = 30;
  const batchScript = new vm.Script('__steps(' + BATCH + ')', { filename: 'steps.js' });
  const frames = [];
  const logs = [];
  const take = (snap) => {
    frames.push(JSON.stringify(snap.frame));
    for (const l of snap.logs) logs.push(l);
    return snap.end || null;
  };
  try {
    let end = take(exec(initScript, data.initTimeoutMs));
    while (!end) {
      const list = exec(batchScript, Math.max(2000, data.stepTimeoutMs * 5));
      if (!Array.isArray(list) || list.length === 0) throw new SimAbort('réponse inattendue du moteur', -1);
      for (const snap of list) {
        end = take(snap);
        if (end) break;
      }
    }
    parentPort.postMessage({ type: 'replay', frames, logs, results: end });
  } catch (err) {
    abort(err);
  }
}

function runLive() {
  const tickMs = 1000 / 60;
  let snap;
  try {
    snap = exec(initScript, data.initTimeoutMs);
  } catch (err) {
    abort(err);
    return;
  }
  parentPort.postMessage({ type: 'tick', frame: snap.frame, logs: snap.logs });

  let start = performance.now();
  let done = 0;
  let stopped = false;
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'stop') stopped = true;
  });

  function loop() {
    if (stopped) return;
    const target = Math.floor((performance.now() - start) / tickMs);
    let n = 0;
    try {
      while (done < target && n < 6) {
        snap = exec(stepScript, data.stepTimeoutMs);
        done++;
        n++;
        parentPort.postMessage({ type: 'tick', frame: snap.frame, logs: snap.logs, end: snap.end || null });
        if (snap.end) return;
      }
    } catch (err) {
      abort(err);
      return;
    }
    // trop de retard (programme lent) : on ralentit plutôt que de tout rattraper d'un coup
    if (target - done > 30) start = performance.now() - done * tickMs;
    const wait = (done + 1) * tickMs - (performance.now() - start);
    setTimeout(loop, Math.max(1, wait));
  }
  setTimeout(loop, tickMs);
}
