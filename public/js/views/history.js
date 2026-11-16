/*
 * Historique : mes combats (et, pour tous, les combats publics).
 */
import { h, fill, dot, formatDate, formatDuration, percent } from '../ui.js';
import { GET } from '../net.js';
import { state, isTeacher } from '../state.js';

export async function mount(container, { query }) {
  const scope = query.get('tous') !== null ? 'all' : 'mine';
  const meId = state.me.id;

  const stats = h('div', { class: 'stats' });
  const tbody = h('tbody');
  const more = h('button', { class: 'btn', type: 'button', hidden: true }, 'Afficher plus');
  container.appendChild(h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', null, '📜 Historique'),
      h('div', { class: 'seg' },
        h('a', { href: '#/historique', 'aria-selected': String(scope === 'mine') }, 'Mes combats'),
        h('a', { href: '#/historique?tous', 'aria-selected': String(scope === 'all') }, isTeacher() ? 'Tous les combats' : 'Combats publics'))),
    scope === 'mine' ? stats : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'results history' },
      h('thead', null, h('tr', null,
        h('th', null, 'Date'), h('th', null, 'Combat'), h('th', null, 'Participants'),
        scope === 'mine' ? h('th', { class: 'num' }, 'Mon rang') : null,
        scope === 'mine' ? h('th', { class: 'num' }, 'Mes dégâts') : null,
        h('th', { class: 'num' }, 'Durée'), h('th', null, ''))),
      tbody)),
    h('div', { class: 'row center' }, more)));

  if (scope === 'mine') {
    const r = await GET('/api/me');
    const s = r.stats;
    if (s) {
      fill(stats,
        statCard('Contre des joueurs', s.pvpPlayed ? s.pvpWins + ' / ' + s.pvpPlayed : '—', s.pvpPlayed ? percent(s.pvpRate) + ' de victoires · ' + s.pvpDamage.toFixed(0) + ' dégâts en moyenne' : 'Aucun combat pour l\'instant'),
        statCard('Contre les bots', s.botPlayed ? s.botWins + ' / ' + s.botPlayed : '—', s.botPlayed ? percent(s.botWins / s.botPlayed) + ' de victoires' : 'Aucun combat pour l\'instant'));
    }
  }

  let before = null;
  async function load() {
    const params = new URLSearchParams({ limit: '30' });
    if (scope === 'all') params.set('scope', 'all');
    if (before) params.set('before', String(before));
    const list = (await GET('/api/matches?' + params)).matches;
    if (!before && !list.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: 7, class: 'empty' }, scope === 'mine' ? 'Tu n\'as pas encore combattu. Direction le salon !' : 'Aucun combat pour l\'instant.')));
    }
    for (const m of list) tbody.appendChild(row(m));
    before = list.length ? list[list.length - 1].id : before;
    more.hidden = list.length < 30;
  }

  function row(m) {
    const me = m.participants.find((p) => p.userId === meId);
    const won = me && m.winner === me.index;
    const aborted = m.status === 'aborted';
    return h('tr', { class: won ? 'won' : '' },
      h('td', { class: 'nowrap' }, formatDate(m.startedAt)),
      h('td', null, h('b', null, m.title), m.public ? '' : h('span', { class: 'muted' }, ' 🔒'),
        aborted ? h('div', { class: 'error-text small' }, m.abortReason || 'arrêté') : null),
      h('td', null, h('div', { class: 'chips' }, m.participants.map((p) => h('span', { class: 'pchip' + (p.index === m.winner ? ' winner' : '') + (p.userId === meId ? ' me' : ''), title: p.tankName },
        dot(p.color), p.bot ? '🤖 ' : '', p.name, p.index === m.winner ? ' 🏆' : '')))),
      scope === 'mine' ? h('td', { class: 'num' }, aborted || !me ? '—' : (won ? '🏆 ' : '') + me.rank + ' / ' + m.participants.length) : null,
      scope === 'mine' ? h('td', { class: 'num' }, aborted || !me ? '—' : String(me.damageDealt)) : null,
      h('td', { class: 'num' }, m.ticks ? formatDuration(m.ticks / 60) : '—'),
      h('td', null, aborted ? '' : h('a', { class: 'btn small', href: '#/combat/' + m.uid }, '▶ Revoir')));
  }

  more.addEventListener('click', load);
  await load();
  return null;
}

function statCard(title, big, sub) {
  return h('div', { class: 'stat-card' }, h('div', { class: 'stat-title' }, title), h('div', { class: 'stat-big' }, big), h('div', { class: 'muted small' }, sub));
}
