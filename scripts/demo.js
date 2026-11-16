#!/usr/bin/env node
/*
 * Données de démonstration (pour essayer l'application seul, sur son poste).
 *
 *   DATA_DIR=./data-demo node scripts/demo.js
 *   DATA_DIR=./data-demo npm start
 *
 * Crée, s'ils n'existent pas encore :
 *  - l'enseignant « Prof »        mot de passe : demo-prof
 *  - le cours « Démo »
 *  - les joueurs « Alice » et « Bruno »   mot de passe : demo-eleve
 *    chacun avec un tank (copie d'un bot d'exemple).
 *
 * À NE PAS utiliser sur le serveur de la classe : ces mots de passe sont publics.
 */
import path from 'node:path';
import { config } from '../server/config.js';
import { Db } from '../server/db.js';
import { Store } from '../server/store.js';
import { hashPassword } from '../server/auth.js';

const TEACHER = { pseudo: 'Prof', password: 'demo-prof' };
const PLAYERS = [
  { pseudo: 'Alice', password: 'demo-eleve', tank: 'Tornade', bot: 'ex-vagabond', color: '#e74c3c' },
  { pseudo: 'Bruno', password: 'demo-eleve', tank: 'Rocher', bot: 'ex-sentinelle', color: '#2ecc71' },
];

const db = new Db(path.join(config.dataDir, 'tankoblocs.sqlite'));
const store = new Store(db);
const bots = globalThis.TankBots.EXAMPLES;

let teacher = store.findUserByPseudo(TEACHER.pseudo);
if (!teacher) {
  teacher = store.createUser({ pseudo: TEACHER.pseudo, passwordHash: await hashPassword(TEACHER.password), role: 'teacher' });
  console.log('Enseignant créé : ' + TEACHER.pseudo + ' / ' + TEACHER.password);
}

let course = store.listCourses().find((c) => c.name === 'Démo');
if (!course) {
  course = store.createCourse('Démo');
  console.log('Cours créé : Démo, code ' + course.code);
}

for (const p of PLAYERS) {
  if (store.findUserByPseudo(p.pseudo)) continue;
  const u = store.createUser({ pseudo: p.pseudo, passwordHash: await hashPassword(p.password), courseId: course.id });
  const bot = bots.find((b) => b.id === p.bot);
  store.createTank(u.id, { name: p.tank, color: p.color, workspace: bot.workspace }, 30);
  console.log('Joueur créé : ' + p.pseudo + ' / ' + p.password + ' (tank « ' + p.tank + ' »)');
}

db.close();
console.log('Base : ' + config.dataDir);
