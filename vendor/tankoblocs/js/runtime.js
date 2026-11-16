/*
 * TankoBlocs — exécution des programmes des tanks.
 *
 * Le code JavaScript produit par les blocs ressemble à :
 *
 *   var compteur;
 *   tank.quand('demarrage', 'tout', function () { compteur = 0; });
 *   tank.quand('ordres', 'tout', function () { tank.avancer(60); });
 *   tank.quand('radar', 'tank', function () { tank.tirer(false); });
 *
 * Chaque tank reçoit sa propre copie des variables : deux tanks qui
 * utilisent le même programme ne partagent rien.
 */
(function (root) {
  'use strict';

  const E = root.TankEngine;

  /** Nombre maximal de tours de boucle par appel d'un gestionnaire. */
  const LOOP_BUDGET = 200000;

  const EVENT_KINDS = ['demarrage', 'ordres', 'radar', 'touche', 'impact'];
  const EVENT_LABELS = {
    demarrage: '« au démarrage »',
    ordres: '« quand je n\'ai plus d\'ordres »',
    radar: '« quand mon radar détecte »',
    touche: '« quand je suis touché »',
    impact: '« quand mon obus touche »',
  };

  class LoopError extends Error {}

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Construit un « cerveau » à partir du code généré.
   * @param {string} code  code JavaScript généré par les blocs
   * @param {number} seed  graine du hasard propre à ce tank
   */
  function createBrain(code, seed) {
    const handlers = {};
    for (const k of EVENT_KINDS) handlers[k] = [];

    let ctrl = null; // contrôleur du tank pendant un appel
    let budget = LOOP_BUDGET;

    const need = () => {
      if (!ctrl) throw new Error('action impossible en dehors d\'un événement');
      return ctrl;
    };

    // API visible par le code généré (noms en français, lisibles dans l'aperçu du code)
    const api = Object.freeze({
      quand(kind, filter, fn) {
        if (!handlers[kind] || typeof fn !== 'function') return;
        handlers[kind].push({ filter: filter || 'tout', fn });
      },
      boucle() {
        if (--budget < 0) throw new LoopError('boucle infinie ou trop longue (plus de ' + LOOP_BUDGET + ' tours)');
      },
      // actions
      avancer(ticks) { need().move(1, ticks); },
      reculer(ticks) { need().move(-1, ticks); },
      avancerDe(px) { need().moveDistance(1, px); },
      reculerDe(px) { need().moveDistance(-1, px); },
      tourner(partie, sens, ticks) { need().turn(partie, sens, ticks); },
      tournerDe(partie, sens, degres) { need().turnDegrees(partie, num(sens) * num(degres)); },
      orienter(partie, angle) { need().turnToAngle(partie, angle); },
      orienterVers(partie, x, y) { need().turnToPoint(partie, x, y); },
      attendre(ticks) { need().wait(ticks); },
      combiner(ticks, spec) { need().combine(ticks, spec); },
      tirer(desQuePret) { need().fire(!!desQuePret); },
      verrouiller(partie, oui) { need().lock(partie, !!oui); },
      radarActif(oui) { need().radarPower(!!oui); },
      annulerOrdres() { need().clear(); },
      autodestruction() { need().selfDestruct(); },
      // capteurs
      capteur(nom) { return need().read(nom); },
      etat(nom) { return need().readBool(nom); },
      angleVers(x, y) { return need().angleTo(x, y); },
      distanceJusqua(x, y) { return need().distanceTo(x, y); },
      ecartAngle(de, vers) { return E.norm180(Number(vers) - Number(de)); },
      constante(nom) { return constant(nom); },
      // objet de l'événement en cours
      objet(nom) { return need().eventValue(nom); },
      objetEst(type) { return need().eventIs(type); },
      // outils
      afficher(texte) { need().log(texte); },
      dire(texte) { need().say(texte); },
    });

    // Math avec un hasard reproductible : une partie rejouée avec la même
    // graine donne exactement le même résultat.
    const seededMath = Object.create(Math);
    seededMath.random = E.makeRandom(seed);

    // eslint-disable-next-line no-new-func
    const factory = new Function('tank', 'Math', '"use strict";\n' + code);

    // L'enregistrement des gestionnaires se fait ici. Aucune action n'est
    // permise à ce moment (ctrl est nul).
    budget = LOOP_BUDGET;
    factory(api, seededMath);

    function call(kind, filterKind) {
      for (const h of handlers[kind]) {
        if (filterKind && h.filter !== 'tout' && h.filter !== filterKind) continue;
        budget = LOOP_BUDGET;
        try {
          h.fn();
        } catch (err) {
          throw decorate(err, kind);
        }
      }
    }

    return {
      handlers,
      start(c) {
        ctrl = c;
        try { call('demarrage'); } finally { ctrl = null; }
      },
      run(c) {
        ctrl = c;
        try { call('ordres'); } finally { ctrl = null; }
      },
      events(c, list) {
        ctrl = c;
        try {
          for (const ev of list) {
            c.event = ev;
            call(ev.type, ev.kind);
          }
        } finally {
          c.event = null;
          ctrl = null;
        }
      },
    };
  }

  function decorate(err, kind) {
    let msg;
    if (err instanceof LoopError) msg = err.message;
    else if (err instanceof RangeError) msg = 'trop d\'appels imbriqués (une fonction s\'appelle-t-elle sans fin ?)';
    else msg = (err && err.message) || String(err);
    const e = new Error(msg + ' — dans ' + EVENT_LABELS[kind]);
    e.handler = kind;
    return e;
  }

  function constant(nom) {
    const C = E.C;
    switch (nom) {
      case 'vitesseTank': return C.MOVE_SPEED;
      case 'vitesseObus': return C.BULLET_SPEED;
      case 'vitesseRotation': return C.ROT_SPEED;
      case 'recharge': return C.COOLDOWN;
      case 'rayonTank': return C.TANK_RADIUS;
      case 'rayonObus': return C.BULLET_RADIUS;
      case 'largeur': return C.WIDTH;
      case 'hauteur': return C.HEIGHT;
      case 'santeMax': return C.MAX_HEALTH;
      case 'degats': return C.DAMAGE;
      case 'ticksParSeconde': return C.TICKS_PER_SECOND;
      default: return 0;
    }
  }

  /**
   * Prépare un participant prêt pour TankEngine.Match.
   * Si le code ne peut pas être préparé, le tank entre en jeu « en panne ».
   */
  function makeEntrant(spec, index, matchSeed) {
    const entrant = { name: spec.name, color: spec.color, pilot: !!spec.pilot, brain: null, spawn: spec.spawn || null };
    if (spec.pilot) return entrant;
    try {
      entrant.brain = createBrain(spec.code || '', ((matchSeed >>> 0) * 31 + index * 7919 + 17) >>> 0);
    } catch (err) {
      entrant.error = 'programme invalide : ' + ((err && err.message) || err);
    }
    return entrant;
  }

  const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fa8', '#95a5a6', '#ecf0f1'];

  /**
   * Couleurs et noms distincts pour une partie.
   * L'arène et le tournoi passent tous deux par ici : une manche de tournoi
   * rejouée dans l'arène est ainsi exactement identique.
   */
  function distinctify(specs) {
    const usedColors = new Set();
    const names = new Map();
    return specs.map((s) => {
      const out = Object.assign({}, s);
      let c = (s.color || '').toLowerCase();
      if (!c || usedColors.has(c)) c = PALETTE.find((p) => !usedColors.has(p)) || c;
      usedColors.add(c);
      out.color = c;
      const n = (names.get(s.name) || 0) + 1;
      names.set(s.name, n);
      if (n > 1) out.name = s.name + ' ' + n;
      return out;
    });
  }

  function buildEntrants(specs, seed) {
    return specs.map((s, i) => {
      const e = makeEntrant(s, i, seed);
      if (s.error) { e.error = s.error; e.brain = null; }
      return e;
    });
  }

  root.TankRuntime = { createBrain, makeEntrant, constant, LOOP_BUDGET, EVENT_KINDS, PALETTE, distinctify, buildEntrants };
})(typeof window !== 'undefined' ? window : globalThis);
