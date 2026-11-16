/*
 * Administration (enseignant) : cours et codes d'inscription, joueurs,
 * combats en cours, réglages.
 *
 * #/admin/cours · #/admin/joueurs · #/admin/combats · #/admin/reglages
 */
import { h, fill, toast, modal, confirmDialog, promptDialog, formatDate, dot, clock } from '../ui.js';
import { GET, POST, PUT, DELETE } from '../net.js';
import { state, on } from '../state.js';

const TABS = [['cours', '🏫 Cours'], ['joueurs', '👥 Joueurs'], ['combats', '⚔️ Combats en cours'], ['reglages', '⚙️ Réglages']];

export async function mount(container, { args }) {
  const tab = TABS.some(([k]) => k === args[0]) ? args[0] : 'cours';
  const body = h('div', { class: 'admin-body' });
  container.appendChild(h('div', { class: 'page wide' },
    h('div', { class: 'page-head' },
      h('h1', null, '🎓 Administration'),
      h('nav', { class: 'seg' }, TABS.map(([k, label]) => h('a', { href: '#/admin/' + k, 'aria-selected': String(k === tab) }, label)))),
    body));
  const fn = { cours: courses, joueurs: users, combats: matches, reglages: settings }[tab];
  return (await fn(body)) || null;
}

/* ================= Cours ================= */

async function courses(body) {
  const list = h('div', { class: 'course-list' });
  const name = h('input', { type: 'text', maxlength: 60, placeholder: 'ex. Programmation — mardi soir', required: true });
  const form = h('form', { class: 'card inline-form' },
    h('h3', null, 'Nouveau cours'),
    h('div', { class: 'row' }, name, h('button', { class: 'btn primary', type: 'submit' }, '＋ Créer')));
  const where = h('p', null, '📡 Les élèves ouvrent dans leur navigateur : ', h('code', { class: 'big-code' }, location.origin));
  body.append(
    h('div', { class: 'card info-card' },
      where,
      h('p', { class: 'hint' }, 'Pour s\'inscrire, ils choisissent « Créer mon compte » et tapent le code du cours. Ferme les inscriptions d\'un cours une fois tout le monde inscrit.')),
    form, list);
  // ouvert depuis le serveur lui-même (localhost) : cette adresse ne marche pas pour les élèves
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
    GET('/api/admin/network').then((n) => {
      const urls = n.publicUrl ? [n.publicUrl] : n.addresses;
      if (urls.length) {
        fill(where, '📡 Les élèves ouvrent dans leur navigateur : ', urls.map((u, i) => [i ? h('span', { class: 'muted' }, ' ou ') : null, h('code', { class: 'big-code' }, u)]));
      } else {
        fill(where, '📡 Les élèves ouvrent ', h('code', { class: 'big-code' }, 'http://<adresse de cet ordinateur>:' + n.port),
          h('span', { class: 'hint' }, ' (adresse IP sur le réseau local, visible avec « ipconfig » sous Windows ou « ip a » sous Linux ; ou réglez PUBLIC_URL, voir le README).'));
      }
    }).catch(() => {});
  }

  async function load() {
    const r = await GET('/api/admin/courses');
    fill(list, r.courses.length ? r.courses.map(card) : h('p', { class: 'empty' }, 'Aucun cours. Crée le premier pour obtenir un code d\'inscription.'));
  }

  function card(c) {
    const open = h('input', { type: 'checkbox', checked: c.open });
    open.addEventListener('change', async () => {
      try {
        await PUT('/api/admin/courses/' + c.id, { open: open.checked });
        toast(open.checked ? 'Inscriptions ouvertes.' : 'Inscriptions fermées.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
        open.checked = !open.checked;
      }
    });
    return h('article', { class: 'card course' },
      h('div', { class: 'card-title' }, h('h3', null, c.name), h('span', { class: 'muted small' }, c.players + ' joueur' + (c.players > 1 ? 's' : ''))),
      h('div', { class: 'course-code' },
        h('span', { class: 'muted small' }, 'Code d\'inscription'),
        h('code', { class: 'big-code' + (c.open ? '' : ' closed') }, c.code)),
      h('label', { class: 'inline' }, open, 'Inscriptions ouvertes'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const n = await promptDialog('Renommer le cours', 'Nom du cours', c.name);
          if (n) { await act(() => PUT('/api/admin/courses/' + c.id, { name: n })); load(); }
        } }, '✏️ Renommer'),
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          if (await confirmDialog('Nouveau code ?', 'L\'ancien code ne fonctionnera plus. Les comptes déjà créés ne changent pas.', { ok: 'Changer le code' })) {
            await act(() => PUT('/api/admin/courses/' + c.id, { regenerateCode: true }));
            load();
          }
        } }, '🔄 Nouveau code'),
        h('a', { class: 'btn small', href: '#/classement?cours=' + c.id }, '🏆 Classement'),
        h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
          if (await confirmDialog('Supprimer « ' + c.name + ' » ?', 'Les joueurs du cours gardent leur compte et leurs tanks, mais ne sont plus rattachés à un cours.', { ok: 'Supprimer', danger: true })) {
            await act(() => DELETE('/api/admin/courses/' + c.id));
            load();
          }
        } }, '🗑')));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await act(() => POST('/api/admin/courses', { name: name.value }))) {
      name.value = '';
      load();
    }
  });
  await load();
}

