/*
 * Classement : victoires contre d'autres joueurs (combats avec au moins
 * deux joueurs humains), puis taux de victoires et dégâts moyens.
 */
import { h, fill, percent } from '../ui.js';
import { GET } from '../net.js';
import { state, isTeacher } from '../state.js';

export async function mount(container, { query }) {
  const sel = h('select', { 'aria-label': 'Cours' });
  const tbody = h('tbody');
  container.appendChild(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', null, '🏆 Classement'),
      h('label', { class: 'inline' }, 'Cours ', sel)),
    h('p', { class: 'hint' }, 'Seuls les combats contre au moins un autre joueur comptent pour le classement. Les combats contre les bots seuls sont indiqués à part.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'results leaderboard' },
      h('thead', null, h('tr', null,
        h('th', { class: 'num' }, '#'), h('th', null, 'Joueur'), h('th', null, 'Cours'),
        h('th', { class: 'num' }, 'Victoires'), h('th', { class: 'num' }, 'Combats'), h('th', { class: 'num' }, '% victoires'),
        h('th', { class: 'num' }, 'Dégâts moyens'), h('th', { class: 'num', title: 'Combats contre les bots seulement' }, 'Contre les bots'))),
      tbody))));

  async function load(course) {
    const r = await GET('/api/leaderboard?course=' + encodeURIComponent(course));
    if (!sel.options.length) {
      fill(sel, h('option', { value: 'all' }, 'Tous les cours'), r.courses.map((c) => h('option', { value: c.id }, c.name)));
    }
    sel.value = String(course);
    const rows = r.rows.filter((x) => isTeacher() || x.pvpPlayed || x.botPlayed || x.id === state.me.id);
    let rank = 0;
    let prev = null;
    fill(tbody, rows.length ? rows.map((x, i) => {
      const key = x.pvpWins + '|' + x.pvpRate + '|' + x.pvpDamage;
      if (key !== prev) rank = i + 1;
      prev = key;
      return h('tr', { class: x.id === state.me.id ? 'mine' : '' },
        h('td', { class: 'num' }, x.pvpPlayed ? (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank)) : '—'),
        h('td', null, h('b', null, x.pseudo)),
        h('td', { class: 'muted' }, x.courseName || '—'),
        h('td', { class: 'num' }, String(x.pvpWins)),
        h('td', { class: 'num' }, String(x.pvpPlayed)),
        h('td', { class: 'num' }, x.pvpPlayed ? percent(x.pvpRate) : '—'),
        h('td', { class: 'num' }, x.pvpPlayed ? x.pvpDamage.toFixed(0) : '—'),
        h('td', { class: 'num muted' }, x.botPlayed ? x.botWins + ' / ' + x.botPlayed : '—'));
    }) : h('tr', null, h('td', { colspan: 8, class: 'empty' }, 'Pas encore de combat.')));
  }

  sel.addEventListener('change', () => load(sel.value));
  const initial = query.get('cours') || (state.me.courseId && !isTeacher() ? state.me.courseId : 'all');
  await load(initial);
  return null;
}
