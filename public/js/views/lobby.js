/*
 * Salon des combats : créer un combat, rejoindre, regarder, revoir.
 * Tout est mis à jour en direct par le WebSocket.
 */
import { h, fill, toast, dot, formatDuration, clock, confirmDialog } from '../ui.js';
import { state, on, selectedTankId, setSelectedTank, myActiveMatch, isTeacher } from '../state.js';

const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 300, 420, 600];
const STATUS = {
  waiting: ['En attente de joueurs', 'waiting'],
  countdown: ['Départ imminent', 'countdown'],
  queued: ['En file d\'attente', 'queued'],
  running: ['En cours', 'live'],
  finished: ['Terminé', 'done'],
  aborted: ['Arrêté', 'aborted'],
};
const PLAYER_STATUS = {
  idle: ['libre', 'idle'],
  waiting: ['inscrit à un combat', 'waiting'],
  playing: ['en combat', 'playing'],
  watching: ['regarde un combat', 'watching'],
};

export function mount(container) {
  const sock = state.socket;
  const settings = () => state.settings;

  /* ================= Créer un combat ================= */
  const tankSel = h('select', { 'aria-label': 'Mon tank' });
  const titleInput = h('input', { type: 'text', maxlength: 50, placeholder: 'Combat de ' + state.me.pseudo, 'aria-label': 'Nom du combat' });
  const durSel = h('select', { 'aria-label': 'Durée' });
  const slotsBox = h('div', { class: 'slot-editor' });
  const publicCb = h('input', { type: 'checkbox', checked: true });
  const createBtn = h('button', { class: 'btn primary big', type: 'submit' }, '⚔️ Créer le combat');
  const createHint = h('p', { class: 'hint' });
  let opponents = [{ kind: 'player' }];

  const form = h('form', { class: 'card create-card' },
    h('h3', null, 'Créer un combat'),
    h('label', { class: 'field' }, h('span', null, 'Mon tank'), tankSel),
    h('label', { class: 'field' }, h('span', null, 'Nom du combat'), titleInput),
    h('label', { class: 'field' }, h('span', null, 'Durée'), durSel),
    h('div', { class: 'field' }, h('span', null, 'Adversaires'), slotsBox),
    h('label', { class: 'inline' }, publicCb, 'Public : les autres peuvent le regarder en direct'),
    createBtn,
    createHint);

  function fillTanks() {
    const sel = selectedTankId();
    fill(tankSel, state.tanks.map((t) => h('option', { value: t.id, selected: t.id === sel }, t.name)));
  }

  function fillDurations() {
    const s = settings();
    const list = DURATIONS.filter((d) => d >= s.minDurationSec && d <= s.maxDurationSec);
    if (!list.includes(s.minDurationSec)) list.unshift(s.minDurationSec);
    if (!list.includes(s.maxDurationSec)) list.push(s.maxDurationSec);
    const cur = Number(durSel.value) || 60;
    fill(durSel, list.map((d) => h('option', { value: d, selected: d === (list.includes(cur) ? cur : list.includes(60) ? 60 : list[0]) }, formatDuration(d))));
  }

  function opponentOptions(value) {
    return [
      h('option', { value: 'player', selected: value === 'player' }, '👤 Un joueur'),
      h('optgroup', { label: 'Bots d\'entraînement' }, state.bots.map((b) => h('option', { value: 'bot:' + b.id, selected: value === 'bot:' + b.id }, '🤖 ' + b.name + ' (' + b.level + ')'))),
    ];
  }

  function renderSlots() {
    const max = settings().maxOpponents;
    if (opponents.length > max) opponents = opponents.slice(0, max);
    fill(slotsBox,
      opponents.map((o, i) => {
        const sel = h('select', { 'aria-label': 'Adversaire ' + (i + 1) }, opponentOptions(o.kind === 'bot' ? 'bot:' + o.botId : 'player'));
        sel.addEventListener('change', () => {
          opponents[i] = sel.value === 'player' ? { kind: 'player' } : { kind: 'bot', botId: sel.value.slice(4) };
          updateHint();
        });
        return h('div', { class: 'slot-row' }, sel,
          opponents.length > 1 ? h('button', { class: 'btn small', type: 'button', title: 'Retirer cet adversaire', 'aria-label': 'Retirer', onclick: () => { opponents.splice(i, 1); renderSlots(); } }, '✕') : null);
      }),
      opponents.length < max ? h('button', { class: 'btn small', type: 'button', onclick: () => { opponents.push({ kind: 'player' }); renderSlots(); } }, '＋ Ajouter un adversaire') : null);
    updateHint();
  }

  function updateHint() {
    const humans = opponents.filter((o) => o.kind === 'player').length;
    createHint.textContent = humans === 0
      ? 'Seulement des bots : le combat démarre aussitôt créé.'
      : 'Le combat démarre dès ' + (humans === 1 ? 'qu\'un joueur a rejoint' : 'que les ' + humans + ' joueurs ont rejoint') + ' (tu pourras aussi compléter avec des bots).';
  }

  tankSel.addEventListener('change', () => {
    const id = Number(tankSel.value);
    setSelectedTank(id);
    const m = myActiveMatch();
    if (m && m.status !== 'running') sock.send({ type: 'setTank', uid: m.uid, tankId: id });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tankId = Number(tankSel.value);
    if (!tankId) {
      toast('Crée d\'abord un tank dans l\'atelier.', 'error');
      return;
    }
    const ref = Math.random().toString(36).slice(2);
    sock.send({
      type: 'create', ref, tankId, title: titleInput.value, durationSec: Number(durSel.value),
      public: publicCb.checked, opponents,
    });
    createBtn.disabled = true;
    setTimeout(() => { createBtn.disabled = false; }, 800);
  });

  /* ================= Listes ================= */
  const mineBox = h('div', { class: 'my-match' });
  const waitingList = h('div', { class: 'match-list' });
  const runningList = h('div', { class: 'match-list' });
  const doneList = h('div', { class: 'match-list' });
  const playersList = h('ul', { class: 'players' });
  const playersCount = h('span', { class: 'muted small' });

  const centre = h('div', { class: 'lobby-main' },
    mineBox,
    h('h2', { class: 'section-title' }, '⏳ En préparation'), waitingList,
    h('h2', { class: 'section-title' }, '🔴 En cours'), runningList,
    h('h2', { class: 'section-title' }, '🏁 Terminés récemment'), doneList,
    h('p', { class: 'hint' }, 'Tous tes combats passés sont dans l\'', h('a', { href: '#/historique' }, 'historique'), '.'));

  container.appendChild(h('div', { class: 'lobby' },
    h('aside', { class: 'side lobby-side' }, form,
      h('section', { class: 'card tips' },
        h('h3', null, 'Bon à savoir'),
        h('ul', null,
          h('li', null, 'Ton tank combat avec la ', h('b', null, 'dernière version enregistrée'), ' dans l\'atelier au moment du départ.'),
          h('li', null, 'Une fois le combat lancé, tu peux fermer la page : ton programme continue de se battre.'),
          h('li', null, 'Seul toi vois le journal de ton tank (« afficher », pannes).')))),
    centre,
    h('aside', { class: 'side players-side' },
      h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', null, 'Joueurs connectés'), playersCount), playersList))));

  /* ----- Carte d'un combat ----- */
  function chip(m) {
    const [label, cls] = STATUS[m.status] || [m.status, ''];
    const el = h('span', { class: 'chip ' + cls }, label);
    if (m.status === 'countdown' && m.countdownEndsAt) {
      el.dataset.ends = m.countdownEndsAt;
      el.dataset.label = 'Départ dans ';
    } else if (m.status === 'running' && m.startedAt) {
      el.dataset.started = m.startedAt;
      el.dataset.maxTicks = m.maxTicks;
    } else if (m.status === 'queued' && m.queuePosition) {
      el.textContent = 'En file d\'attente (n° ' + m.queuePosition + ')';
    }
    return el;
  }

  function slotView(m, s, i, mine, creator) {
    const pending = ['waiting', 'countdown', 'queued'].includes(m.status);
    const controls = [];
    if (creator && pending && i > 0) {
      if (s.kind === 'player' && s.user) {
        controls.push(h('button', { class: 'btn small', type: 'button', title: 'Retirer ce joueur', onclick: () => sock.send({ type: 'kick', uid: m.uid, slot: i }) }, '✕'));
      } else {
        const sel = h('select', { class: 'small', 'aria-label': 'Changer cette place' }, opponentOptions(s.kind === 'bot' ? 'bot:' + s.botId : 'player'));
        sel.addEventListener('change', () => {
          if (sel.value === 'player') sock.send({ type: 'setSlot', uid: m.uid, slot: i, kind: 'player' });
          else sock.send({ type: 'setSlot', uid: m.uid, slot: i, kind: 'bot', botId: sel.value.slice(4) });
        });
        controls.push(sel);
        if (m.slots.length > 2) controls.push(h('button', { class: 'btn small', type: 'button', title: 'Supprimer cette place', onclick: () => sock.send({ type: 'setSlot', uid: m.uid, slot: i, kind: 'remove' }) }, '−'));
      }
    }
    let body;
    if (s.kind === 'bot') {
      body = [dot(s.color), h('span', { class: 'slot-name' }, '🤖 ' + s.name), h('span', { class: 'muted small' }, ' bot')];
    } else if (s.user) {
      const me = s.user.id === state.me.id;
      body = [dot(s.color), h('span', { class: 'slot-name' }, s.user.pseudo, i === 0 ? ' 👑' : '', me ? h('span', { class: 'badge you' }, 'toi') : null),
        h('span', { class: 'muted small' }, ' · ' + s.tankName)];
    } else {
      body = [h('span', { class: 'dot empty' }), h('span', { class: 'slot-name free' }, 'Place libre pour un joueur')];
    }
    return h('li', { class: 'slot' + (s.kind === 'player' && !s.user ? ' free' : '') }, h('span', { class: 'slot-main' }, body), controls.length ? h('span', { class: 'slot-controls' }, controls) : null);
  }

  function matchCard(m) {
    const mine = m.slots.some((s) => s.user && s.user.id === state.me.id);
    const creator = m.creator.id === state.me.id;
    const pending = ['waiting', 'countdown', 'queued'].includes(m.status);
    const free = m.slots.some((s) => s.kind === 'player' && !s.user);
    const canWatch = m.public || mine || isTeacher();
    const actions = [];

    if (pending) {
      if (!mine && m.status === 'waiting' && free) {
        actions.push(h('button', { class: 'btn primary', type: 'button', disabled: !!myActiveMatch(), onclick: () => join(m) }, '➕ Rejoindre'));
      }
      if (creator) {
        if (free) actions.push(h('button', { class: 'btn', type: 'button', onclick: () => sock.send({ type: 'fillBots', uid: m.uid }) }, '🤖 Compléter avec des bots'));
        if (m.slots.length - 1 < settings().maxOpponents) actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => sock.send({ type: 'setSlot', uid: m.uid, slot: m.slots.length, kind: 'add' }) }, '＋ Place'));
        actions.push(h('button', { class: 'btn danger', type: 'button', onclick: () => sock.send({ type: 'cancel', uid: m.uid }) }, 'Annuler le combat'));
      } else if (mine) {
        actions.push(h('button', { class: 'btn', type: 'button', onclick: () => sock.send({ type: 'leave', uid: m.uid }) }, 'Quitter'));
      } else if (isTeacher()) {
        actions.push(h('button', { class: 'btn small danger', type: 'button', onclick: () => sock.send({ type: 'cancel', uid: m.uid }) }, 'Annuler'));
      }
      if ((mine || isTeacher()) && m.status !== 'waiting') actions.push(h('a', { class: 'btn', href: '#/combat/' + m.uid }, '👁 Voir'));
    } else if (m.status === 'running') {
      if (canWatch) actions.push(h('a', { class: 'btn primary', href: '#/combat/' + m.uid }, mine ? '👁 Voir mon combat' : '👁 Regarder'));
      else actions.push(h('span', { class: 'muted small' }, '🔒 Privé'));
      if (isTeacher()) actions.push(h('button', { class: 'btn small danger', type: 'button', onclick: () => stopMatch(m) }, '⏹ Arrêter'));
    } else if (m.status === 'finished') {
      if (canWatch) actions.push(h('a', { class: 'btn', href: '#/combat/' + m.uid }, '▶ Revoir'));
    }

    let result = null;
    if (m.status === 'finished' && m.results) {
      const w = m.results.ranking.find((r) => r.index === m.results.winner);
      result = h('p', { class: 'result-line' }, w ? ['🏆 ', dot(w.color), ' ', h('b', null, w.name), ' gagne avec ', String(w.damageDealt), ' dégâts'] : '🤝 Match nul');
    } else if (m.status === 'aborted') {
      result = h('p', { class: 'result-line error-text' }, m.abortReason || 'Combat arrêté.');
    }

    return h('article', { class: 'match-card status-' + m.status + (mine ? ' mine' : '') },
      h('header', null,
        h('h3', null, m.title),
        chip(m),
        h('span', { class: 'muted small', title: m.public ? 'Public : tout le monde peut regarder' : 'Privé : seuls les participants peuvent regarder' }, m.public ? '🌐' : '🔒'),
        m.spectators ? h('span', { class: 'muted small', title: 'Spectateurs' }, '👁 ' + m.spectators) : null),
      h('p', { class: 'muted small' }, 'Créé par ' + m.creator.pseudo + ' · ' + formatDuration(m.durationSec)),
      h('ul', { class: 'slots' }, m.slots.map((s, i) => slotView(m, s, i, mine, creator))),
      result,
      actions.length ? h('div', { class: 'row' }, actions) : null);
  }

  function join(m) {
    const tankId = Number(tankSel.value) || selectedTankId();
    if (!tankId) {
      toast('Crée d\'abord un tank dans l\'atelier.', 'error');
      return;
    }
    sock.send({ type: 'join', uid: m.uid, tankId });
  }

  async function stopMatch(m) {
    if (await confirmDialog('Arrêter ce combat ?', 'Le combat « ' + m.title + ' » sera arrêté sans résultat.', { ok: 'Arrêter', danger: true })) {
      sock.send({ type: 'cancel', uid: m.uid });
    }
  }

  function empty(text) {
    return h('p', { class: 'empty' }, text);
  }

  function render() {
    const all = state.lobby.matches;
    const mine = myActiveMatch();
    fill(mineBox, mine ? [h('h2', { class: 'section-title' }, '⭐ Mon combat'), matchCard(mine)] : null);
    const waiting = all.filter((m) => ['waiting', 'countdown', 'queued'].includes(m.status) && m !== mine);
    const running = all.filter((m) => m.status === 'running' && m !== mine);
    const done = all.filter((m) => m.status === 'finished' || m.status === 'aborted');
    fill(waitingList, waiting.length ? waiting.map(matchCard) : empty(mine ? 'Aucun autre combat en préparation.' : 'Aucun combat en préparation : crée le tien !'));
    fill(runningList, running.length ? running.map(matchCard) : empty('Aucun combat en cours.'));
    fill(doneList, done.length ? done.map(matchCard) : empty('Aucun combat terminé pour l\'instant.'));

    createBtn.disabled = !!mine;
    form.classList.toggle('disabled', !!mine);
    createBtn.textContent = mine ? 'Tu es déjà inscrit à un combat' : '⚔️ Créer le combat';

    const players = state.lobby.players;
    playersCount.textContent = String(players.length);
    fill(playersList, players.length ? players.map((p) => {
      const [label, cls] = PLAYER_STATUS[p.status] || [p.status, ''];
      return h('li', { class: 'player ' + cls + (p.away ? ' away' : '') },
        h('span', { class: 'pdot', 'aria-hidden': 'true' }),
        h('span', { class: 'pname' }, p.pseudo, p.role === 'teacher' ? ' 🎓' : '', p.id === state.me.id ? h('span', { class: 'badge you' }, 'toi') : null),
        h('span', { class: 'pstatus' }, p.away ? 'reconnexion…' : label));
    }) : h('li', { class: 'empty' }, 'Personne pour le moment.'));
    tick();
  }

  /* ----- Décomptes et chronos ----- */
  function tick() {
    const now = sock.now();
    for (const el of container.querySelectorAll('[data-ends]')) {
      const s = Math.max(0, Math.ceil((Number(el.dataset.ends) - now) / 1000));
      el.textContent = el.dataset.label + s + ' s';
    }
    for (const el of container.querySelectorAll('[data-started]')) {
      const elapsed = (now - Number(el.dataset.started)) / 1000 * 60;
      el.textContent = 'En cours · ' + clock(Number(el.dataset.maxTicks) - elapsed);
    }
  }
  const ticker = setInterval(tick, 250);

  /* ----- Abonnements ----- */
  const offs = [
    on('lobby', render),
    on('tanks', fillTanks),
    on('selectedTank', fillTanks),
    on('hello', () => { fillDurations(); renderSlots(); }),
    on('settings', () => { fillDurations(); renderSlots(); render(); }),
    sock.on('created', () => {
      titleInput.value = '';
      // avec seulement des bots, le décompte commence aussitôt et on part voir le combat
      if (opponents.some((o) => o.kind === 'player')) toast('Combat créé : en attente des adversaires.', 'ok');
    }),
  ];

  fillTanks();
  fillDurations();
  renderSlots();
  render();

  return {
    unmount() {
      clearInterval(ticker);
      for (const off of offs) off();
    },
  };
}