async function act(fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

/* ================= Joueurs ================= */

async function users(body) {
  const filter = h('input', { type: 'search', placeholder: 'Rechercher un pseudo…', 'aria-label': 'Rechercher' });
  const courseFilter = h('select', { 'aria-label': 'Cours' });
  const tbody = h('tbody');
  body.append(
    h('div', { class: 'row' }, filter, courseFilter),
    h('div', { class: 'table-wrap' }, h('table', { class: 'results users' },
      h('thead', null, h('tr', null, h('th', null, 'Pseudo'), h('th', null, 'Cours'), h('th', null, 'Rôle'), h('th', null, 'Dernière visite'),
        h('th', { class: 'num' }, 'Tanks'), h('th', { class: 'num' }, 'Combats'), h('th', null, 'Actions'))),
      tbody)));

  let data = { users: [], courses: [] };

  async function load() {
    data = await GET('/api/admin/users');
    const cur = courseFilter.value;
    fill(courseFilter, h('option', { value: '' }, 'Tous les cours'), h('option', { value: 'none' }, 'Sans cours'),
      data.courses.map((c) => h('option', { value: c.id }, c.name)));
    courseFilter.value = cur;
    render();
  }

  function render() {
    const q = filter.value.trim().toLowerCase();
    const cf = courseFilter.value;
    const online = new Set(state.lobby.players.map((p) => p.id));
    const list = data.users.filter((u) => (!q || u.pseudo.toLowerCase().includes(q))
      && (!cf || (cf === 'none' ? !u.courseId : String(u.courseId) === cf)));
    fill(tbody, list.length ? list.map((u) => {
      const courseSel = h('select', { class: 'small', 'aria-label': 'Cours de ' + u.pseudo },
        h('option', { value: '' }, '—'), data.courses.map((c) => h('option', { value: c.id, selected: c.id === u.courseId }, c.name)));
      courseSel.addEventListener('change', async () => {
        if (await act(() => PUT('/api/admin/users/' + u.id, { courseId: courseSel.value ? Number(courseSel.value) : null }))) toast('Cours modifié.', 'ok');
        load();
      });
      const roleSel = h('select', { class: 'small', 'aria-label': 'Rôle de ' + u.pseudo },
        h('option', { value: 'player', selected: u.role === 'player' }, 'Joueur'), h('option', { value: 'teacher', selected: u.role === 'teacher' }, 'Enseignant'));
      roleSel.addEventListener('change', async () => {
        if (roleSel.value === 'teacher' && !(await confirmDialog('Donner les droits d\'enseignant ?', u.pseudo + ' pourra administrer le serveur (cours, joueurs, réglages).', { ok: 'Confirmer' }))) {
          roleSel.value = u.role;
          return;
        }
        await act(() => PUT('/api/admin/users/' + u.id, { role: roleSel.value }));
        load();
      });
      return h('tr', { class: u.disabled ? 'disabled' : '' },
        h('td', null, h('span', { class: 'pdot ' + (online.has(u.id) ? 'on' : 'off'), title: online.has(u.id) ? 'Connecté' : 'Hors ligne' }), ' ',
          h('b', null, u.pseudo), u.disabled ? h('span', { class: 'badge' }, 'désactivé') : null,
          u.mustChangePassword ? h('span', { class: 'badge', title: 'Doit choisir un nouveau mot de passe' }, 'mdp provisoire') : null),
        h('td', null, courseSel),
        h('td', null, u.id === state.me.id ? 'Enseignant (toi)' : roleSel),
        h('td', { class: 'muted nowrap' }, formatDate(u.lastSeenAt)),
        h('td', { class: 'num' }, String(u.tanks)),
        h('td', { class: 'num' }, String(u.matches)),
        h('td', { class: 'actions nowrap' },
          h('a', { class: 'btn small', href: '#/atelier?voir=' + u.id, title: 'Voir ses tanks (lecture seule)' }, '👁 Tanks'),
          h('button', { class: 'btn small', type: 'button', title: 'Mot de passe provisoire', onclick: () => resetPassword(u) }, '🔑'),
          h('button', { class: 'btn small', type: 'button', title: 'Renommer', onclick: () => rename(u) }, '✏️'),
          u.id !== state.me.id ? h('button', { class: 'btn small', type: 'button', title: u.disabled ? 'Réactiver' : 'Désactiver', onclick: () => toggle(u) }, u.disabled ? '✅' : '🚫') : null,
          u.id !== state.me.id ? h('button', { class: 'btn small danger', type: 'button', title: 'Supprimer', onclick: () => remove(u) }, '🗑') : null));
    }) : h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'Aucun joueur.')));
  }

  async function resetPassword(u) {
    if (!(await confirmDialog('Mot de passe provisoire pour ' + u.pseudo + ' ?', 'Un nouveau mot de passe sera créé. ' + u.pseudo + ' devra en choisir un autre à sa prochaine connexion.', { ok: 'Créer' }))) return;
    try {
      const r = await POST('/api/admin/users/' + u.id + '/password');
      await modal({
        title: '🔑 Mot de passe provisoire',
        body: h('div', null, h('p', null, 'Donne ce mot de passe à ', h('b', null, u.pseudo), ' :'), h('p', { class: 'center' }, h('code', { class: 'big-code' }, r.password)),
          h('p', { class: 'hint' }, 'Il ne sera plus affiché ensuite.')),
        buttons: [{ label: 'C\'est noté', value: true, class: 'primary' }],
      });
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function rename(u) {
    const n = await promptDialog('Renommer ' + u.pseudo, 'Nouveau pseudo', u.pseudo, { maxLength: 20 });
    if (n && n !== u.pseudo && (await act(() => PUT('/api/admin/users/' + u.id, { pseudo: n })))) load();
  }

  async function toggle(u) {
    if (!u.disabled && !(await confirmDialog('Désactiver ' + u.pseudo + ' ?', 'Le compte ne pourra plus se connecter (ses tanks et ses combats sont gardés). Tu pourras le réactiver.', { ok: 'Désactiver', danger: true }))) return;
    if (await act(() => PUT('/api/admin/users/' + u.id, { disabled: !u.disabled }))) load();
  }

  async function remove(u) {
    if (!(await confirmDialog('Supprimer ' + u.pseudo + ' ?', 'Le compte et ses tanks seront supprimés définitivement. Les combats déjà joués restent dans l\'historique, sous son ancien pseudo.', { ok: 'Supprimer', danger: true }))) return;
    if (await act(() => DELETE('/api/admin/users/' + u.id))) load();
  }

  filter.addEventListener('input', render);
  courseFilter.addEventListener('change', render);
  const off = on('lobby', render);
  await load();
  return { unmount: off };
}

/* ================= Combats en cours ================= */

function matches(body) {
  const list = h('div', { class: 'match-list' });
  body.append(h('p', { class: 'hint' }, 'Tous les combats en préparation ou en cours, y compris les combats privés. Tu peux les regarder, les annuler ou les arrêter.'), list);
  const sock = state.socket;

  function render() {
    const ms = state.lobby.matches.filter((m) => ['waiting', 'countdown', 'queued', 'running'].includes(m.status));
    fill(list, ms.length ? h('table', { class: 'results' },
      h('thead', null, h('tr', null, h('th', null, 'Combat'), h('th', null, 'État'), h('th', null, 'Participants'), h('th', null, ''))),
      h('tbody', null, ms.map((m) => h('tr', null,
        h('td', null, h('b', null, m.title), m.public ? '' : ' 🔒', h('div', { class: 'muted small' }, 'par ' + m.creator.pseudo)),
        h('td', { class: 'nowrap' }, m.status === 'running' ? '🔴 en cours' + (m.startedAt ? ' · ' + clock(m.maxTicks - (sock.now() - m.startedAt) / 1000 * 60) : '') : '⏳ en préparation'),
        h('td', null, h('div', { class: 'chips' }, m.slots.map((s) => h('span', { class: 'pchip' }, s.kind === 'bot' ? [dot(s.color), '🤖 ' + s.name] : s.user ? [dot(s.color), s.user.pseudo] : '…')))),
        h('td', { class: 'nowrap' },
          h('a', { class: 'btn small', href: '#/combat/' + m.uid }, '👁 Regarder'), ' ',
          h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
            if (await confirmDialog(m.status === 'running' ? 'Arrêter ce combat ?' : 'Annuler ce combat ?', '« ' + m.title + ' » sera arrêté sans résultat.', { ok: m.status === 'running' ? 'Arrêter' : 'Annuler le combat', danger: true })) {
              sock.send({ type: 'cancel', uid: m.uid });
            }
          } }, m.status === 'running' ? '⏹ Arrêter' : '✕ Annuler')))))) : h('p', { class: 'empty' }, 'Aucun combat en cours.'));
  }
  const off = on('lobby', render);
  const t = setInterval(render, 1000);
  render();
  return { unmount() { off(); clearInterval(t); } };
}

