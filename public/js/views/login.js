/*
 * Connexion, inscription (avec le code du cours) et premier lancement
 * (création du compte enseignant).
 */
import { h, fill } from '../ui.js';
import { GET, POST } from '../net.js';

export async function mount(container, { onLogin }) {
  let status;
  try {
    status = await GET('/api/status');
  } catch (err) {
    fill(container, h('div', { class: 'login-box' }, h('h1', null, 'Serveur injoignable'), h('p', null, err.message)));
    return;
  }

  const box = h('div', { class: 'login-box' });
  container.appendChild(h('div', { class: 'login-page' },
    h('div', { class: 'login-hero' },
      h('img', { src: '/img/logo.svg', alt: '', class: 'hero-logo' }),
      h('h1', null, 'Tanko', h('b', null, 'Blocs'), ' Réseau'),
      h('p', { class: 'lead' }, 'Programme ton tank avec des blocs, entraîne-le contre les bots, puis affronte les autres joueurs en direct.')),
    box));

  if (status.setupNeeded) setupForm(box, onLogin);
  else loginForms(box, onLogin, status.registrationOpen);
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

function submitButton(label) {
  return h('button', { class: 'btn primary big', type: 'submit' }, label);
}

async function run(form, msg, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  msg.textContent = '';
  try {
    await fn();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function setupForm(box, onLogin) {
  const pseudo = h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 20 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const msg = h('p', { class: 'status error', role: 'alert' });
  const form = h('form', { class: 'form' },
    h('h2', null, '👋 Premier lancement'),
    h('p', null, 'Aucun compte n\'existe encore. Crée le compte ', h('b', null, 'enseignant'), ' : il permettra de créer les cours, de donner aux élèves leur code d\'inscription et d\'administrer le serveur.'),
    field('Ton pseudo', pseudo, 'Par exemple « Prof » ou ton prénom.'),
    field('Mot de passe (6 caractères au moins)', pw),
    field('Mot de passe, encore une fois', pw2),
    msg,
    submitButton('Créer le compte enseignant'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(form, msg, async () => {
      if (pw.value !== pw2.value) throw new Error('Les deux mots de passe sont différents.');
      const r = await POST('/api/setup', { pseudo: pseudo.value, password: pw.value });
      location.hash = '#/admin';
      onLogin(r.me);
    });
  });
  fill(box, form);
  pseudo.focus();
}

function loginForms(box, onLogin, registrationOpen) {
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const panel = h('div');
  const show = (which) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === which));
    fill(panel, which === 'login' ? loginForm(onLogin) : registerForm(onLogin, registrationOpen));
    const first = panel.querySelector('input');
    if (first) first.focus();
  };
  tabs.append(
    h('button', { type: 'button', role: 'tab', dataset: { tab: 'login' }, onclick: () => show('login') }, 'Se connecter'),
    h('button', { type: 'button', role: 'tab', dataset: { tab: 'register' }, onclick: () => show('register') }, 'Créer mon compte'));
  fill(box, tabs, panel);
  show('login');
}

function loginForm(onLogin) {
  const pseudo = h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 20 });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('p', { class: 'status error', role: 'alert' });
  const form = h('form', { class: 'form' },
    field('Pseudo', pseudo),
    field('Mot de passe', pw),
    msg,
    submitButton('Se connecter'),
    h('p', { class: 'hint' }, 'Mot de passe oublié ? L\'enseignant peut t\'en donner un provisoire.'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(form, msg, async () => {
      const r = await POST('/api/login', { pseudo: pseudo.value, password: pw.value });
      onLogin(r.me);
    });
  });
  return form;
}

function registerForm(onLogin, open) {
  if (!open) {
    return h('div', { class: 'form' }, h('p', null, '🔒 Les inscriptions sont fermées pour le moment. Demande à l\'enseignant de les ouvrir.'));
  }
  const code = h('input', { type: 'text', autocomplete: 'off', required: true, maxlength: 12, placeholder: 'ex. BAKO-4821', class: 'code-input' });
  const pseudo = h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 20 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 6 });
  const msg = h('p', { class: 'status error', role: 'alert' });
  const form = h('form', { class: 'form' },
    field('Code du cours', code, 'Il est donné par l\'enseignant (au tableau, par exemple).'),
    field('Choisis un pseudo', pseudo, 'C\'est le nom que les autres joueurs verront.'),
    field('Mot de passe (6 caractères au moins)', pw),
    field('Mot de passe, encore une fois', pw2),
    msg,
    submitButton('Créer mon compte'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(form, msg, async () => {
      if (pw.value !== pw2.value) throw new Error('Les deux mots de passe sont différents.');
      const r = await POST('/api/register', { code: code.value, pseudo: pseudo.value, password: pw.value });
      location.hash = '#/atelier';
      onLogin(r.me);
    });
  });
  return form;
}
