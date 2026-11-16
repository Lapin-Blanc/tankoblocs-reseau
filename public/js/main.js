/*
 * TankoBlocs Réseau : démarrage de l'application, navigation, barre du haut.
 */
import { h, fill, toast, modal, prefs } from './ui.js';
import { GET, POST, onUnauthorized } from './net.js';
import { state, emit, loadTanks, loadBots, isTeacher } from './state.js';
import { getAudio } from './arena.js';
import { go } from './nav.js';
import * as loginView from './views/login.js';
import * as atelierView from './views/atelier.js';
import * as trainingView from './views/training.js';
import * as lobbyView from './views/lobby.js';
import * as liveView from './views/live.js';
import * as historyView from './views/history.js';
import * as leaderboardView from './views/leaderboard.js';
import * as guideView from './views/guide.js';
import * as adminView from './views/admin.js';

const ROUTES = {
  atelier: atelierView,
  entrainement: trainingView,
  combats: lobbyView,
  combat: liveView,
  historique: historyView,
  classement: leaderboardView,
  guide: guideView,
  admin: adminView,
};

const NAV = [
  ['atelier', '🛠️', 'Atelier'],
  ['entrainement', '🎯', 'Entraînement'],
  ['combats', '⚔️', 'Combats'],
  ['historique', '📜', 'Historique'],
  ['classement', '🏆', 'Classement'],
  ['guide', '📖', 'Guide'],
];

const main = document.getElementById('main');
let current = null; // { name, view, instance }
let started = false;

/* ---------- Navigation ---------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'combats', args: parts.slice(1), query: new URLSearchParams(query || '') };
}


async function route() {
  if (!state.me) return;
  const { name, args, query } = parseHash();
  const view = ROUTES[name] && (name !== 'admin' || isTeacher()) ? ROUTES[name] : null;
  if (!view) {
    location.replace('#/combats');
    return;
  }
  if (current && current.instance && current.instance.unmount) {
    try { await current.instance.unmount(); } catch (err) { console.error(err); }
  }
  fill(main);
  const container = h('section', { class: 'view view-' + name });
  main.appendChild(container);
  current = { name, view, key: args.join('/') + '?' + query, instance: null };
  updateNav(name);
  try {
    current.instance = (await view.mount(container, { args, query })) || null;
  } catch (err) {
    console.error(err);
    fill(container, h('div', { class: 'empty-state' }, h('h2', null, 'Oups'), h('p', null, err.message || String(err))));
  }
}

function updateNav(name) {
  for (const a of document.querySelectorAll('#nav a')) {
    a.setAttribute('aria-current', a.dataset.route === name || (name === 'combat' && a.dataset.route === 'combats') ? 'page' : 'false');
  }
}

/* ---------- Barre du haut ---------- */

function buildTopbar() {
  const nav = document.getElementById('nav');
  const items = NAV.slice();
  if (isTeacher()) items.push(['admin', '🎓', 'Administration']);
  fill(nav, items.map(([route, icon, label]) =>
    h('a', { href: '#/' + route, dataset: { route } }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'nav-label' }, label))));
  nav.hidden = false;

  const conn = h('span', { class: 'conn', title: 'Connexion au serveur' });
  const setConn = (s) => {
    conn.className = 'conn ' + s;
    conn.title = s === 'open' ? 'Connecté au serveur' : s === 'connecting' ? 'Connexion en cours…' : 'Déconnecté : nouvelle tentative…';
  };
  setConn(state.socket.status);
  state.socket.on('status', setConn);

  const sound = h('button', { class: 'icon-btn', type: 'button', title: 'Son' });
  const setSound = () => { sound.textContent = getAudio().enabled ? '🔊' : '🔇'; };
  sound.addEventListener('click', () => {
    const a = getAudio();
    a.setEnabled(!a.enabled);
    prefs.set('sound', a.enabled);
    try { localStorage.setItem('tbr.sound', String(a.enabled)); } catch { /* ignoré */ }
    setSound();
  });
  setSound();

  const menuBtn = h('button', { class: 'user-btn', type: 'button', 'aria-haspopup': 'true' },
    isTeacher() ? '🎓 ' : '👤 ', state.me.pseudo, ' ▾');
  const menu = h('div', { class: 'user-menu', hidden: true },
    h('button', { type: 'button', onclick: () => { menu.hidden = true; changePassword(false); } }, '🔑 Changer de mot de passe'),
    h('button', { type: 'button', onclick: logout }, '🚪 Se déconnecter'));
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });

  fill(document.getElementById('topbar-right'), conn, sound, h('div', { class: 'user' }, menuBtn, menu));
}

