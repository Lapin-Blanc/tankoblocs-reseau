/*
 * Entraînement : une partie calculée dans le navigateur contre les bots,
 * avec toutes les commandes pour déboguer (pause, tick par tick, vitesse,
 * affichage des ordres) et une série rapide de manches.
 *
 * #/entrainement        avec le tank choisi pour les combats
 * #/entrainement/12     avec le tank 12
 */
import { h, fill, toast, plural, percent, prefs } from '../ui.js';
import { GET } from '../net.js';
import { state, selectedTankId, compileWorkspace, botCode } from '../state.js';
import { ArenaView, LocalSource, resultsTable } from '../arena.js';

const DURATIONS = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']];
const SPEEDS = [[0.25, '×¼'], [0.5, '×½'], [1, '×1'], [2, '×2'], [4, '×4'], [16, '×16']];

function randomSeed() {
  return 1 + Math.floor(Math.random() * 999998);
}

export async function mount(container, { args }) {
  const E = window.TankEngine;
  const RT = window.TankRuntime;

  if (!state.tanks.length) {
    fill(container, h('div', { class: 'empty-state' }, h('h2', null, 'Pas encore de tank'), h('p', null, 'Crée d\'abord ton tank dans l\'atelier.'), h('a', { class: 'btn primary', href: '#/atelier' }, '🛠️ Atelier')));
    return null;
  }

  const saved = prefs.get('training', {});
  const opts = {
    tankId: Number(args[0]) || selectedTankId(),
    opponents: Array.isArray(saved.opponents) ? saved.opponents : ['sentinelle', '', ''],
    duration: saved.duration || 60,
    seed: randomSeed(),
    speed: saved.speed || 1,
  };
  if (!state.tanks.some((t) => t.id === opts.tankId)) opts.tankId = state.tanks[0].id;

  const view = new ArenaView({ meId: null, logTitle: 'Journal', logHint: 'Les messages des tanks (« afficher », « dire », pannes) apparaissent ici.' });
  view.setTitle('🎯 Entraînement');

  /* ----- Réglages ----- */
  const tankSel = h('select', { 'aria-label': 'Mon tank' }, state.tanks.map((t) => h('option', { value: t.id, selected: t.id === opts.tankId }, t.name)));
  const botOptions = (value, allowNone) => [
    allowNone ? h('option', { value: '', selected: !value }, '— aucun —') : null,
    ...state.bots.map((b) => h('option', { value: b.id, selected: b.id === value }, b.name + ' (' + b.level + ')')),
  ];
  const oppSels = [0, 1, 2].map((i) => h('select', { 'aria-label': 'Adversaire ' + (i + 1) }, botOptions(opts.opponents[i] || (i === 0 ? 'sentinelle' : ''), i > 0)));
  const durSel = h('select', { 'aria-label': 'Durée' }, DURATIONS.map(([v, l]) => h('option', { value: v, selected: v === opts.duration }, l)));
  const seedInput = h('input', { type: 'number', min: 1, max: 999999, value: opts.seed, 'aria-label': 'Graine' });

  const settings = h('section', { class: 'card' },
    h('h3', null, 'Réglages'),
    h('label', { class: 'field' }, h('span', null, 'Mon tank'), tankSel),
    h('div', { class: 'field' }, h('span', null, 'Adversaires (bots)'), ...oppSels),
    h('div', { class: 'row' },
      h('label', { class: 'field inline-field' }, h('span', null, 'Durée'), durSel),
      h('label', { class: 'field inline-field' }, h('span', null, 'Graine', h('small', { class: 'muted', title: 'Même graine = même partie (positions de départ, hasard)' }, ' ⓘ')), seedInput)),
    h('div', { class: 'row' },
      h('a', { class: 'btn small', href: '#/atelier/' + opts.tankId, id: 'edit-link' }, '🛠️ Modifier mon tank')));

  /* ----- Série rapide ----- */
  const seriesN = h('select', { 'aria-label': 'Nombre de manches' }, [10, 20, 50, 100].map((n) => h('option', { value: n, selected: n === 20 }, n + ' manches')));
  const seriesBtn = h('button', { class: 'btn', type: 'button' }, '⚡ Lancer la série');
  const seriesOut = h('div', { class: 'series-out' });
  const series = h('details', { class: 'card' },
    h('summary', null, '⚡ Série rapide'),
    h('p', { class: 'hint' }, 'Joue de nombreuses manches en un instant (positions de départ différentes) pour savoir si ton tank est vraiment le meilleur.'),
    h('div', { class: 'row' }, seriesN, seriesBtn),
    seriesOut);

  view.side.prepend(settings, series);

  /* ----- Commandes ----- */
  const playBtn = h('button', { class: 'btn primary', type: 'button' }, '▶ Lancer');
  const stepBtn = h('button', { class: 'btn', type: 'button', title: 'Avancer d\'un seul tick' }, '⏭ Un tick');
  const restartBtn = h('button', { class: 'btn', type: 'button', title: 'Rejouer exactement la même partie' }, '↺ Rejouer');
  const newBtn = h('button', { class: 'btn', type: 'button', title: 'Nouvelles positions de départ' }, '🎲 Nouvelle partie');
  const speedSel = h('select', { 'aria-label': 'Vitesse' }, SPEEDS.map(([v, l]) => h('option', { value: v, selected: v === opts.speed }, l)));
  const tg = (label, key, def, title) => {
    const cb = h('input', { type: 'checkbox', checked: prefs.get('view.' + key, def) });
    view.renderer.options[key] = cb.checked;
    cb.addEventListener('change', () => {
      view.renderer.options[key] = cb.checked;
      prefs.set('view.' + key, cb.checked);
    });
    return h('label', { class: 'inline', title }, cb, label);
  };
  fill(view.transport, playBtn, stepBtn, restartBtn, newBtn, speedSel,
    h('span', { class: 'toggles' },
      tg('Radars', 'radar', true, 'Afficher les faisceaux des radars'),
      tg('Noms', 'labels', true, 'Afficher les noms et la santé'),
      tg('Ordres', 'debug', false, 'Afficher l\'ordre exécuté et la longueur de la file d\'ordres')));

  container.appendChild(h('div', { class: 'training' }));
  view.mount(container.firstChild);

  /* ----- Partie ----- */
  let mine = null; // { name, color, code, error }
  let src = null;

  async function loadMine() {
    const t = (await GET('/api/tanks/' + opts.tankId)).tank;
    const c = compileWorkspace(t.workspace);
    mine = { name: t.name, color: t.color, code: c.code, error: c.error };
    container.querySelector('#edit-link').href = '#/atelier/' + t.id;
  }

  function specs() {
    const list = [{ name: mine.name, color: mine.color, code: mine.code, error: mine.error }];
    for (const id of opts.opponents) {
      if (!id) continue;
      const b = state.bots.find((x) => x.id === id);
      if (b) list.push({ name: b.name, color: b.color, code: botCode(id) });
    }
    return RT.distinctify(list);
  }

  function info(list) {
    return list.map((s, i) => ({ name: s.name, color: s.color, mine: i === 0, bot: i > 0, sub: i === 0 ? 'ton tank' : 'bot' }));
  }

  function rebuild() {
    const list = specs();
    view.clearLogs();
    view.showOverlay(null);
    const match = new E.Match({
      entrants: RT.buildEntrants(list, opts.seed),
      seed: opts.seed,
      maxTicks: opts.duration * 60,
      onLog: (e) => view.addLogs([e]),
    });
    src = new LocalSource(view, match, info(list), { onEnd: (r) => finished(r) });
    src.speed = opts.speed;
    view.setSource(src);
    if (mine.error) view.addLogs([{ tick: 0, tank: 0, kind: 'error', text: '⚠ ' + mine.error }]);
    if (list.length < 2) view.showOverlay(h('div', null, 'Choisis au moins un adversaire.'));
    updateButtons();
    view.setState('Prêt');
  }

  function finished(r) {
    updateButtons();
    view.setState('Terminé');
    const won = r.winner === 0;
    view.showOverlay(
      h('div', { class: 'overlay-title' }, r.winner === -1 ? '🤝 Match nul' : won ? '🏆 Ton tank a gagné !' : '😕 ' + r.ranking[0].name + ' a gagné'),
      resultsTable({ ...r, ranking: r.ranking.map((x, i) => ({ ...x, rank: i + 1, userId: x.index === 0 ? -2 : null, bot: x.index !== 0 })) }, -2),
      h('div', { class: 'row center' },
        h('button', { class: 'btn', type: 'button', onclick: () => { rebuild(); } }, '↺ Rejouer'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => newMatch(true) }, '🎲 Nouvelle partie')));
  }

  function updateButtons() {
    const done = !src || src.match.finished;
    playBtn.textContent = src && src.running ? '⏸ Pause' : '▶ ' + (src && src.match.tick > 0 && !done ? 'Reprendre' : 'Lancer');
    stepBtn.disabled = done;
  }

  function play() {
    if (!src) return;
    if (src.match.finished) rebuild();
    if (src.running) {
      src.pause();
      view.setState('En pause');
    } else {
      view.showOverlay(null);
      src.play();
      view.setState('En cours', 'live');
    }
    updateButtons();
  }

  function newMatch(start) {
    opts.seed = randomSeed();
    seedInput.value = opts.seed;
    rebuild();
    if (start) play();
  }

  playBtn.addEventListener('click', play);
  stepBtn.addEventListener('click', () => {
    if (!src || src.match.finished) return;
    view.showOverlay(null);
    src.stepOnce();
    view.setState('En pause');
    updateButtons();
  });
  restartBtn.addEventListener('click', () => { rebuild(); play(); });
  newBtn.addEventListener('click', () => newMatch(true));
  speedSel.addEventListener('change', () => {
    opts.speed = Number(speedSel.value);
    if (src) src.speed = opts.speed;
    persist();
  });

  function persist() {
    prefs.set('training', { opponents: opts.opponents, duration: opts.duration, speed: opts.speed });
  }

  tankSel.addEventListener('change', async () => {
    opts.tankId = Number(tankSel.value);
    await loadMine();
    rebuild();
  });
  oppSels.forEach((s, i) => s.addEventListener('change', () => {
    opts.opponents[i] = s.value;
    persist();
    rebuild();
  }));
  durSel.addEventListener('change', () => {
    opts.duration = Number(durSel.value);
    persist();
    rebuild();
  });
  seedInput.addEventListener('change', () => {
    const n = Math.round(Number(seedInput.value));
    if (n >= 1 && n <= 999999) opts.seed = n;
    seedInput.value = opts.seed;
    rebuild();
  });

  const onKey = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); play(); }
  };
  document.addEventListener('keydown', onKey);

  /* ----- Série rapide ----- */
  let seriesRun = 0;
  seriesBtn.addEventListener('click', () => {
    const n = Number(seriesN.value);
    const run = ++seriesRun;
    const list = specs();
    if (list.length < 2) {
      toast('Choisis au moins un adversaire.', 'error');
      return;
    }
    const base = randomSeed();
    let i = 0;
    const tally = { win: 0, draw: 0, loss: 0, dealt: 0, taken: 0, broken: 0 };
    seriesBtn.disabled = true;
    const step = () => {
      if (run !== seriesRun) return;
      const t0 = performance.now();
      while (i < n && performance.now() - t0 < 40) {
        const seed = ((base + i * 7919) % 999998) + 1;
        const m = new E.Match({ entrants: RT.buildEntrants(list, seed), seed, maxTicks: opts.duration * 60 });
        while (!m.finished) {
          m.step();
          m.fx.length = 0;
        }
        const r = m.results;
        if (r.winner === 0) tally.win++;
        else if (r.winner === -1) tally.draw++;
        else tally.loss++;
        tally.dealt += m.tanks[0].damageDealt;
        tally.taken += m.tanks[0].damageTaken;
        if (m.tanks[0].broken) tally.broken++;
        i++;
      }
      fill(seriesOut, h('div', { class: 'progress' }, h('span', { style: { width: (100 * i / n) + '%' } })));
      if (i < n) {
        setTimeout(step, 0);
        return;
      }
      seriesBtn.disabled = false;
      fill(seriesOut,
        h('p', { class: 'series-big' }, h('b', null, percent(tally.win / n)), ' de victoires'),
        h('p', null, '🏆 ' + plural(tally.win, 'victoire', 'victoires') + ' · 🤝 ' + plural(tally.draw, 'nul', 'nuls') + ' · ✖ ' + plural(tally.loss, 'défaite', 'défaites')),
        h('p', { class: 'muted' }, 'En moyenne : ' + (tally.dealt / n).toFixed(0) + ' dégâts infligés, ' + (tally.taken / n).toFixed(0) + ' reçus.'),
        tally.broken ? h('p', { class: 'error-text' }, '⚠ Programme en panne dans ' + plural(tally.broken, 'manche', 'manches') + ' : regarde le journal d\'une partie.') : null);
    };
    step();
  });

  await loadMine();
  rebuild();

  return {
    unmount() {
      seriesRun++;
      document.removeEventListener('keydown', onKey);
      view.destroy();
    },
  };
}
