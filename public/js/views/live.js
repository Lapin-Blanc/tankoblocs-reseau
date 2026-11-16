/*
 * Un combat : en préparation, en direct, puis revu (replay).
 *
 * #/combat/<uid>
 */
import { h, fill, toast, dot, clock, formatLongDate, confirmDialog } from '../ui.js';
import { GET, POST } from '../net.js';
import { state, on, isTeacher, loadTanks } from '../state.js';
import { ArenaView, LiveSource, ReplaySource, resultsTable } from '../arena.js';
import { go } from '../nav.js';

const SPEEDS = [[0.5, '×½'], [1, '×1'], [2, '×2'], [4, '×4'], [8, '×8']];

export function mount(container, { args }) {
  const uid = args[0];
  const sock = state.socket;
  const meId = state.me.id;
  const view = new ArenaView({ meId, logTitle: 'Journal de mon tank' });
  const back = h('a', { class: 'btn small', href: '#/combats' }, '← Salon');
  const actions = h('span', { class: 'hud-actions' });
  view.hud.prepend(back);
  view.hud.appendChild(actions);
  container.appendChild(h('div', { class: 'live' }));
  view.mount(container.firstChild);
  view.setTitle('Combat');
  view.setState('Connexion…');

  let summary = null; // résumé du combat (salon)
  let live = null; // LiveSource
  let mode = 'live'; // live | replay
  let ended = false;
  let watching = false;
  let fallbackTimer = null;

  const participant = () => !!summary && summary.slots.some((s) => s.user && s.user.id === meId);

  /* ----- Actions selon l'état ----- */
  function renderActions() {
    const list = [];
    if (summary && mode === 'live') {
      const pending = ['waiting', 'countdown', 'queued'].includes(summary.status);
      if (pending && summary.creator.id === meId) list.push(h('button', { class: 'btn small danger', type: 'button', onclick: () => sock.send({ type: 'cancel', uid }) }, 'Annuler le combat'));
      else if (pending && participant()) list.push(h('button', { class: 'btn small', type: 'button', onclick: () => sock.send({ type: 'leave', uid }) }, 'Quitter'));
      if (summary.status === 'running' && isTeacher()) {
        list.push(h('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => {
            if (await confirmDialog('Arrêter ce combat ?', 'Il sera arrêté sans résultat.', { ok: 'Arrêter', danger: true })) sock.send({ type: 'cancel', uid });
          },
        }, '⏹ Arrêter'));
      }
      if (summary.spectators) list.push(h('span', { class: 'muted small', title: 'Spectateurs' }, '👁 ' + summary.spectators));
      list.push(h('span', { class: 'muted small', title: summary.public ? 'Combat public' : 'Combat privé' }, summary.public ? '🌐' : '🔒'));
    }
    fill(actions, list);
  }

  /* ----- Avant le départ ----- */
  const countdownNum = h('div', { class: 'countdown-num' });
  function showPending() {
    if (!summary || live) return;
    view.setTitle(summary.title);
    view.hudTime.textContent = clock(summary.maxTicks);
    const free = summary.slots.filter((s) => s.kind === 'player' && !s.user).length;
    const slots = h('ul', { class: 'slots overlay-slots' }, summary.slots.map((s, i) => h('li', { class: 'slot' },
      s.kind === 'bot' ? [dot(s.color), ' 🤖 ', s.name]
        : s.user ? [dot(s.color), ' ', h('b', null, s.user.pseudo), i === 0 ? ' 👑' : '', h('span', { class: 'muted small' }, ' · ' + s.tankName)]
          : [h('span', { class: 'dot empty' }), h('span', { class: 'muted' }, ' place libre')])));
    if (summary.status === 'countdown') {
      view.setState('Départ imminent', 'countdown');
      view.showOverlay(h('div', { class: 'overlay-title' }, summary.title), countdownNum, slots);
      tickCountdown();
    } else if (summary.status === 'queued') {
      view.setState('En file d\'attente', 'queued');
      view.showOverlay(h('div', { class: 'overlay-title' }, summary.title),
        h('p', null, 'Beaucoup de combats sont en cours : celui-ci démarrera dès qu\'une place se libère', summary.queuePosition ? ' (n° ' + summary.queuePosition + ').' : '.'), slots);
    } else if (summary.status === 'waiting') {
      view.setState('En attente de joueurs', 'waiting');
      view.showOverlay(h('div', { class: 'overlay-title' }, summary.title),
        h('p', null, free === 1 ? 'En attente d\'un joueur…' : 'En attente de ' + free + ' joueurs…'),
        slots,
        h('p', { class: 'hint' }, participant() ? 'Le combat démarre automatiquement dès que toutes les places sont prises.' : 'Pour participer, rejoins ce combat depuis le salon.'));
    }
    renderActions();
  }

  function tickCountdown() {
    if (!summary || summary.status !== 'countdown' || !summary.countdownEndsAt) return;
    const s = Math.max(0, Math.ceil((summary.countdownEndsAt - sock.now()) / 1000));
    countdownNum.textContent = s > 0 ? String(s) : 'Go !';
  }
  const ticker = setInterval(() => {
    tickCountdown();
    if (live && summary && summary.status === 'running') view.setState('En direct', 'live');
  }, 200);

  /* ----- Messages du serveur ----- */
  const mineOnly = (fn) => (m) => { if (m.uid === uid) fn(m); };
  const offs = [
    sock.on('watching', mineOnly((m) => {
      watching = true;
      clearTimeout(fallbackTimer);
      summary = m.match;
      if (summary.status === 'finished' || summary.status === 'aborted') {
        // déjà terminé : on passe directement au replay
        loadReplay(false);
        return;
      }
      if (['waiting', 'countdown', 'queued'].includes(summary.status)) showPending();
      renderActions();
    })),
    on('lobby', () => {
      const m = state.lobby.matches.find((x) => x.uid === uid);
      if (!m || mode !== 'live') return;
      summary = m;
      if (!live) showPending();
      renderActions();
    }),
    sock.on('start', mineOnly((m) => {
      if (mode !== 'live') return;
      live = new LiveSource(view, m.header);
      view.setSource(live);
      view.setTitle(m.header.title);
      view.setState('En direct', 'live');
      view.showOverlay(null);
      view.clearLogs();
      const mineTank = m.header.tanks.find((t) => t.userId === meId);
      view.logBox.hidden = !mineTank && !isTeacher();
      if (isTeacher()) view.logBox.querySelector('h3').textContent = 'Journal (tous les tanks)';
    })),
    sock.on('frame', mineOnly((m) => { if (live && mode === 'live') live.push(m.d, m.late); })),
    sock.on('logs', mineOnly((m) => {
      if (mode !== 'live') return;
      if (m.history) view.clearLogs();
      view.addLogs(m.entries);
    })),
    sock.on('end', mineOnly((m) => {
      if (mode !== 'live') return;
      ended = true;
      if (live) live.flush();
      if (m.aborted) {
        view.setState('Arrêté', 'aborted');
        view.showOverlay(h('div', { class: 'overlay-title' }, '⏹ Combat arrêté'), h('p', null, m.reason || ''),
          h('div', { class: 'row center' }, h('a', { class: 'btn primary', href: '#/combats' }, '⚔️ Retour au salon')));
      } else {
        view.setState('Terminé', 'done');
        // laisse voir la dernière explosion avant d'afficher les résultats
        setTimeout(() => { if (mode === 'live') showResults(m.results, true); }, 1200);
      }
      renderActions();
    })),
    sock.on('cancelled', mineOnly((m) => {
      view.setState('Annulé', 'aborted');
      view.showOverlay(h('div', { class: 'overlay-title' }, 'Combat annulé'), h('p', null, m.reason || ''),
        h('div', { class: 'row center' }, h('a', { class: 'btn primary', href: '#/combats' }, '⚔️ Retour au salon')));
      summary = null;
      renderActions();
    })),
    sock.on('gone', mineOnly(() => {
      clearTimeout(fallbackTimer);
      loadReplay(false);
    })),
    sock.on('status', (s) => {
      if (s === 'open' && mode === 'live' && !ended) watch();
    }),
  ];

  function watch() {
    sock.send({ type: 'watch', uid });
    // combat privé ou inconnu : le serveur répond par une erreur ; on se rabat sur l'historique
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (!watching) loadReplay(false); }, 2500);
  }

  /* ----- Résultats ----- */
  function showResults(results, fromLive, detail) {
    const mine = results.ranking.find((r) => r.userId === meId);
    const w = results.ranking.find((r) => r.index === results.winner);
    let title;
    if (!w) title = '🤝 Match nul';
    else if (mine && w === mine) title = '🏆 Tu as gagné !';
    else title = '🏆 ' + w.name + ' gagne !';
    const buttons = [];
    if (fromLive) buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => loadReplay(true) }, '▶ Revoir le combat'));
    else buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => { view.showOverlay(null); replay.seek(0); replay.play(); updateTransport(); } }, '↺ Revoir'));
    if (mine) buttons.push(h('a', { class: 'btn', href: '#/atelier/' }, '🛠️ Améliorer mon tank'));
    if (detail && mine) {
      const p = detail.participants.find((x) => x.userId === meId);
      if (p && p.versionId) buttons.push(h('button', { class: 'btn', type: 'button', title: 'Crée un nouveau tank avec le programme utilisé dans ce combat', onclick: () => restoreVersion(p, detail) }, '↩ Reprendre cette version'));
    }
    buttons.push(h('a', { class: 'btn primary', href: '#/combats' }, '⚔️ Salon'));
    view.showOverlay(
      h('div', { class: 'overlay-title' }, title),
      mine && results.ranking.length > 2 ? h('p', null, 'Tu termines ' + (mine.rank === 1 ? '1er' : mine.rank + 'e') + ' sur ' + results.ranking.length + '.') : null,
      resultsTable(results, meId),
      h('div', { class: 'row center' }, buttons));
  }

  async function restoreVersion(p, detail) {
    try {
      const v = await GET('/api/versions/' + p.versionId);
      const date = new Date(detail.startedAt).toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit' });
      const r = await POST('/api/tanks', { name: (p.tankName + ' (' + date + ')').slice(0, 40), color: p.color, workspace: v.workspace });
      await loadTanks();
      toast('Nouveau tank créé avec cette version.', 'ok');
      go('#/atelier/' + r.tank.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ----- Replay ----- */
  let replay = null;
  let logs = [];
  let logPtr = 0;
  const playBtn = h('button', { class: 'btn primary', type: 'button' }, '▶');
  const slider = h('input', { type: 'range', min: 0, max: 0, value: 0, class: 'seek', 'aria-label': 'Position dans le combat' });
  const timeLabel = h('span', { class: 'mono small' });
  const speedSel = h('select', { 'aria-label': 'Vitesse' }, SPEEDS.map(([v, l]) => h('option', { value: v, selected: v === 1 }, l)));

  function updateTransport() {
    if (!replay) return;
    playBtn.textContent = replay.playing ? '⏸' : '▶';
    slider.value = replay.i;
    timeLabel.textContent = clock(replay.i) + ' / ' + clock(replay.length - 1);
  }

  function syncLogs(i) {
    if (i < (logs[logPtr - 1] ? logs[logPtr - 1].tick : -1)) {
      view.clearLogs();
      logPtr = 0;
    }
    const batch = [];
    while (logPtr < logs.length && logs[logPtr].tick <= i) batch.push(logs[logPtr++]);
    view.addLogs(batch);
  }

  async function loadReplay(fromLive) {
    mode = 'replay';
    clearTimeout(fallbackTimer);
    sock.send({ type: 'unwatch' });
    view.setState('Chargement du replay…');
    view.showOverlay(h('p', null, '⏳ Recalcul du combat…'));
    let data;
    try {
      const d = (await GET('/api/matches/' + encodeURIComponent(uid))).match;
      if (d.status !== 'finished') {
        view.setState(d.status === 'aborted' ? 'Arrêté' : '', 'aborted');
        view.setTitle(d.title);
        view.showOverlay(h('div', { class: 'overlay-title' }, d.status === 'aborted' ? '⏹ Combat arrêté' : 'Combat en cours'),
          h('p', null, d.abortReason || 'Ce combat n\'est pas terminé.'), h('div', { class: 'row center' }, h('a', { class: 'btn primary', href: '#/combats' }, '⚔️ Salon')));
        return;
      }
      data = await GET('/api/matches/' + encodeURIComponent(uid) + '/replay');
    } catch (err) {
      view.setState('');
      view.showOverlay(h('div', { class: 'overlay-title' }, '😕 Impossible d\'afficher ce combat'), h('p', null, err.message),
        h('div', { class: 'row center' }, h('a', { class: 'btn primary', href: '#/combats' }, '⚔️ Salon')));
      return;
    }
    const d = data.match;
    const header = {
      uid: d.uid, title: d.title, maxTicks: d.maxTicks,
      tanks: d.participants.map((p) => ({ index: p.index, name: p.name, color: p.color, tankName: p.tankName, userId: p.userId, pseudo: p.pseudo, bot: p.bot })),
    };
    view.setTitle(d.title);
    view.setState('Replay · ' + formatLongDate(d.startedAt));
    fill(actions, d.public ? null : h('span', { class: 'muted small' }, '🔒'));
    logs = data.logs.slice().sort((a, b) => a.tick - b.tick);
    logPtr = 0;
    view.clearLogs();
    const mineTank = header.tanks.some((t) => t.userId === meId);
    view.logBox.hidden = !mineTank && !isTeacher();

    const results = {
      winner: d.winner,
      ranking: d.participants.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99)).map((p) => ({ ...p, rank: p.rank })),
    };

    replay = new ReplaySource(view, header, data.frames, {
      onTick: (i) => { updateTransport(); syncLogs(i); },
      onEnd: () => { updateTransport(); showResults(results, false, d); },
    });
    replay.speed = Number(speedSel.value);
    view.setSource(replay);
    slider.max = String(data.frames.length - 1);

    const warn = !data.sameEngine
      ? h('p', { class: 'warn-banner' }, '⚠ Ce combat a été joué avec une version précédente des règles : le replay peut différer de ce qui s\'est passé.')
      : !data.consistent ? h('p', { class: 'warn-banner' }, '⚠ Le replay ne correspond pas exactement au combat d\'origine.') : null;

    fill(view.transport,
      h('button', { class: 'btn', type: 'button', title: 'Début', onclick: () => { replay.seek(0); updateTransport(); } }, '⏮'),
      playBtn,
      h('button', { class: 'btn', type: 'button', title: 'Un tick', onclick: () => { replay.step(); updateTransport(); } }, '⏭'),
      slider, timeLabel, speedSel, warn);

    view.showOverlay(null);
    if (fromLive) {
      replay.play();
    } else {
      showResults(results, false, d);
    }
    updateTransport();
  }

  playBtn.addEventListener('click', () => {
    if (!replay) return;
    view.showOverlay(null);
    if (replay.playing) replay.pause();
    else replay.play();
    updateTransport();
  });
  slider.addEventListener('input', () => {
    if (!replay) return;
    view.showOverlay(null);
    replay.seek(Number(slider.value));
    updateTransport();
  });
  speedSel.addEventListener('change', () => { if (replay) replay.speed = Number(speedSel.value); });

  const onKey = (e) => {
    if (!replay || e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    if (e.code === 'ArrowRight') { replay.seek(replay.i + 60); updateTransport(); }
    if (e.code === 'ArrowLeft') { replay.seek(replay.i - 60); updateTransport(); }
  };
  document.addEventListener('keydown', onKey);

  /* ----- Démarrage ----- */
  const lobbyMatch = state.lobby.matches.find((x) => x.uid === uid);
  if (lobbyMatch) {
    summary = lobbyMatch;
    showPending();
  }
  if (sock.status === 'open') watch();

  return {
    unmount() {
      clearInterval(ticker);
      clearTimeout(fallbackTimer);
      document.removeEventListener('keydown', onKey);
      for (const off of offs) off();
      if (mode === 'live') sock.send({ type: 'unwatch' });
      view.destroy();
    },
  };
}
