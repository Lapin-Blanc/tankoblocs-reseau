/*
 * TankoBlocs — blocs Blockly, générateurs JavaScript, thème et boîte à outils.
 */
(function (root) {
  'use strict';

  const Blockly = root.Blockly;
  const gen = root.javascript.javascriptGenerator;
  const Order = root.javascript.Order;

  const COLORS = {
    event: '#D9822B',
    move: '#3C7DD9',
    weapon: '#C94C4C',
    sensor: '#16A085',
    object: '#9B59B6',
    tools: '#6C7A89',
  };

  const PARTS = [['le tank', 'tank'], ['le canon', 'canon'], ['le radar', 'radar']];
  const SIDES = [['gauche ↺', '1'], ['droite ↻', '-1']];
  const ROT3 = [['—', '0'], ['↺ gauche', '1'], ['↻ droite', '-1']];

  const EVENT_HATS = ['ct_on_radar', 'ct_on_hit', 'ct_on_bullet'];
  const HAT_TYPES = ['ct_on_start', 'ct_on_run'].concat(EVENT_HATS);
  const PROC_TYPES = ['procedures_defnoreturn', 'procedures_defreturn'];

  const num = (name) => ({ type: 'input_value', name, check: 'Number' });
  const dd = (name, options) => ({ type: 'field_dropdown', name, options });
  const stmt = { previousStatement: null, nextStatement: null };

  /* ---------- Définitions ---------- */

  const DEFS = [
    // --- Événements ---
    {
      type: 'ct_on_start',
      message0: '🚦 au démarrage de la partie %1 %2',
      args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
      style: 'ct_event',
      tooltip: 'Exécuté une seule fois, au tout début de la partie. Idéal pour donner une valeur de départ aux variables ou déverrouiller le canon / le radar.',
    },
    {
      type: 'ct_on_run',
      message0: '🔁 quand je n\'ai plus d\'ordres %1 %2',
      args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
      style: 'ct_event',
      tooltip: 'Le programme principal. Chaque bloc d\'action ajoute des ordres dans la file du tank ; le tank exécute un ordre par tick. Quand la file est vide, ce bloc est exécuté de nouveau.',
    },
    {
      type: 'ct_on_radar',
      message0: '📡 quand mon radar détecte %1 %2 %3',
      args0: [
        dd('FILTER', [['un tank', 'tank'], ['un obus', 'obus'], ['un mur', 'mur'], ['n\'importe quoi', 'tout']]),
        { type: 'input_dummy' },
        { type: 'input_statement', name: 'DO' },
      ],
      style: 'ct_event',
      tooltip: 'Exécuté quand un objet entre dans le faisceau du radar. Les ordres ajoutés ici passent AVANT ceux qui étaient déjà prévus. Utilise les blocs « objet » pour connaître sa position.',
    },
    {
      type: 'ct_on_hit',
      message0: '💥 quand je suis touché par %1 %2 %3',
      args0: [
        dd('FILTER', [['un obus', 'obus'], ['un tank', 'tank'], ['un mur', 'mur'], ['n\'importe quoi', 'tout']]),
        { type: 'input_dummy' },
        { type: 'input_statement', name: 'DO' },
      ],
      style: 'ct_event',
      tooltip: 'Exécuté quand mon tank perd 10 points de santé : touché par un obus, ou choc contre un tank ou un mur.',
    },
    {
      type: 'ct_on_bullet',
      message0: '🎯 quand mon obus touche %1 %2 %3',
      args0: [
        dd('FILTER', [['un tank', 'tank'], ['un obus', 'obus'], ['un mur', 'mur'], ['n\'importe quoi', 'tout']]),
        { type: 'input_dummy' },
        { type: 'input_statement', name: 'DO' },
      ],
      style: 'ct_event',
      tooltip: 'Exécuté quand un obus que j\'ai tiré rencontre un tank, un autre obus ou un mur.',
    },

    // --- Mouvement ---
    {
      type: 'ct_move',
      message0: '%1 pendant %2 ticks',
      args0: [dd('DIR', [['avancer', '1'], ['reculer', '-1']]), num('TICKS')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Ajoute des ordres de déplacement. Le tank parcourt environ 1,67 pixel par tick (100 pixels par seconde).',
    },
    {
      type: 'ct_move_dist',
      message0: '%1 de %2 pixels',
      args0: [dd('DIR', [['avancer', '1'], ['reculer', '-1']]), num('PX')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Avance ou recule d\'une distance donnée (si rien ne bloque le tank).',
    },
    {
      type: 'ct_turn',
      message0: 'tourner %1 vers la %2 pendant %3 ticks',
      args0: [dd('PART', PARTS), dd('SIDE', SIDES), num('TICKS')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Fait tourner une partie du tank de 0,9° par tick. Un canon verrouillé tourne avec le tank ; un radar verrouillé tourne avec le canon.',
    },
    {
      type: 'ct_turn_deg',
      message0: 'tourner %1 vers la %2 de %3 °',
      args0: [dd('PART', PARTS), dd('SIDE', SIDES), num('DEG')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Fait tourner une partie du tank d\'un certain nombre de degrés (0,9° par tick).',
    },
    {
      type: 'ct_turn_to',
      message0: 'orienter %1 vers l\'angle %2 °',
      args0: [dd('PART', PARTS), num('ANGLE')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Tourne par le chemin le plus court pour viser un angle absolu : 0° = droite (est), 90° = haut (nord), 180° = gauche, 270° = bas.',
    },
    {
      type: 'ct_turn_to_point',
      message0: 'orienter %1 vers le point x %2 y %3',
      args0: [dd('PART', PARTS), num('X'), num('Y')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Tourne pour viser un point de l\'arène. Le centre de l\'arène est (0, 0).',
    },
    {
      type: 'ct_wait',
      message0: '⏳ attendre %1 ticks',
      args0: [num('TICKS')],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Ne rien faire pendant un certain nombre de ticks (60 ticks = 1 seconde).',
    },
    {
      type: 'ct_combo',
      message0: 'pendant %1 ticks, en même temps : %2 déplacement %3 %4 tank %5 canon %6 radar %7 %8 tirer %9',
      args0: [
        num('TICKS'),
        { type: 'input_end_row' },
        dd('MOVE', [['—', '0'], ['avancer', '1'], ['reculer', '-1']]),
        { type: 'input_end_row' },
        dd('TANK', ROT3), dd('GUN', ROT3), dd('RADAR', ROT3),
        { type: 'input_end_row' },
        { type: 'field_checkbox', name: 'FIRE', checked: false },
      ],
      inputsInline: true, ...stmt, style: 'ct_move',
      tooltip: 'Combine plusieurs actions dans chaque tick : par exemple avancer en tournant le radar et en tirant dès que possible.',
    },

    // --- Canon & radar ---
    {
      type: 'ct_fire',
      message0: '🔥 tirer %1',
      args0: [dd('WHEN', [['maintenant', '0'], ['dès que le canon est prêt', '1']])],
      ...stmt, style: 'ct_weapon',
      tooltip: 'Tire un obus dans la direction du canon. Après un tir, le canon doit refroidir pendant 60 ticks. « maintenant » : si le canon n\'est pas prêt, rien ne se passe.',
    },
    {
      type: 'ct_lock',
      message0: '%1 %2',
      args0: [
        dd('ON', [['🔒 verrouiller', '1'], ['🔓 déverrouiller', '0']]),
        dd('PART', [['le canon (sur le tank)', 'canon'], ['le radar (sur le canon)', 'radar']]),
      ],
      ...stmt, style: 'ct_weapon',
      tooltip: 'Verrouillé, le canon tourne avec le tank, et le radar tourne avec le canon. Au départ, les deux sont verrouillés.',
    },
    {
      type: 'ct_radar_power',
      message0: '%1 le radar',
      args0: [dd('ON', [['📡 allumer', '1'], ['🌑 éteindre', '0']])],
      ...stmt, style: 'ct_weapon',
      tooltip: 'Un radar éteint ne produit plus d\'événements.',
    },
    {
      type: 'ct_clear',
      message0: '❌ annuler les ordres prévus',
      ...stmt, style: 'ct_weapon',
      tooltip: 'Vide immédiatement la file d\'ordres : le tank oublie tout ce qu\'il avait prévu de faire. Très utile au début d\'un événement.',
    },
    {
      type: 'ct_self_destruct',
      message0: '☠ s\'autodétruire',
      ...stmt, style: 'ct_weapon',
      tooltip: 'Le tank explose. Rarement une bonne idée…',
    },

    // --- Capteurs ---
    {
      type: 'ct_sensor',
      message0: '%1',
      args0: [dd('NAME', [
        ['ma position x', 'x'],
        ['ma position y', 'y'],
        ['direction du tank', 'direction'],
        ['direction du canon', 'directionCanon'],
        ['direction du radar', 'directionRadar'],
        ['ma santé', 'sante'],
        ['recharge du canon (ticks)', 'recharge'],
        ['ordres en attente (ticks)', 'ordres'],
        ['tick actuel', 'tick'],
        ['ticks restants', 'tempsRestant'],
        ['adversaires en vie', 'adversairesEnVie'],
        ['dégâts infligés', 'degatsInfliges'],
        ['mon numéro', 'numero'],
      ])],
      output: 'Number', style: 'ct_sensor',
      tooltip: 'Une mesure sur mon tank, au moment où le bloc est exécuté. Les directions sont en degrés (0° = droite, 90° = haut).',
    },
    {
      type: 'ct_sensor_bool',
      message0: '%1 ?',
      args0: [dd('NAME', [
        ['canon prêt à tirer', 'canonPret'],
        ['près d\'un mur', 'presDunMur'],
        ['canon verrouillé', 'canonVerrouille'],
        ['radar verrouillé', 'radarVerrouille'],
        ['radar allumé', 'radarAllume'],
        ['plus aucun ordre prévu', 'fileVide'],
      ])],
      output: 'Boolean', style: 'ct_sensor',
      tooltip: 'Vrai ou faux, selon l\'état de mon tank.',
    },
    {
      type: 'ct_angle_to',
      message0: 'angle vers x %1 y %2',
      args0: [num('X'), num('Y')],
      inputsInline: true, output: 'Number', style: 'ct_sensor',
      tooltip: 'Direction (en degrés, entre 0 et 360) qu\'il faut prendre pour aller de mon tank jusqu\'à ce point.',
    },
    {
      type: 'ct_distance_to',
      message0: 'distance jusqu\'à x %1 y %2',
      args0: [num('X'), num('Y')],
      inputsInline: true, output: 'Number', style: 'ct_sensor',
      tooltip: 'Distance en pixels entre mon tank et ce point.',
    },
    {
      type: 'ct_angle_diff',
      message0: 'écart d\'angle de %1 vers %2',
      args0: [num('A'), num('B')],
      inputsInline: true, output: 'Number', style: 'ct_sensor',
      tooltip: 'De combien de degrés tourner pour passer du premier angle au second : entre -180 (vers la droite) et 180 (vers la gauche).',
    },
    {
      type: 'ct_const',
      message0: '%1',
      args0: [dd('NAME', [
        ['vitesse d\'un obus (px/tick)', 'vitesseObus'],
        ['vitesse du tank (px/tick)', 'vitesseTank'],
        ['vitesse de rotation (°/tick)', 'vitesseRotation'],
        ['durée de recharge (ticks)', 'recharge'],
        ['rayon d\'un tank', 'rayonTank'],
        ['largeur de l\'arène', 'largeur'],
        ['hauteur de l\'arène', 'hauteur'],
        ['ticks par seconde', 'ticksParSeconde'],
      ])],
      output: 'Number', style: 'ct_sensor',
      tooltip: 'Une constante du jeu.',
    },

    // --- Objet de l'événement ---
    {
      type: 'ct_obj',
      message0: 'objet : %1',
      args0: [dd('NAME', [
        ['x', 'x'],
        ['y', 'y'],
        ['distance', 'distance'],
        ['angle pour le viser', 'angle'],
        ['direction', 'direction'],
        ['vitesse x (px/tick)', 'vitesseX'],
        ['vitesse y (px/tick)', 'vitesseY'],
        ['vitesse (px/tick)', 'vitesse'],
        ['vitesse de rotation', 'vitesseAngulaire'],
        ['numéro', 'numero'],
      ])],
      output: 'Number', style: 'ct_object', extensions: ['ct_event_only'],
      tooltip: 'Une information sur l\'objet qui a déclenché l\'événement (détecté par le radar, qui m\'a touché, ou que mon obus a touché). Distance et angle sont calculés depuis mon tank.',
    },
    {
      type: 'ct_obj_is',
      message0: 'l\'objet est %1',
      args0: [dd('KIND', [['un tank', 'tank'], ['un obus', 'obus'], ['un mur', 'mur']])],
      output: 'Boolean', style: 'ct_object', extensions: ['ct_event_only'],
      tooltip: 'Vrai si l\'objet de l\'événement est de ce type.',
    },
    {
      type: 'ct_obj_text',
      message0: 'objet : %1',
      args0: [dd('NAME', [['nom', 'nom'], ['type', 'type']])],
      output: 'String', style: 'ct_object', extensions: ['ct_event_only'],
      tooltip: 'Nom du tank (pour un obus : le nom de celui qui l\'a tiré ; pour un mur : nord, sud, est ou ouest) ou type de l\'objet (tank, obus, mur).',
    },

    // --- Journal ---
    {
      type: 'ct_print',
      message0: '📝 afficher %1 dans le journal',
      args0: [{ type: 'input_value', name: 'TEXT' }],
      inputsInline: true, ...stmt, style: 'ct_tools',
      tooltip: 'Écrit un message dans le journal de l\'arène : pratique pour comprendre ce que fait ton programme.',
    },
    {
      type: 'ct_say',
      message0: '💬 dire %1',
      args0: [{ type: 'input_value', name: 'TEXT' }],
      inputsInline: true, ...stmt, style: 'ct_tools',
      tooltip: 'Affiche une bulle au-dessus du tank pendant 2 secondes (et écrit dans le journal).',
    },
  ];

  /* ---------- Extension : avertissement hors événement ---------- */

  if (!Blockly.Extensions.isRegistered('ct_event_only')) {
    Blockly.Extensions.register('ct_event_only', function () {
      this.setOnChange(function () {
        if (this.isInFlyout || !this.workspace || !this.workspace.rendered) return;
        const rootBlock = this.getRootBlock();
        const ok = rootBlock === this || EVENT_HATS.includes(rootBlock.type) || PROC_TYPES.includes(rootBlock.type);
        this.setWarningText(ok ? null : 'Ce bloc décrit l\'objet d\'un événement : place-le dans « 📡 quand mon radar détecte », « 💥 quand je suis touché » ou « 🎯 quand mon obus touche ».');
      });
    });
  }

  Blockly.common.defineBlocksWithJsonArray(DEFS);

  /* ---------- Générateurs JavaScript ---------- */

  gen.addReservedWords('tank,Math');

  const v = (block, name, fallback) => gen.valueToCode(block, name, Order.NONE) || (fallback === undefined ? '0' : fallback);
  const q = (s) => gen.quote_(String(s));
  const call = (code) => [code, Order.FUNCTION_CALL];

  function hat(kind, filter) {
    return function (block) {
      const body = gen.statementToCode(block, 'DO');
      const f = filter ? block.getFieldValue('FILTER') : 'tout';
      return 'tank.quand(' + q(kind) + ', ' + q(f) + ', function () {\n' + body + '});\n';
    };
  }

  const F = gen.forBlock;
  F.ct_on_start = hat('demarrage', false);
  F.ct_on_run = hat('ordres', false);
  F.ct_on_radar = hat('radar', true);
  F.ct_on_hit = hat('touche', true);
  F.ct_on_bullet = hat('impact', true);

  F.ct_move = (b) => (b.getFieldValue('DIR') === '-1' ? 'tank.reculer(' : 'tank.avancer(') + v(b, 'TICKS') + ');\n';
  F.ct_move_dist = (b) => (b.getFieldValue('DIR') === '-1' ? 'tank.reculerDe(' : 'tank.avancerDe(') + v(b, 'PX') + ');\n';
  F.ct_turn = (b) => 'tank.tourner(' + q(b.getFieldValue('PART')) + ', ' + b.getFieldValue('SIDE') + ', ' + v(b, 'TICKS') + ');\n';
  F.ct_turn_deg = (b) => 'tank.tournerDe(' + q(b.getFieldValue('PART')) + ', ' + b.getFieldValue('SIDE') + ', ' + v(b, 'DEG') + ');\n';
  F.ct_turn_to = (b) => 'tank.orienter(' + q(b.getFieldValue('PART')) + ', ' + v(b, 'ANGLE') + ');\n';
  F.ct_turn_to_point = (b) => 'tank.orienterVers(' + q(b.getFieldValue('PART')) + ', ' + v(b, 'X') + ', ' + v(b, 'Y') + ');\n';
  F.ct_wait = (b) => 'tank.attendre(' + v(b, 'TICKS') + ');\n';
  F.ct_combo = (b) =>
    'tank.combiner(' + v(b, 'TICKS') + ', { deplacement: ' + b.getFieldValue('MOVE') +
    ', tank: ' + b.getFieldValue('TANK') + ', canon: ' + b.getFieldValue('GUN') +
    ', radar: ' + b.getFieldValue('RADAR') + ', tirer: ' + (b.getFieldValue('FIRE') === 'TRUE') + ' });\n';

  F.ct_fire = (b) => 'tank.tirer(' + (b.getFieldValue('WHEN') === '1') + ');\n';
  F.ct_lock = (b) => 'tank.verrouiller(' + q(b.getFieldValue('PART')) + ', ' + (b.getFieldValue('ON') === '1') + ');\n';
  F.ct_radar_power = (b) => 'tank.radarActif(' + (b.getFieldValue('ON') === '1') + ');\n';
  F.ct_clear = () => 'tank.annulerOrdres();\n';
  F.ct_self_destruct = () => 'tank.autodestruction();\n';

  F.ct_sensor = (b) => call('tank.capteur(' + q(b.getFieldValue('NAME')) + ')');
  F.ct_sensor_bool = (b) => call('tank.etat(' + q(b.getFieldValue('NAME')) + ')');
  F.ct_angle_to = (b) => call('tank.angleVers(' + v(b, 'X') + ', ' + v(b, 'Y') + ')');
  F.ct_distance_to = (b) => call('tank.distanceJusqua(' + v(b, 'X') + ', ' + v(b, 'Y') + ')');
  F.ct_angle_diff = (b) => call('tank.ecartAngle(' + v(b, 'A') + ', ' + v(b, 'B') + ')');
  F.ct_const = (b) => call('tank.constante(' + q(b.getFieldValue('NAME')) + ')');

  F.ct_obj = (b) => call('tank.objet(' + q(b.getFieldValue('NAME')) + ')');
  F.ct_obj_is = (b) => call('tank.objetEst(' + q(b.getFieldValue('KIND')) + ')');
  F.ct_obj_text = (b) => call('tank.objet(' + q(b.getFieldValue('NAME')) + ')');

  F.ct_print = (b) => 'tank.afficher(' + v(b, 'TEXT', "''") + ');\n';
  F.ct_say = (b) => 'tank.dire(' + v(b, 'TEXT', "''") + ');\n';

  /* ---------- Compilation ---------- */

  /**
   * Transforme un espace de travail en code JavaScript.
   * Seuls les blocs « événement » et les définitions de fonctions sont pris
   * en compte : un bloc posé seul dans l'espace de travail est ignoré.
   * @param {boolean} trap ajoute la protection contre les boucles infinies
   */
  function compileWorkspace(ws, trap) {
    const previous = gen.INFINITE_LOOP_TRAP;
    gen.INFINITE_LOOP_TRAP = trap ? 'tank.boucle();\n' : null;
    try {
      gen.init(ws);
      const parts = [];
      for (const block of ws.getTopBlocks(true)) {
        if (!block.isEnabled()) continue;
        if (!HAT_TYPES.includes(block.type) && !PROC_TYPES.includes(block.type)) continue;
        let line = gen.blockToCode(block);
        if (Array.isArray(line)) line = line[0];
        if (line) parts.push(line);
      }
      let code = gen.finish(parts.join('\n'));
      code = code.replace(/^\s+\n/, '').replace(/\n\s+$/, '\n').replace(/[ \t]+\n/g, '\n');
      // Blockly recopie le texte des commentaires de blocs en « // … » et ne
      // les découpe qu'aux sauts de ligne (\n). Un retour chariot, U+2028 ou
      // U+2029 y terminerait le commentaire et la suite deviendrait du code
      // (piège possible dans un fichier .tank.json importé). On les remplace
      // par des espaces partout : dans un texte, ils rendaient de toute façon
      // le programme invalide.
      code = code.replace(/[\r\u2028\u2029]/g, ' ');
      return code;
    } finally {
      gen.INFINITE_LOOP_TRAP = previous;
    }
  }

  /** Compile un état sérialisé (JSON Blockly) sans l'afficher. */
  function compileState(state, trap) {
    const ws = new Blockly.Workspace();
    try {
      Blockly.Events.disable();
      try {
        Blockly.serialization.workspaces.load(state || {}, ws);
      } finally {
        Blockly.Events.enable();
      }
      return compileWorkspace(ws, trap);
    } finally {
      ws.dispose();
    }
  }

  /** Quelques statistiques sur un état sérialisé (nombre de blocs, événements présents). */
  function describeState(state) {
    const ws = new Blockly.Workspace();
    try {
      Blockly.Events.disable();
      try { Blockly.serialization.workspaces.load(state || {}, ws); } finally { Blockly.Events.enable(); }
      const types = ws.getTopBlocks(false).map((b) => b.type);
      return { blocks: ws.getAllBlocks(false).length, hats: types.filter((t) => HAT_TYPES.includes(t)) };
    } finally {
      ws.dispose();
    }
  }

  /* ---------- Thème ---------- */

  const theme = Blockly.Theme.defineTheme('tankoblocs', {
    base: Blockly.Themes.Classic,
    blockStyles: {
      ct_event: { colourPrimary: COLORS.event, colourSecondary: '#F0B27A', colourTertiary: '#A35C15', hat: 'cap' },
      ct_move: { colourPrimary: COLORS.move, colourSecondary: '#8DB4EC', colourTertiary: '#24589F' },
      ct_weapon: { colourPrimary: COLORS.weapon, colourSecondary: '#E39A9A', colourTertiary: '#8E2E2E' },
      ct_sensor: { colourPrimary: COLORS.sensor, colourSecondary: '#7FD1C1', colourTertiary: '#0B6B5A' },
      ct_object: { colourPrimary: COLORS.object, colourSecondary: '#CDA6DD', colourTertiary: '#6C3483' },
      ct_tools: { colourPrimary: COLORS.tools, colourSecondary: '#AEB6BF', colourTertiary: '#45505C' },
      procedure_blocks: { colourPrimary: '#995ba5', colourSecondary: '#ad7be9', colourTertiary: '#844593', hat: 'cap' },
    },
    categoryStyles: {
      ct_event: { colour: COLORS.event },
      ct_move: { colour: COLORS.move },
      ct_weapon: { colour: COLORS.weapon },
      ct_sensor: { colour: COLORS.sensor },
      ct_object: { colour: COLORS.object },
      ct_tools: { colour: COLORS.tools },
    },
    componentStyles: {
      workspaceBackgroundColour: '#182127',
      toolboxBackgroundColour: '#202a31',
      toolboxForegroundColour: '#dfe7ec',
      flyoutBackgroundColour: '#26323a',
      flyoutForegroundColour: '#c9d4da',
      flyoutOpacity: 0.96,
      scrollbarColour: '#52616b',
      scrollbarOpacity: 0.7,
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.3,
      markerColour: '#ffd166',
      cursorColour: '#ffd166',
    },
    fontStyle: { family: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', weight: '600', size: 11 },
  });

  /* ---------- Boîte à outils ---------- */

  const sh = (n) => ({ shadow: { type: 'math_number', fields: { NUM: n } } });
  const shText = (t) => ({ shadow: { type: 'text', fields: { TEXT: t } } });
  const objBlock = (name) => ({ block: { type: 'ct_obj', fields: { NAME: name } } });
  const blk = (type, inputs, fields) => {
    const o = { kind: 'block', type };
    if (inputs) o.inputs = inputs;
    if (fields) o.fields = fields;
    return o;
  };
  const label = (text) => ({ kind: 'label', text });

  const toolbox = {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category', name: 'Événements', categorystyle: 'ct_event',
        contents: [
          label('Chaque programme commence par un de ces blocs'),
          blk('ct_on_start'),
          blk('ct_on_run'),
          blk('ct_on_radar'),
          blk('ct_on_hit'),
          blk('ct_on_bullet'),
        ],
      },
      {
        kind: 'category', name: 'Mouvement', categorystyle: 'ct_move',
        contents: [
          label('Chaque bloc ajoute des ordres à la file (1 ordre = 1 tick)'),
          blk('ct_move', { TICKS: sh(60) }),
          blk('ct_move_dist', { PX: sh(100) }),
          blk('ct_turn', { TICKS: sh(30) }),
          blk('ct_turn_deg', { DEG: sh(90) }),
          blk('ct_turn_to', { ANGLE: sh(90) }),
          blk('ct_turn_to_point', { X: sh(0), Y: sh(0) }),
          blk('ct_wait', { TICKS: sh(30) }),
          blk('ct_combo', { TICKS: sh(60) }, { MOVE: '1', RADAR: '1' }),
        ],
      },
      {
        kind: 'category', name: 'Canon et radar', categorystyle: 'ct_weapon',
        contents: [
          blk('ct_fire'),
          blk('ct_fire', null, { WHEN: '1' }),
          blk('ct_clear'),
          blk('ct_lock', null, { ON: '0', PART: 'canon' }),
          blk('ct_lock', null, { ON: '0', PART: 'radar' }),
          blk('ct_radar_power', null, { ON: '0' }),
          blk('ct_self_destruct'),
        ],
      },
      {
        kind: 'category', name: 'Capteurs', categorystyle: 'ct_sensor',
        contents: [
          blk('ct_sensor'),
          blk('ct_sensor', null, { NAME: 'sante' }),
          blk('ct_sensor_bool'),
          blk('ct_sensor_bool', null, { NAME: 'presDunMur' }),
          blk('ct_angle_to', { X: sh(0), Y: sh(0) }),
          blk('ct_distance_to', { X: sh(0), Y: sh(0) }),
          blk('ct_angle_diff', {
            A: { block: { type: 'ct_sensor', fields: { NAME: 'directionCanon' } } },
            B: sh(90),
          }),
          blk('ct_const'),
        ],
      },
      {
        kind: 'category', name: 'Objet détecté', categorystyle: 'ct_object',
        contents: [
          label('À utiliser dans 📡, 💥 ou 🎯'),
          blk('ct_obj'),
          blk('ct_obj', null, { NAME: 'distance' }),
          blk('ct_obj_is'),
          blk('ct_obj_text'),
          label('Raccourci : viser l\'objet'),
          blk('ct_turn_to_point', { X: objBlock('x'), Y: objBlock('y') }, { PART: 'canon' }),
        ],
      },
      {
        kind: 'category', name: 'Journal', categorystyle: 'ct_tools',
        contents: [
          blk('ct_say', { TEXT: shText('Bonjour !') }),
          blk('ct_print', { TEXT: shText('ici') }),
          blk('ct_print', {
            TEXT: {
              block: {
                type: 'text_join', extraState: { itemCount: 2 },
                inputs: { ADD0: shText('santé : '), ADD1: { block: { type: 'ct_sensor', fields: { NAME: 'sante' } } } },
              },
            },
          }),
        ],
      },
      { kind: 'sep' },
      {
        kind: 'category', name: 'Logique', categorystyle: 'logic_category',
        contents: [
          blk('controls_if'),
          { kind: 'block', type: 'controls_if', extraState: { hasElse: true } },
          blk('logic_compare'),
          blk('logic_operation'),
          blk('logic_negate'),
          blk('logic_boolean'),
          blk('logic_ternary'),
        ],
      },
      {
        kind: 'category', name: 'Boucles', categorystyle: 'loop_category',
        contents: [
          blk('controls_repeat_ext', { TIMES: sh(4) }),
          blk('controls_whileUntil'),
          blk('controls_for', { FROM: sh(1), TO: sh(10), BY: sh(1) }),
          blk('controls_forEach'),
          blk('controls_flow_statements'),
        ],
      },
      {
        kind: 'category', name: 'Maths', categorystyle: 'math_category',
        contents: [
          blk('math_number', null, { NUM: 0 }),
          blk('math_arithmetic', { A: sh(1), B: sh(1) }),
          blk('math_single', { NUM: sh(9) }),
          blk('math_trig', { NUM: sh(45) }),
          blk('math_atan2', { X: sh(1), Y: sh(1) }),
          blk('math_constant'),
          blk('math_number_property', { NUMBER_TO_CHECK: sh(0) }),
          blk('math_round', { NUM: sh(3.1) }),
          blk('math_modulo', { DIVIDEND: sh(64), DIVISOR: sh(10) }),
          blk('math_constrain', { VALUE: sh(50), LOW: sh(1), HIGH: sh(100) }),
          blk('math_random_int', { FROM: sh(1), TO: sh(100) }),
          blk('math_random_float'),
          blk('math_on_list'),
        ],
      },
      {
        kind: 'category', name: 'Texte', categorystyle: 'text_category',
        contents: [
          blk('text'),
          blk('text_join'),
          blk('text_append', { TEXT: shText('') }),
          blk('text_length', { VALUE: shText('abc') }),
          blk('text_isEmpty', { VALUE: shText('') }),
          blk('text_changeCase', { TEXT: shText('abc') }),
        ],
      },
      {
        kind: 'category', name: 'Listes', categorystyle: 'list_category',
        contents: [
          blk('lists_create_with', null, null),
          { kind: 'block', type: 'lists_create_with', extraState: { itemCount: 0 } },
          blk('lists_repeat', { NUM: sh(5) }),
          blk('lists_length'),
          blk('lists_isEmpty'),
          blk('lists_indexOf'),
          blk('lists_getIndex'),
          blk('lists_setIndex'),
        ],
      },
      { kind: 'category', name: 'Variables', categorystyle: 'variable_category', custom: 'VARIABLE' },
      { kind: 'category', name: 'Fonctions', categorystyle: 'procedure_category', custom: 'PROCEDURE' },
    ],
  };

  root.TankBlocks = {
    COLORS,
    HAT_TYPES,
    EVENT_HATS,
    theme,
    toolbox,
    compileWorkspace,
    compileState,
    describeState,
  };
})(typeof window !== 'undefined' ? window : globalThis);
