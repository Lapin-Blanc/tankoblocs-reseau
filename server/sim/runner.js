/*
 * Lancement des combats dans des fils d'exécution séparés (worker.js).
 * Un programme trop lent ou trop gourmand ne peut bloquer que son propre
 * combat : le serveur et les autres combats continuent.
 */
import { Worker } from 'node:worker_threads';
import { SIM_SOURCES, safeCode } from '../tankoblocs.js';
import { config } from '../config.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

function spawn(mode, { entrants, seed, maxTicks }) {
  return new Worker(WORKER_URL, {
    workerData: {
      mode,
      sources: SIM_SOURCES,
      // safeCode aussi ici : couvre le code compilé et enregistré avant une mise à jour du serveur
      entrants: entrants.map((e) => ({ name: e.name, color: e.color, code: safeCode(e.code || ''), error: e.error || null })),
      seed,
      maxTicks,
      stepTimeoutMs: config.stepTimeoutMs,
      initTimeoutMs: Math.max(1000, config.stepTimeoutMs * 3),
    },
    resourceLimits: {
      maxOldGenerationSizeMb: config.matchMemoryMb,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
    stdout: true,
    stderr: true,
  });
}

/** Explication lisible d'un arrêt anormal. */
export function abortMessage(reason, culpritName) {
  if (reason === 'timeout') {
    return culpritName
      ? 'Combat arrêté : le programme de ' + culpritName + ' a mis trop de temps à répondre.'
      : 'Combat arrêté : un programme a mis trop de temps à répondre.';
  }
  if (reason === 'memory') {
    return 'Combat arrêté : un programme a utilisé trop de mémoire.';
  }
  return 'Combat arrêté : ' + reason;
}

/**
 * Combat en temps réel.
 * @param {object} opts { entrants, seed, maxTicks }
 * @param {object} on   { tick(frame, logs), end(results), abort(reason, culprit) }
 * @returns {{ stop(): void }}
 */
export function startLive(opts, on) {
  const worker = spawn('live', opts);
  let finished = false;
  let lastMessage = Date.now();

  const finish = () => {
    finished = true;
    clearInterval(watchdog);
    worker.terminate().catch(() => {});
  };

  // filet de sécurité : plus aucune image depuis un moment
  const watchdog = setInterval(() => {
    if (!finished && Date.now() - lastMessage > Math.max(5000, config.stepTimeoutMs * 10)) {
      finish();
      on.abort('timeout', -1);
    }
  }, 1000);

  worker.on('message', (msg) => {
    if (finished) return;
    lastMessage = Date.now();
    if (msg.type === 'tick') {
      on.tick(msg.frame, msg.logs);
      if (msg.end) {
        finish();
        on.end(msg.end);
      }
    } else if (msg.type === 'aborted') {
      finish();
      on.abort(msg.reason, msg.culprit);
    }
  });
  worker.on('error', (err) => {
    if (finished) return;
    finish();
    on.abort(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'erreur interne (' + ((err && err.message) || err) + ')', -1);
  });
  worker.on('exit', () => {
    if (finished) return;
    finish();
    on.abort('erreur interne (fil arrêté)', -1);
  });

  return {
    stop() {
      if (finished) return;
      worker.postMessage({ type: 'stop' });
      finish();
    },
  };
}

/**
 * Calcule tout un combat d'un coup (pour le revoir).
 * @returns {Promise<{ frames: string[], logs: object[], results: object }>}
 */
export function runFast(opts, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const worker = spawn('fast', opts);
    let done = false;
    const end = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => end(reject, Object.assign(new Error('timeout'), { reason: 'timeout', culprit: -1 })), timeoutMs);
    worker.on('message', (msg) => {
      if (msg.type === 'replay') end(resolve, msg);
      else if (msg.type === 'aborted') end(reject, Object.assign(new Error(msg.reason), { reason: msg.reason, culprit: msg.culprit }));
    });
    worker.on('error', (err) => end(reject, Object.assign(new Error(String(err && err.message)), {
      reason: err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'erreur interne', culprit: -1,
    })));
    worker.on('exit', () => end(reject, Object.assign(new Error('fil arrêté'), { reason: 'erreur interne', culprit: -1 })));
  });
}
