/*
 * TankoBlocs — tanks d'exemple.
 *
 * Les exemples sont de vrais programmes Blockly (et non du JavaScript écrit
 * à la main) : on peut les ouvrir dans l'atelier, les étudier et les modifier.
 * Un petit constructeur ci-dessous évite d'écrire le JSON Blockly à la main.
 */
(function (root) {
  'use strict';

  /* ---------- Constructeur de programmes ---------- */

  function program(build) {
    const vars = new Map();
    const varRef = (name) => {
      if (!vars.has(name)) vars.set(name, 'var_' + vars.size + '_' + name.normalize('NFD').replace(/[^a-zA-Z0-9]/g, ''));
      return { id: vars.get(name) };
    };

    // valeur : nombre -> ombre « nombre », texte -> ombre « texte », objet -> bloc
    const val = (x) => {
      if (typeof x === 'number') return { shadow: { type: 'math_number', fields: { NUM: x } } };
      if (typeof x === 'string') return { shadow: { type: 'text', fields: { TEXT: x } } };
      if (typeof x === 'boolean') return { block: { type: 'logic_boolean', fields: { BOOL: x ? 'TRUE' : 'FALSE' } } };
      return { block: x };
    };
    const seq = (list) => {
      const items = list.filter(Boolean);
      for (let i = 0; i < items.length - 1; i++) items[i].next = { block: items[i + 1] };
      return items[0];
    };
    const body = (list) => (list && list.length ? { block: seq(list) } : undefined);
    const withInputs = (o, inputs) => {
      const clean = {};
      for (const k in inputs) if (inputs[k]) clean[k] = inputs[k];
      if (Object.keys(clean).length) o.inputs = clean;
      return o;
    };

    let y = 20;
    const H = {
      // événements
      hat(type, list, filter, x) {
        const o = { type, x: x || 20, y };
        if (filter) o.fields = { FILTER: filter };
        withInputs(o, { DO: body(list) });
        y += 60 + 34 * countBlocks(list);
        return o;
      },
      onStart: (list) => H.hat('ct_on_start', list),
      onRun: (list) => H.hat('ct_on_run', list),
      onRadar: (filter, list) => H.hat('ct_on_radar', list, filter),
      onHit: (filter, list) => H.hat('ct_on_hit', list, filter),
      onBullet: (filter, list) => H.hat('ct_on_bullet', list, filter),

      // mouvement
      move: (ticks, dir) => withInputs({ type: 'ct_move', fields: { DIR: String(dir || 1) } }, { TICKS: val(ticks) }),
      moveDist: (px, dir) => withInputs({ type: 'ct_move_dist', fields: { DIR: String(dir || 1) } }, { PX: val(px) }),
      turn: (part, side, ticks) => withInputs({ type: 'ct_turn', fields: { PART: part, SIDE: String(side) } }, { TICKS: val(ticks) }),
      turnDeg: (part, side, deg) => withInputs({ type: 'ct_turn_deg', fields: { PART: part, SIDE: String(side) } }, { DEG: val(deg) }),
      turnTo: (part, angle) => withInputs({ type: 'ct_turn_to', fields: { PART: part } }, { ANGLE: val(angle) }),
      turnToPoint: (part, x, yy) => withInputs({ type: 'ct_turn_to_point', fields: { PART: part } }, { X: val(x), Y: val(yy) }),
      wait: (ticks) => withInputs({ type: 'ct_wait' }, { TICKS: val(ticks) }),
      combo: (ticks, o) => withInputs({
        type: 'ct_combo',
        fields: {
          MOVE: String(o.move || 0), TANK: String(o.tank || 0), GUN: String(o.gun || 0),
          RADAR: String(o.radar || 0), FIRE: o.fire ? 'TRUE' : 'FALSE',
        },
      }, { TICKS: val(ticks) }),

      // canon & radar
      fire: (whenReady) => ({ type: 'ct_fire', fields: { WHEN: whenReady ? '1' : '0' } }),
      lock: (part, on) => ({ type: 'ct_lock', fields: { PART: part, ON: on ? '1' : '0' } }),
      radarPower: (on) => ({ type: 'ct_radar_power', fields: { ON: on ? '1' : '0' } }),
      clear: () => ({ type: 'ct_clear' }),

      // capteurs
      sensor: (name) => ({ type: 'ct_sensor', fields: { NAME: name } }),
      state: (name) => ({ type: 'ct_sensor_bool', fields: { NAME: name } }),
      angleTo: (x, yy) => withInputs({ type: 'ct_angle_to' }, { X: val(x), Y: val(yy) }),
      distTo: (x, yy) => withInputs({ type: 'ct_distance_to' }, { X: val(x), Y: val(yy) }),
      diff: (a, b) => withInputs({ type: 'ct_angle_diff' }, { A: val(a), B: val(b) }),
      konst: (name) => ({ type: 'ct_const', fields: { NAME: name } }),
      obj: (name) => ({ type: 'ct_obj', fields: { NAME: name } }),
      objIs: (kind) => ({ type: 'ct_obj_is', fields: { KIND: kind } }),
      objText: (name) => ({ type: 'ct_obj_text', fields: { NAME: name } }),

      // journal
      say: (text) => withInputs({ type: 'ct_say' }, { TEXT: val(text) }),
      print: (text) => withInputs({ type: 'ct_print' }, { TEXT: val(text) }),

      // blocs standard
      if_: (cond, then, otherwise) => {
        const o = { type: 'controls_if' };
        if (otherwise) o.extraState = { hasElse: true };
        return withInputs(o, { IF0: val(cond), DO0: body(then), ELSE: otherwise ? body(otherwise) : undefined });
      },
      cmp: (a, op, b) => withInputs({ type: 'logic_compare', fields: { OP: op } }, { A: val(a), B: val(b) }),
      and: (a, b) => withInputs({ type: 'logic_operation', fields: { OP: 'AND' } }, { A: val(a), B: val(b) }),
      or: (a, b) => withInputs({ type: 'logic_operation', fields: { OP: 'OR' } }, { A: val(a), B: val(b) }),
      not: (a) => withInputs({ type: 'logic_negate' }, { BOOL: val(a) }),
      op: (a, opName, b) => withInputs({ type: 'math_arithmetic', fields: { OP: opName } }, { A: val(a), B: val(b) }),
      add: (a, b) => H.op(a, 'ADD', b),
      sub: (a, b) => H.op(a, 'MINUS', b),
      mul: (a, b) => H.op(a, 'MULTIPLY', b),
      div: (a, b) => H.op(a, 'DIVIDE', b),
      neg: (a) => withInputs({ type: 'math_single', fields: { OP: 'NEG' } }, { NUM: val(a) }),
      abs: (a) => withInputs({ type: 'math_single', fields: { OP: 'ABS' } }, { NUM: val(a) }),
      mod: (a, b) => withInputs({ type: 'math_modulo' }, { DIVIDEND: val(a), DIVISOR: val(b) }),
      random: (a, b) => withInputs({ type: 'math_random_int' }, { FROM: val(a), TO: val(b) }),
      text: (t) => ({ type: 'text', fields: { TEXT: t } }),
      join: (...items) => withInputs(
        { type: 'text_join', extraState: { itemCount: items.length } },
        Object.fromEntries(items.map((it, i) => ['ADD' + i, val(it)])),
      ),
      set: (name, value) => withInputs({ type: 'variables_set', fields: { VAR: varRef(name) } }, { VALUE: val(value) }),
      change: (name, by) => withInputs({ type: 'math_change', fields: { VAR: varRef(name) } }, { DELTA: val(by) }),
      get: (name) => ({ type: 'variables_get', fields: { VAR: varRef(name) } }),
      repeat: (n, list) => withInputs({ type: 'controls_repeat_ext' }, { TIMES: val(n), DO: body(list) }),
    };

    const blocks = build(H);
    return {
      blocks: { languageVersion: 0, blocks },
      variables: Array.from(vars, ([name, id]) => ({ name, id })),
    };
  }

  function countBlocks(list) {
    if (!list) return 0;
    let n = 0;
    for (const b of list) {
      if (!b) continue;
      n += 1;
      if (b.inputs) {
        for (const k of ['DO', 'DO0', 'ELSE']) {
          if (b.inputs[k] && b.inputs[k].block) n += countChain(b.inputs[k].block);
        }
      }
    }
    return n;
  }

  function countChain(block) {
    let n = 0;
    for (let b = block; b; b = b.next && b.next.block) {
      n += 1;
      if (b.inputs) for (const k of ['DO', 'DO0', 'ELSE']) if (b.inputs[k] && b.inputs[k].block) n += countChain(b.inputs[k].block);
    }
    return n;
  }

  /* ---------- Les programmes ---------- */

  const TEMPLATE = program((h) => [
    h.onStart([h.say('Prêt au combat !')]),
    h.onRun([
      h.moveDist(150),
      h.turnDeg('tank', 1, 90),
    ]),
    h.onRadar('tank', [
      h.clear(),
      h.turnToPoint('canon', h.obj('x'), h.obj('y')),
      h.fire(true),
    ]),
    h.onHit('mur', [
      h.moveDist(30, -1),
    ]),
  ]);

  const EXAMPLES = [
    {
      id: 'ex-mannequin',
      name: 'Mannequin',
      color: '#95a5a6',
      level: 'cible',
      description: 'Ne bouge pas, ne tire pas. Parfait pour s\'entraîner à viser.',
      workspace: program((h) => [
        h.onRun([h.wait(60)]),
      ]),
    },
    {
      id: 'ex-tourniquet',
      name: 'Tourniquet',
      color: '#f1c40f',
      level: 'cible',
      description: 'Tourne en rond sans jamais tirer : une cible mobile.',
      workspace: program((h) => [
        h.onRun([h.combo(60, { move: 1, tank: 1 })]),
      ]),
    },
    {
      id: 'ex-toupie',
      name: 'Toupie',
      color: '#e67e22',
      level: 'débutant',
      description: 'Le « spin bot » de la documentation d\'origine : tourne sur lui-même en tirant, et change de sens à chaque événement.',
      workspace: program((h) => [
        h.onStart([h.set('sens', 0)]),
        h.onRun([
          h.if_(h.cmp(h.mod(h.get('sens'), 2), 'EQ', 0),
            [h.combo(1, { move: -1, tank: 1, fire: true })],
            [h.combo(1, { move: 1, tank: -1, fire: true })]),
        ]),
        h.onRadar('tout', [h.change('sens', 1)]),
        h.onHit('tout', [h.change('sens', 1)]),
        h.onBullet('tout', [h.change('sens', 1)]),
      ]),
    },
    {
      id: 'ex-sentinelle',
      name: 'Sentinelle',
      color: '#3498db',
      level: 'débutant',
      description: 'Reste sur place et balaie l\'arène avec son canon. Dès qu\'un tank passe dans le radar, elle tire puis repart un peu en arrière pour le retrouver aussitôt.',
      workspace: program((h) => [
        h.onRun([h.turnDeg('canon', 1, 30)]),
        h.onRadar('tank', [
          h.clear(),
          h.turnToPoint('canon', h.obj('x'), h.obj('y')),
          h.if_(h.state('canonPret'), [h.fire(false)]),
          h.turnDeg('canon', -1, 15),
        ]),
      ]),
    },
    {
      id: 'ex-vagabond',
      name: 'Vagabond',
      color: '#2ecc71',
      level: 'intermédiaire',
      description: 'Se promène en évitant les murs. Son canon, déverrouillé, balaie l\'arène pendant que le tank roule ; le radar, resté verrouillé sur le canon, guide le tir.',
      workspace: program((h) => [
        h.onStart([h.lock('canon', false)]),
        h.onRun([
          h.if_(h.state('presDunMur'), [
            h.turnToPoint('tank', h.random(-150, 150), h.random(-100, 100)),
          ]),
          h.combo(30, { move: 1, gun: 1 }),
        ]),
        h.onRadar('tank', [
          h.clear(),
          h.turnToPoint('canon', h.obj('x'), h.obj('y')),
          h.if_(h.state('canonPret'), [h.fire(false)]),
          h.combo(15, { move: 1, gun: -1 }),
        ]),
        h.onHit('mur', [
          h.clear(),
          h.moveDist(40, -1),
          h.turnToPoint('tank', 0, 0),
        ]),
      ]),
    },
    {
      id: 'ex-chasseur',
      name: 'Chasseur',
      color: '#9b59b6',
      level: 'avancé',
      description: 'Tourne en rond pour être difficile à toucher, garde sa cible dans le radar par petits balayages et vise devant elle pour anticiper ses déplacements.',
      workspace: program((h) => [
        h.onStart([h.lock('canon', false)]),
        h.onRun([
          h.if_(h.state('presDunMur'), [
            h.turnToPoint('tank', 0, 0),
            h.move(30),
          ]),
          h.combo(33, { move: 1, tank: 1, gun: 1 }),
        ]),
        h.onRadar('tank', [
          h.clear(),
          // temps de vol de l'obus (on n'anticipe que la moitié : la cible change souvent de direction)
          h.set('temps', h.div(h.div(h.obj('distance'), h.konst('vitesseObus')), 2)),
          h.turnToPoint('canon',
            h.add(h.obj('x'), h.mul(h.obj('vitesseX'), h.get('temps'))),
            h.add(h.obj('y'), h.mul(h.obj('vitesseY'), h.get('temps')))),
          h.if_(h.state('canonPret'), [h.fire(false)]),
          h.combo(17, { move: 1, tank: 1, gun: -1 }),
        ]),
        h.onHit('mur', [
          h.clear(),
          h.moveDist(30, -1),
          h.turnToPoint('tank', 0, 0),
        ]),
      ]),
    },
  ];

  const PILOT = {
    id: 'pilot',
    name: 'Pilote clavier',
    color: '#ecf0f1',
    level: 'humain',
    description: 'Un tank piloté au clavier par un humain.',
    pilot: true,
  };

  root.TankBots = { program, TEMPLATE, EXAMPLES, PILOT };
})(typeof window !== 'undefined' ? window : globalThis);
