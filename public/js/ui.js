/*
 * Outils d'interface : création d'éléments, messages, boîtes de dialogue,
 * mise en forme des dates et durées.
 *
 * Règle : tout texte venant d'un joueur passe par textContent (jamais
 * innerHTML), ce que fait h() pour les chaînes.
 */

/**
 * Crée un élément.
 *   h('button', { class: 'btn', onclick: fn }, 'Texte', autreElement)
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Remplace le contenu d'un élément. */
export function fill(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function dot(color, big) {
  return h('span', { class: 'dot' + (big ? ' big' : ''), style: { background: color || '#888' } });
}

/* ---------- Messages éphémères ---------- */

export function toast(text, level = 'info', ms = 4500) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: 'toast ' + level, role: level === 'error' ? 'alert' : 'status' }, text);
  box.appendChild(t);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/* ---------- Boîtes de dialogue ---------- */

/**
 * Boîte modale. buttons : [{ label, value, class }]
 * Renvoie une promesse résolue avec la valeur du bouton (null si fermée).
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, class: 'primary' }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : '') });
    const form = h('form', { method: 'dialog' });
    form.appendChild(h('h2', null, title));
    if (body) form.appendChild(typeof body === 'string' ? h('p', null, body) : body);
    const row = h('div', { class: 'row end' });
    for (const b of buttons) {
      row.appendChild(h('button', { class: 'btn ' + (b.class || ''), value: String(b.value), type: b.submit === false ? 'button' : 'submit' }, b.label));
    }
    form.appendChild(row);
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    let result = null;
    form.addEventListener('submit', (e) => {
      const v = e.submitter ? e.submitter.value : null;
      const btn = buttons.find((b) => String(b.value) === v);
      if (btn && btn.validate && !btn.validate(form)) {
        e.preventDefault();
        return;
      }
      result = btn ? btn.value : null;
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.showModal();
    if (onOpen) onOpen(form);
  });
}

export async function confirmDialog(title, text, { ok = 'Confirmer', danger = false } = {}) {
  const v = await modal({
    title,
    body: text,
    buttons: [{ label: 'Annuler', value: 'no' }, { label: ok, value: 'yes', class: danger ? 'danger-solid' : 'primary' }],
  });
  return v === 'yes';
}

export async function promptDialog(title, label, value = '', { ok = 'Valider', maxLength = 60 } = {}) {
  const input = h('input', { type: 'text', value, maxlength: maxLength, required: true });
  const v = await modal({
    title,
    body: h('label', { class: 'field' }, h('span', null, label), input),
    buttons: [{ label: 'Annuler', value: 'no', submit: true }, { label: ok, value: 'yes', class: 'primary' }],
    onOpen: () => { input.focus(); input.select(); },
  });
  return v === 'yes' ? input.value.trim() : null;
}

/* ---------- Mise en forme ---------- */

const DTF = new Intl.DateTimeFormat('fr-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const DF = new Intl.DateTimeFormat('fr-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return 'il y a ' + Math.floor(diff / 60) + ' min';
  if (diff < 6 * 3600 && new Date().getDate() === d.getDate()) return 'il y a ' + Math.floor(diff / 3600) + ' h';
  return DTF.format(d);
}

export function formatLongDate(iso) {
  return iso ? DF.format(new Date(iso)) : '—';
}

export function formatDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec + ' s';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? m + ' min ' + String(s).padStart(2, '0') : m + ' min';
}

/** Temps de jeu « 1:05 » à partir d'un nombre de ticks. */
export function clock(ticks) {
  const s = Math.max(0, Math.ceil(ticks / 60));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function plural(n, one, many) {
  return n + ' ' + (n > 1 ? many : one);
}

export function percent(x) {
  return Math.round(x * 100) + ' %';
}

/** Télécharge un fichier JSON. */
export function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'tank';
}

/** Badge de niveau d'un bot. */
export function levelBadge(level) {
  return h('span', { class: 'badge lvl-' + level }, level);
}

/** Stockage local (préférences de ce navigateur seulement). */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('tbr.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem('tbr.' + key, JSON.stringify(value)); } catch { /* ignoré */ }
  },
};