/* ================= Réglages ================= */

async function settings(body) {
  const r = await GET('/api/admin/settings');
  const s = r.settings;
  const num = (key, label, min, max, unit, hint) => {
    const input = h('input', { type: 'number', min, max, value: s[key], name: key, required: true });
    return h('label', { class: 'field' }, h('span', null, label), h('span', { class: 'row tight' }, input, unit ? h('span', { class: 'muted' }, unit) : null), hint ? h('small', { class: 'hint' }, hint) : null);
  };
  const reg = h('input', { type: 'checkbox', name: 'registrationOpen', checked: s.registrationOpen });
  const form = h('form', { class: 'card settings-form' },
    h('h3', null, 'Combats'),
    h('div', { class: 'grid-2' },
      num('minDurationSec', 'Durée minimale', 10, 600, 'secondes'),
      num('maxDurationSec', 'Durée maximale', 10, 600, 'secondes'),
      num('maxOpponents', 'Adversaires au plus', 1, 3, '', 'De 1 à 3 (4 tanks au plus dans l\'arène).'),
      num('countdownSec', 'Décompte avant le départ', 2, 30, 'secondes'),
      num('maxRunningMatches', 'Combats simultanés au plus', 1, 64, '', 'Au-delà, les combats attendent leur tour.'),
      num('maxTanksPerPlayer', 'Tanks par joueur au plus', 1, 200)),
    h('h3', null, 'Inscriptions'),
    h('label', { class: 'inline' }, reg, 'Inscriptions ouvertes (en plus du réglage de chaque cours)'),
    h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')));
  body.appendChild(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = { registrationOpen: reg.checked };
    for (const input of form.querySelectorAll('input[type=number]')) patch[input.name] = Number(input.value);
    try {
      const res = await PUT('/api/admin/settings', patch);
      for (const input of form.querySelectorAll('input[type=number]')) input.value = res.settings[input.name];
      toast('Réglages enregistrés.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
