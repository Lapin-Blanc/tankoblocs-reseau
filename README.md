# TankoBlocs Réseau

La version multijoueur de [TankoBlocs](https://github.com/Lapin-Blanc/tankoblocs), pour jouer **en classe, sur le réseau local**. Chaque joueur programme son tank avec des blocs, l'entraîne contre les bots, puis l'engage dans des combats en direct contre les tanks des autres.

- **Comptes** : pseudo et mot de passe, inscription avec le code du cours donné par l'enseignant. Chacun retrouve ses tanks d'un cours à l'autre, depuis n'importe quel ordinateur.
- **Atelier** : l'éditeur de blocs de TankoBlocs, avec enregistrement automatique sur le serveur, import et export `.tank.json` (compatibles avec TankoBlocs).
- **Entraînement** : partie contre 1 à 3 bots, calculée dans le navigateur. Pause, avance tick par tick, vitesse ×¼ à ×16, affichage des ordres, et « série rapide » de nombreuses manches.
- **Combats** : chacun crée ses combats (durée, 1 à 3 adversaires, joueurs ou bots, public ou privé). Quand toutes les places sont prises, un décompte démarre, puis le combat se joue en direct à 60 images par seconde. Les combats publics peuvent être regardés par tous.
- **Historique et replays** : chaque combat terminé peut être revu image par image. On peut aussi reprendre le programme exact utilisé ce jour-là.
- **Classement** par cours.
- **Administration** : cours et codes d'inscription, joueurs (mot de passe provisoire, renommer, désactiver, voir leurs tanks), combats en cours (regarder, arrêter), réglages.

## Démarrer le serveur

### Avec Docker (recommandé)

Sur l'ordinateur qui sert de serveur (celui de l'enseignant, ou un serveur de l'école) :

```bash
docker compose up -d
```

Ouvrez ensuite <http://localhost:8080> sur cet ordinateur. Au premier lancement, la page propose de créer le **compte enseignant**.

Les élèves ouvrent `http://<adresse de cet ordinateur>:8080`, par exemple `http://192.168.1.20:8080`. L'adresse s'obtient avec `ipconfig` sous Windows ou `ip a` sous Linux. Pour l'afficher directement dans l'administration, copiez `.env.example` en `.env` et réglez `PUBLIC_URL`.

| Commande | Effet |
| --- | --- |
| `docker compose up -d --build` | démarrer, ou redémarrer après une mise à jour du code |
| `docker compose logs -f` | voir les messages du serveur |
| `docker compose down` | arrêter (les données sont gardées dans le volume `tankoblocs-data`) |
| `docker compose exec tankoblocs node server/cli.js backup` | sauvegarde de la base dans le volume |
| `docker compose exec tankoblocs node server/cli.js reset-password <pseudo>` | mot de passe provisoire (si l'enseignant a perdu le sien) |

Pour récupérer une sauvegarde sur l'ordinateur : `docker compose cp tankoblocs:/data/<fichier>.sqlite .`

### Sans Docker

Il faut Node.js 24 ou plus récent.

```bash
npm ci
npm start
```

Le serveur affiche les adresses à donner aux élèves. Les données sont dans `data/`.

### Pour essayer seul

```bash
DATA_DIR=./data-demo npm run demo     # comptes de démonstration
DATA_DIR=./data-demo npm start
```

Cela crée l'enseignant « Prof » (mot de passe `demo-prof`) et les joueurs « Alice » et « Bruno » (mot de passe `demo-eleve`). Ces mots de passe sont publics : ne lancez jamais ce script sur le serveur de la classe.

### Points à vérifier dans la classe

- **Pare-feu** : le port 8080 doit être ouvert sur l'ordinateur serveur. Windows le demande au premier lancement.
- **Wi-Fi** : certains réseaux sans fil isolent les appareils les uns des autres. Si les élèves n'arrivent pas à joindre le serveur alors que l'adresse est bonne, c'est souvent la cause : essayez le réseau filaire ou demandez au service informatique.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `8080` | port d'écoute |
| `DATA_DIR` | `./data` (`/data` dans Docker) | dossier de la base SQLite |
| `PUBLIC_URL` | — | adresse affichée aux élèves dans l'administration |
| `SESSION_DAYS` | `30` | durée d'une connexion |
| `DISCONNECT_GRACE_MS` | `20000` | délai avant de libérer la place d'un joueur déconnecté pendant l'attente |
| `STEP_TIMEOUT_MS` | `400` | temps de calcul maximal d'un tick avant d'arrêter un combat |
| `MATCH_MEMORY_MB` | `128` | mémoire maximale d'un combat |

Les réglages de jeu se changent dans l'administration : durées minimale et maximale, nombre d'adversaires, décompte, combats simultanés, tanks par joueur, inscriptions.

## Comment ça marche

```
navigateur ── HTTP (JSON) ──►  server/api.js     comptes, tanks, historique, replays, administration
           ◄── WebSocket ───►  server/lobby.js   salon, décompte, combats en direct
                                    │
                                    ├─ server/tankoblocs.js   compile les blocs (Blockly sans affichage)
                                    ├─ server/sim/runner.js   un fil d'exécution par combat
                                    │    └─ sim/worker.js     moteur + programmes dans un contexte vm vide
                                    └─ server/store.js        SQLite (node:sqlite)
```

- **Le serveur calcule les combats.** Les navigateurs ne reçoivent que les positions à afficher (environ 60 images par seconde). Les programmes ne quittent jamais le serveur : personne ne peut copier celui d'un autre en regardant un combat.
- **Programmes figés.** Au départ d'un combat, la dernière version enregistrée de chaque tank est figée et compilée. Le serveur compile lui-même l'état Blockly envoyé par l'atelier et n'accepte jamais de JavaScript tout fait.
- **Bac à sable.** Chaque combat tourne dans son propre fil d'exécution (`worker_threads`), dans un contexte `vm` sans `process`, `require` ni objet du serveur. La mémoire est plafonnée et chaque tick a un temps maximal. Un programme trop lent ou trop gourmand n'arrête que son propre combat, et le serveur indique de qui il s'agit. Une boucle infinie faite avec les blocs, elle, met seulement le tank en panne, comme dans TankoBlocs.
- **Replays.** Le moteur est déterministe. Un combat est entièrement décrit par sa graine, les programmes figés et sa durée. Pour le revoir, le serveur le recalcule (quelques centaines de millisecondes) et vérifie qu'il obtient le même résultat. Si les règles ont changé entre-temps, le replay le signale.
- **Sécurité des comptes.** Mots de passe hachés avec scrypt, cookie de session `HttpOnly`/`SameSite=Lax`, vérification de l'origine des requêtes, nombre d'essais de connexion limité, en-têtes CSP. Le serveur est prévu pour un réseau local, en HTTP. Pour l'exposer sur Internet, placez-le derrière un proxy HTTPS.

## Fichiers partagés avec TankoBlocs

Le moteur, l'exécution des programmes, les blocs, les bots, le dessin de l'arène, les sons et le guide des règles viennent de TankoBlocs. Ils sont copiés dans `vendor/tankoblocs/` et ne doivent **pas** être modifiés ici. Pour changer une règle, on la change dans TankoBlocs, puis :

```bash
npm run sync-tankoblocs -- ../tankoblocs
```

Le commit d'origine est noté dans `vendor/tankoblocs/VERSION.json`. Les combats enregistrés gardent l'empreinte de la version des règles avec laquelle ils ont été joués.

Blockly (même version que TankoBlocs, 12.5.1) vient du paquet npm. Il sert à la fois au navigateur et à la compilation sur le serveur.

## Organisation du code

```
server/
  index.js        point d'entrée : HTTP, WebSocket, fichiers statiques
  config.js       variables d'environnement, réglages par défaut
  db.js           SQLite, schéma et migrations, réglages
  store.js        requêtes : joueurs, cours, tanks, versions, combats, classement
  auth.js         mots de passe, sessions, cookies, limitation des essais
  http.js         routeur, JSON, fichiers statiques, en-têtes de sécurité
  api.js          routes de l'API
  lobby.js        salon et combats en direct
  tankoblocs.js   chargement des fichiers partagés, compilation, bots
  sim/runner.js   lancement des combats dans des fils d'exécution
  sim/worker.js   le combat lui-même (bac à sable)
  cli.js          outils pour l'enseignant (mot de passe, sauvegarde…)
public/
  index.html, css/app.css, img/
  js/main.js      démarrage, navigation, barre du haut
  js/arena.js     arène : dessin, tableau, journal ; sources direct / replay / local
  js/views/       une vue par onglet
vendor/tankoblocs/  fichiers copiés depuis TankoBlocs (ne pas modifier ici)
scripts/          synchronisation avec TankoBlocs, données de démonstration
test/             tests automatiques (node --test)
```

## Tests

```bash
npm test
```

Les tests couvrent :
- les comptes, les sessions, les permissions et l'administration ;
- les tanks et les fichiers statiques ;
- la compilation et le bac à sable : pas d'accès au serveur, programme trop lent, mémoire, boucle infinie ;
- l'identité exacte entre un combat calculé dans un fil d'exécution et le moteur de référence ;
- un vrai combat en direct entre deux joueurs et un bot, avec historique, classement et replay identique ;
- le salon : rejoindre, quitter, déconnexion, compléter avec des bots, annuler, arrêt par l'enseignant.

## Licence

Copyright 2026 Fabien Toune. Distribué sous **licence Apache 2.0** : voir [LICENSE](LICENSE) et [NOTICE](NOTICE).

- Blockly : Apache 2.0, © Google LLC.
- Règles du jeu : inspirées de [code-tanks](https://github.com/code-tanks/code-tanks) (Apache 2.0), via TankoBlocs.
