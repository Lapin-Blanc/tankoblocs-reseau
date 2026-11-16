/*
 * Vérification de l'image Docker, lancée par l'intégration continue
 * (.github/workflows/ci.yml) avec les mêmes options --permission que le
 * serveur :
 *  - un combat entre bots se calcule bien dans un fil d'exécution ;
 *  - le modèle de permissions est actif : impossible de lancer une commande
 *    ou d'écrire hors de /data.
 *
 * Utilisable aussi hors de Docker :
 *   node --permission --allow-worker --allow-fs-read=$PWD --allow-fs-write=/tmp scripts/docker-smoke.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFast } from '../server/sim/runner.js';
import { BOTS } from '../server/tankoblocs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, ok, detail = '') {
  console.log((ok ? 'ok    ' : 'ÉCHEC ') + label + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
}
function denied(fn) {
  try {
    fn();
    return false;
  } catch (err) {
    return err && err.code === 'ERR_ACCESS_DENIED';
  }
}

check('modèle de permissions actif', !!(process.permission && !process.permission.has('child')));
check('lancer une commande est refusé', denied(() => execFileSync('true')));
check('écrire dans le dossier du code est refusé', denied(() => fs.writeFileSync(path.join(ROOT, 'intrus.txt'), 'x')));

const entrants = BOTS.slice(0, 3).map((b) => ({ name: b.name, color: b.color, code: b.code }));
const started = Date.now();
try {
  const sim = await runFast({ entrants, seed: 12345, maxTicks: 1800 });
  check('combat de 1800 ticks calculé dans un fil', sim.frames.length > 1 && !!sim.results,
    sim.frames.length + ' images, ' + (Date.now() - started) + ' ms');
  check('classement complet', sim.results.ranking.length === entrants.length);
} catch (err) {
  check('combat calculé dans un fil', false, (err && (err.reason || err.message)) || String(err));
}

if (failures) {
  console.error(failures + ' vérification(s) en échec');
  process.exit(1);
}
console.log('image vérifiée');
