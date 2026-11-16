#!/usr/bin/env node
/*
 * Outils en ligne de commande pour l'enseignant.
 *
 *   node server/cli.js reset-password <pseudo>   mot de passe provisoire
 *   node server/cli.js make-teacher <pseudo>     donne les droits d'enseignant
 *   node server/cli.js backup [fichier]          copie de sauvegarde de la base
 *   node server/cli.js stats                     quelques chiffres
 *
 * Avec Docker :  docker compose exec tankoblocs node server/cli.js <commande>
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { Db } from './db.js';
import { Store } from './store.js';
import { hashPassword, temporaryPassword } from './auth.js';

const [cmd, arg] = process.argv.slice(2);
const file = path.join(config.dataDir, 'tankoblocs.sqlite');

function usage() {
  console.log(`Utilisation :
  node server/cli.js reset-password <pseudo>   crée un mot de passe provisoire
  node server/cli.js make-teacher <pseudo>     donne les droits d'enseignant
  node server/cli.js backup [fichier]          copie de sauvegarde de la base
  node server/cli.js stats                     quelques chiffres`);
  process.exit(1);
}

if (!cmd) usage();
if (!fs.existsSync(file)) {
  console.error('Base introuvable : ' + file + ' (variable DATA_DIR ?)');
  process.exit(1);
}

const db = new Db(file);
const store = new Store(db);

function needUser() {
  if (!arg) usage();
  const u = store.findUserByPseudo(arg);
  if (!u) {
    console.error('Joueur inconnu : ' + arg);
    process.exit(1);
  }
  return u;
}

switch (cmd) {
  case 'reset-password': {
    const u = needUser();
    const pw = temporaryPassword();
    store.setPassword(u.id, await hashPassword(pw), true);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    console.log('Mot de passe provisoire de ' + u.pseudo + ' : ' + pw);
    console.log('(il devra en choisir un autre à sa prochaine connexion)');
    break;
  }
  case 'make-teacher': {
    const u = needUser();
    store.updateUser(u.id, { role: 'teacher', disabled: false });
    console.log(u.pseudo + ' est maintenant enseignant.');
    break;
  }
  case 'backup': {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const out = path.resolve(arg || path.join(config.dataDir, 'sauvegarde-' + stamp + '.sqlite'));
    if (fs.existsSync(out)) {
      console.error('Le fichier existe déjà : ' + out);
      process.exit(1);
    }
    // VACUUM INTO : copie cohérente, même pendant que le serveur tourne
    db.db.exec('VACUUM INTO ' + "'" + out.replace(/'/g, "''") + "'");
    console.log('Sauvegarde : ' + out);
    break;
  }
  case 'stats': {
    const n = (sql) => db.get(sql).n;
    console.log('Joueurs : ' + n('SELECT COUNT(*) AS n FROM users'));
    console.log('Cours   : ' + n('SELECT COUNT(*) AS n FROM courses'));
    console.log('Tanks   : ' + n('SELECT COUNT(*) AS n FROM tanks'));
    console.log('Combats : ' + n('SELECT COUNT(*) AS n FROM matches WHERE status = \'finished\''));
    break;
  }
  default:
    usage();
}
db.close();