async function logout() {
  try { await POST('/api/logout'); } catch { /* ignoré */ }
  location.hash = '';
  location.reload();
}

async function changePassword(forced) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
  const again = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
  const msg = h('p', { class: 'status error' });
  const body = h('div', { class: 'form' },
    forced ? h('p', null, 'L\'enseignant t\'a donné un mot de passe provisoire. Choisis maintenant ton propre mot de passe.') : null,
    h('label', { class: 'field' }, h('span', null, forced ? 'Mot de passe provisoire' : 'Mot de passe actuel'), current),
    h('label', { class: 'field' }, h('span', null, 'Nouveau mot de passe (6 caractères au moins)'), next),
    h('label', { class: 'field' }, h('span', null, 'Nouveau mot de passe, encore une fois'), again),
    msg);
  for (;;) {
    const v = await modal({
      title: '🔑 Changer de mot de passe',
      body,
      buttons: forced ? [{ label: 'Enregistrer', value: 'ok', class: 'primary' }] : [{ label: 'Annuler', value: 'no' }, { label: 'Enregistrer', value: 'ok', class: 'primary' }],
      onOpen: () => current.focus(),
    });
    if (v !== 'ok') {
      if (forced) continue;
      return;
    }
    if (next.value !== again.value) {
      msg.textContent = 'Les deux nouveaux mots de passe sont différents.';
      continue;
    }
    try {
      const r = await POST('/api/me/password', { current: current.value, next: next.value });
      state.me = r.me;
      toast('Mot de passe changé.', 'ok');
      return;
    } catch (err) {
      msg.textContent = err.message;
    }
  }
}

/* ---------- Événements du salon valables partout ---------- */

function wireSocket() {
  const s = state.socket;
  s.on('hello', (m) => {
    state.settings = m.settings;
    emit('hello', m);
  });
  s.on('me', (m) => {
    state.me = { ...state.me, ...m.me };
    emit('me', state.me);
  });
  s.on('lobby', (m) => {
    state.lobby = { players: m.players, matches: m.matches };
    if (m.settings && JSON.stringify(m.settings) !== JSON.stringify(state.settings)) {
      state.settings = m.settings;
      emit('settings', state.settings);
    }
    emit('lobby', state.lobby);
  });
  s.on('toast', (m) => toast(m.text, m.level || 'info'));
  s.on('error', (m) => toast(m.text, 'error'));
  s.on('countdown', async (m) => {
    // un de mes combats va commencer : on y va (après avoir enregistré le programme)
    emit('beforeMatch', m.uid);
    const { name, args } = parseHash();
    if (name !== 'combat' || args[0] !== m.uid) {
      toast('⚔️ Ton combat commence !', 'ok');
      if (current && current.instance && current.instance.flush) {
        try { await current.instance.flush(); } catch { /* ignoré */ }
      }
      go('#/combat/' + m.uid);
    }
  });
  s.on('kicked', () => {
    toast('Ta session a été fermée par l\'enseignant.', 'error', 8000);
    setTimeout(() => location.reload(), 2500);
  });
}

/* ---------- Démarrage ---------- */

async function startApp(me) {
  if (started) return;
  started = true;
  state.me = me;
  document.body.classList.add('logged-in');
  await Promise.all([loadBots(), loadTanks()]);
  buildTopbar();
  wireSocket();
  state.socket.connect();
  window.addEventListener('hashchange', route);
  document.addEventListener('pointerdown', () => getAudio().unlock(), { once: true });
  if (me.mustChangePassword) changePassword(true);
  await route();
}

async function boot() {
  onUnauthorized(() => {
    if (started) {
      toast('Ta session a expiré : reconnecte-toi.', 'error', 6000);
      setTimeout(() => location.reload(), 2000);
    }
  });
  let me = null;
  try {
    me = (await GET('/api/me')).me;
  } catch {
    me = null;
  }
  fill(main);
  if (me) {
    await startApp(me);
  } else {
    const container = h('section', { class: 'view view-login' });
    main.appendChild(container);
    await loginView.mount(container, { onLogin: (u) => { fill(main); startApp(u); } });
  }
}

boot();
