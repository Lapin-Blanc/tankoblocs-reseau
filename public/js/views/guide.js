/*
 * Guide : fonctionnement du mode réseau, puis les règles et les blocs
 * (repris tels quels du guide de TankoBlocs, vendor/tankoblocs/guide.html).
 */
import { h } from '../ui.js';

let cachedRules = null;

export async function mount(container) {
  const article = h('article', { class: 'guide-body' });
  container.appendChild(h('div', { class: 'page guide' }, article));

  const toc = h('nav', { class: 'toc', 'aria-label': 'Sommaire' });
  article.append(
    h('h1', null, 'Bienvenue dans TankoBlocs Réseau'),
    h('p', { class: 'lead' }, 'Tu ne pilotes pas ton tank : tu écris le ', h('strong', null, 'programme'), ' qui le pilote. Ensuite, il affronte seul les tanks des autres joueurs. Le gagnant est celui qui inflige le plus de dégâts.'),
    toc,

    h('h2', { id: 'g-reseau' }, '🌐 Jouer en réseau'),
    h('div', { class: 'steps' },
      step('1', 'Programme ton tank', ['Dans l\'', h('a', { href: '#/atelier' }, h('strong', null, '🛠️ Atelier')), ', emboîte des blocs dans les blocs orange « événements ». Chaque modification est enregistrée automatiquement sur le serveur : tu retrouves tes tanks d\'un cours à l\'autre, depuis n\'importe quel ordinateur.']),
      step('2', 'Entraîne-le', ['L\'', h('a', { href: '#/entrainement' }, h('strong', null, '🎯 Entraînement')), ' fait jouer ton tank contre les bots, directement dans ton navigateur. Tu peux mettre en pause, avancer tick par tick, accélérer, afficher les ordres, et lancer une ', h('strong', null, 'série rapide'), ' pour comparer deux versions.']),
      step('3', 'Affronte les autres', ['Dans le salon ', h('a', { href: '#/combats' }, h('strong', null, '⚔️ Combats')), ', crée un combat (durée, nombre d\'adversaires, joueurs ou bots) ou rejoins celui d\'un autre. Quand toutes les places sont prises, un décompte de quelques secondes démarre, puis le combat se joue en direct.']),
      step('4', 'Revois et améliore', ['Chaque combat terminé peut être ', h('strong', null, 'revu'), ' depuis l\'', h('a', { href: '#/historique' }, h('strong', null, '📜 Historique')), ', image par image. Tu peux même reprendre le programme exact que ton tank utilisait ce jour-là.'])),

    h('h3', null, 'Les règles des combats en réseau'),
    h('ul', null,
      h('li', null, 'Ton tank combat avec la ', h('b', null, 'dernière version enregistrée'), ' de son programme au moment du départ. Si tu le modifies pendant le combat, la nouvelle version servira au combat suivant.'),
      h('li', null, 'Le combat est calculé par le serveur : tu peux fermer la page, ton programme continue de se battre.'),
      h('li', null, 'Les programmes ne quittent jamais le serveur : personne ne peut copier le tien en regardant un combat.'),
      h('li', null, 'Le journal (« afficher », pannes) de ton tank n\'est visible que par toi. Les bulles « dire » sont vues par tout le monde !'),
      h('li', null, 'Un combat ', h('b', null, 'public'), ' 🌐 peut être regardé par tous ; un combat ', h('b', null, 'privé'), ' 🔒 seulement par ses participants. Dans les deux cas, n\'importe qui peut le rejoindre tant qu\'il reste des places.'),
      h('li', null, 'Un programme qui met trop longtemps à répondre arrête le combat (il n\'y a alors pas de résultat). Une boucle sans fin faite avec les blocs, elle, met seulement ton tank en panne.'),
      h('li', null, 'Le ', h('a', { href: '#/classement' }, 'classement'), ' ne compte que les combats contre au moins un autre joueur.')));

  try {
    if (!cachedRules) {
      const res = await fetch('/vendor/tankoblocs/guide.html');
      cachedRules = await res.text();
    }
    // contenu fixe fourni avec le serveur (pas de texte venant des joueurs)
    const rules = document.createElement('div');
    rules.innerHTML = cachedRules;
    article.appendChild(rules);
  } catch {
    article.appendChild(h('p', { class: 'error-text' }, 'Impossible de charger la suite du guide.'));
  }

  article.appendChild(h('h2', { id: 'g-credits' }, '🙏 Crédits'));
  article.appendChild(h('p', null, 'Les règles reprennent celles de TankoBlocs, elles-mêmes inspirées du projet open source ',
    h('a', { href: 'https://github.com/code-tanks/code-tanks', target: '_blank', rel: 'noopener' }, 'code-tanks'),
    ' (licence Apache 2.0). Les blocs sont faits avec ',
    h('a', { href: 'https://developers.google.com/blockly', target: '_blank', rel: 'noopener' }, 'Blockly'), ' (licence Apache 2.0).'));

  for (const h2 of article.querySelectorAll('h2[id]')) {
    toc.appendChild(h('a', { href: '#/guide', dataset: { target: h2.id } }, h2.textContent.replace(/^\S+\s/, '')));
  }
  toc.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-target]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(a.dataset.target).scrollIntoView({ behavior: 'smooth' });
  });
  // les liens internes du guide d'origine (#g-…) défilent dans la page au lieu de changer de vue
  article.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#g-"]');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  });
  return null;
}

function step(n, title, body) {
  return h('div', { class: 'step' }, h('b', null, n), h('div', null, h('strong', null, title), h('p', null, body)));
}
