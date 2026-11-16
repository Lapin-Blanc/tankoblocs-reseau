/*
 * Atelier : éditeur Blockly et bibliothèque des tanks du joueur.
 * Chaque modification est enregistrée automatiquement sur le serveur.
 *
 * #/atelier            mes tanks
 * #/atelier/12         ouvre le tank 12
 * #/atelier?voir=5     (enseignant) les tanks du joueur 5, en lecture seule
 */
import { h, fill, toast, confirmDialog, download, safeFileName, formatDate, levelBadge, dot } from '../ui.js';
import { api, GET, POST, DELETE } from '../net.js';
import { state, loadTanks, patchTank, setSelectedTank, selectedTankId, botWorkspace, on, isTeacher } from '../state.js';
import { go } from '../nav.js';

const FORMAT = 'tankoblocs-tank';

export async function mount(container, { args, query }) {
  const viewUser = isTeacher() && query.get('voir') ? Number(query.get('voir')) : null;
  return viewUser ? mountReadOnly(container, viewUser) : mountEditor(container, Number(args[0]) || null);
}

/* ================= Éditeur ================= */

async function mountEditor(container, wantedId) {
  const B = window.TankBlocks;
  const PALETTE = window.TankRuntime.PALETTE;

  if (!state.tanks.length) {
    // tout premier passage : un tank prêt à modifier
    const r = await POST('/api/tanks', { name: 'Mon tank', color: PALETTE[Math.floor(Math.random() * 8)] });
    await loadTanks();
    setSelectedTank(r.tank.id);
  }

  let current = null; // tank ouvert { id, name, color, workspace }
  let dirty = false;
  let saving = null;
  let saveTimer = null;
  let loading = false;
  let codeTimer = null;

  /* ----- Structure ----- */
  const list = h('ul', { class: 'tank-list' });
  const countInfo = h('span', { class: 'muted small' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true });
  const libCard = h('section', { class: 'card' },
    h('div', { class: 'card-title' }, h('h3', null, 'Mes tanks'), countInfo),
    list,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => createTank() }, '＋ Nouveau'),
      h('button', { class: 'btn small', type: 'button', onclick: () => duplicate() }, '⧉ Dupliquer'),
      h('button', { class: 'btn small', type: 'button', onclick: () => fileInput.click() }, '⬆ Importer'),
      h('button', { class: 'btn small', type: 'button', onclick: () => exportTank() }, '⬇ Exporter')),
    fileInput);

  const examples = h('ul', { class: 'tank-list examples' });
  const exCard = h('details', { class: 'card' },
    h('summary', null, '🧪 Exemples à étudier'),
    h('p', { class: 'hint' }, 'Les bots sont faits avec les mêmes blocs que toi. Copie-en un dans tes tanks pour voir comment il fonctionne.'),
    examples);

  const side = h('aside', { class: 'side' }, libCard, exCard);

  const nameInput = h('input', { type: 'text', class: 'tank-name', maxlength: 40, 'aria-label': 'Nom du tank' });
  const colorBtn = h('button', { class: 'color-btn', type: 'button', title: 'Couleur du tank', 'aria-haspopup': 'true' });
  const swatches = h('div', { class: 'swatch-pop', hidden: true });
  const saveState = h('span', { class: 'save-state' });
  const combatBtn = h('button', { class: 'btn', type: 'button', title: 'Choisir ce tank pour les combats', onclick: () => useForCombat() }, '⚔️ Pour les combats');
  const codeBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: () => toggleCode() }, '</> Code');
  const toolbar = h('div', { class: 'editor-bar' },
    h('div', { class: 'color-wrap' }, colorBtn, swatches),
    nameInput,
    saveState,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/entrainement/' + current.id) }, '🎯 Tester'),
    combatBtn,
    codeBtn);
  const blocklyDiv = h('div', { class: 'blockly-area' });
  const warn = h('div', { class: 'editor-warn', hidden: true });
  const codePre = h('pre', { class: 'code' });
  const codePanel = h('aside', { class: 'code-panel', hidden: true }, h('h3', null, 'JavaScript généré'), h('p', { class: 'hint' }, 'Ce que tes blocs deviennent. Pas besoin de le comprendre pour jouer !'), codePre);
  const editor = h('div', { class: 'editor' }, toolbar, h('div', { class: 'editor-body' }, h('div', { class: 'editor-wrap' }, blocklyDiv, warn), codePanel));

  container.appendChild(h('div', { class: 'atelier' }, side, editor));

  /* ----- Blockly ----- */
  const ws = window.Blockly.inject(blocklyDiv, {
    toolbox: B.toolbox,
    theme: B.theme,
    renderer: 'zelos',
    media: '/vendor/blockly/media/',
    grid: { spacing: 24, length: 3, colour: '#25313a', snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.8, maxScale: 1.6, minScale: 0.35, scaleSpeed: 1.12 },
    move: { scrollbars: true, drag: true, wheel: false },
    trashcan: true,
    sounds: true,
    oneBasedIndex: true,
  });
  ws.addChangeListener(window.Blockly.Events.disableOrphans);
  ws.addChangeListener((e) => {
    if (loading || e.isUiEvent) return;
    markDirty();
    scheduleCode();
  });
  const ro = new ResizeObserver(() => window.Blockly.svgResize(ws));
  ro.observe(blocklyDiv);

  /* ----- Enregistrement ----- */
  function setSave(kind, text) {
    saveState.className = 'save-state ' + kind;
    saveState.textContent = text;
  }

  function markDirty() {
    if (!current) return;
    dirty = true;
    setSave('pending', '● Modifié');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), 1200);
  }

  async function save({ keepalive = false } = {}) {
    clearTimeout(saveTimer);
    if (saving) await saving;
    if (!dirty || !current) return;
    const id = current.id;
    const payload = { name: nameInput.value.trim() || 'Sans nom', color: current.color, workspace: window.Blockly.serialization.workspaces.save(ws) };
    dirty = false;
    setSave('saving', 'Enregistrement…');
    saving = (async () => {
      try {
        const r = await api('PUT', '/api/tanks/' + id, payload, { keepalive });
        if (current && current.id === id) {
          current.name = r.tank.name;
          setSave('ok', '✓ Enregistré');
        }
        patchTank(r.tank);
      } catch (err) {
        dirty = true;
        setSave('error', '⚠ Non enregistré');
        toast('Enregistrement impossible : ' + err.message, 'error');
      } finally {
        saving = null;
      }
    })();
    await saving;
  }

  const onPageHide = () => { if (dirty) save({ keepalive: true }); };
  window.addEventListener('pagehide', onPageHide);
  const offBefore = on('beforeMatch', () => save());

  /* ----- Code généré ----- */
  function scheduleCode() {
    if (codePanel.hidden) return;
    clearTimeout(codeTimer);
    codeTimer = setTimeout(updateCode, 300);
  }

  function updateCode() {
    try {
      codePre.textContent = B.compileWorkspace(ws, false) || '// (aucun bloc événement)';
    } catch (err) {
      codePre.textContent = '// erreur : ' + err.message;
    }
  }

  function toggleCode() {
    codePanel.hidden = !codePanel.hidden;
    codeBtn.setAttribute('aria-pressed', String(!codePanel.hidden));
    if (!codePanel.hidden) updateCode();
    setTimeout(() => window.Blockly.svgResize(ws), 0);
  }

  function checkHats() {
    const hats = ws.getTopBlocks(false).filter((b) => B.HAT_TYPES.includes(b.type) && b.isEnabled());
    if (!hats.length) {
      warn.hidden = false;
      warn.textContent = '💡 Ton programme n\'a aucun bloc orange « événement » (au démarrage, quand je n\'ai plus d\'ordres…) : ton tank ne fera rien.';
    } else {
      warn.hidden = true;
    }
  }
  ws.addChangeListener((e) => { if (!e.isUiEvent) checkHats(); });

  /* ----- Tanks ----- */
  async function open(id) {
    if (current && current.id === id) return;
    await save();
    let t;
    try {
      t = (await GET('/api/tanks/' + id)).tank;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    current = t;
    loading = true;
    window.Blockly.Events.disable();
    try {
      ws.clear();
      window.Blockly.serialization.workspaces.load(t.workspace || {}, ws);
    } catch (err) {
      toast('Ce programme est abîmé : ' + err.message, 'error');
    } finally {
      window.Blockly.Events.enable();
      loading = false;
    }
    tidyIfOverlapping();
    ws.clearUndo();
    ws.scrollCenter();
    nameInput.value = t.name;
    setColor(t.color, false);
    setSave('ok', '✓ Enregistré');
    dirty = false;
    checkHats();
    if (!codePanel.hidden) updateCode();
    history.replaceState(null, '', '#/atelier/' + t.id);
    renderList();
  }

  /** Les modèles et les exemples arrivent empilés : on les range (sans toucher à une disposition choisie). */
  function tidyIfOverlapping() {
    const boxes = ws.getTopBlocks(false).map((b) => b.getBoundingRectangle());
    const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i
      && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    if (!overlap) return;
    loading = true;
    window.Blockly.Events.disable();
    try { ws.cleanUp(); } finally {
      window.Blockly.Events.enable();
      loading = false;
    }
  }

  function setColor(c, user) {
    if (!current) return;
    current.color = c;
    colorBtn.style.background = c;
    for (const s of swatches.children) s.setAttribute('aria-checked', String(s.dataset.color === c));
    if (user) markDirty();
  }

  for (const c of PALETTE) {
    swatches.appendChild(h('button', {
      class: 'swatch', type: 'button', role: 'radio', 'aria-label': 'Couleur ' + c, dataset: { color: c }, style: { background: c },
      onclick: () => { setColor(c, true); swatches.hidden = true; },
    }));
  }
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    swatches.hidden = !swatches.hidden;
  });
  const closeSwatches = () => { swatches.hidden = true; };
  document.addEventListener('click', closeSwatches);

  nameInput.addEventListener('input', () => markDirty());
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  function renderList() {
    const combatId = selectedTankId();
    countInfo.textContent = state.tanks.length + ' / ' + state.maxTanks;
    fill(list, state.tanks.map((t) => {
      const isCurrent = current && current.id === t.id;
      return h('li', { class: 'mine' + (isCurrent ? ' current' : ''), onclick: () => open(t.id) },
        dot(t.color),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, t.name, t.id === combatId ? h('span', { class: 'badge combat', title: 'Tank utilisé pour les combats' }, '⚔️') : null),
          h('div', { class: 'meta' }, 'modifié ' + formatDate(t.updatedAt))),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn small danger', type: 'button', title: 'Supprimer', 'aria-label': 'Supprimer ' + t.name,
            onclick: (e) => { e.stopPropagation(); remove(t); },
          }, '🗑')));
    }));
    combatBtn.disabled = !current || current.id === combatId;
    combatBtn.textContent = current && current.id === combatId ? '⚔️ Tank de combat' : '⚔️ Pour les combats';
  }
  const offTanks = on('tanks', renderList);
  const offSel = on('selectedTank', renderList);

  async function createTank(data = {}) {
    await save();
    try {
      const r = await POST('/api/tanks', {
        name: data.name || 'Nouveau tank',
        color: data.color || PALETTE[state.tanks.length % PALETTE.length],
        workspace: data.workspace,
      });
      await loadTanks();
      await open(r.tank.id);
      return r.tank;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  async function duplicate() {
    if (!current) return;
    await save();
    await createTank({ name: (current.name + ' (copie)').slice(0, 40), color: current.color, workspace: window.Blockly.serialization.workspaces.save(ws) });
  }

  async function remove(t) {
    if (!(await confirmDialog('Supprimer « ' + t.name + ' » ?', 'Le tank et son programme seront supprimés. Les combats déjà joués restent dans l\'historique.', { ok: 'Supprimer', danger: true }))) return;
    try {
      await DELETE('/api/tanks/' + t.id);
      if (current && current.id === t.id) {
        current = null;
        dirty = false;
      }
      await loadTanks();
      if (!state.tanks.length) await createTank({ name: 'Mon tank' });
      else if (!current) await open(state.tanks[0].id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function exportTank() {
    if (!current) return;
    download(safeFileName(nameInput.value || 'tank') + '.tank.json', {
      format: FORMAT,
      version: 1,
      name: nameInput.value,
      color: current.color,
      workspace: window.Blockly.serialization.workspaces.save(ws),
      exported: new Date().toISOString(),
    });
  }

  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        const workspace = data && data.format === FORMAT ? data.workspace : (data && data.blocks ? data : null);
        if (!workspace || typeof workspace !== 'object') throw new Error('ce fichier ne contient pas de tank TankoBlocs');
        const name = String(data.name || f.name.replace(/\.(tank\.)?json$/i, '') || 'Tank importé').slice(0, 40);
        const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : undefined;
        if (await createTank({ name, color, workspace })) toast('« ' + name + ' » importé.', 'ok');
      } catch (err) {
        toast(f.name + ' : ' + (err.message || 'fichier illisible'), 'error');
      }
    }
  });

  function useForCombat() {
    if (!current) return;
    setSelectedTank(current.id);
    toast('« ' + current.name + ' » sera utilisé pour tes prochains combats.', 'ok');
  }

  /* ----- Exemples ----- */
  fill(examples, state.bots.map((b) => h('li', null,
    dot(b.color),
    h('div', { class: 'info' },
      h('div', { class: 'name' }, b.name, levelBadge(b.level)),
      h('div', { class: 'desc' }, b.description)),
    h('div', { class: 'actions' },
      h('button', {
        class: 'btn small', type: 'button', title: 'Copier dans mes tanks',
        onclick: async () => {
          const t = await createTank({ name: 'Copie de ' + b.name, color: b.color, workspace: botWorkspace(b.id) });
          if (t) toast('Une copie du ' + b.name + ' est dans tes tanks : à toi de l\'améliorer !', 'ok');
        },
      }, 'Copier')))));

  /* ----- Ouverture ----- */
  const first = state.tanks.find((t) => t.id === wantedId) || state.tanks.find((t) => t.id === selectedTankId()) || state.tanks[0];
  await open(first.id);
  window.Blockly.svgResize(ws);

  return {
    flush: () => save(),
    async unmount() {
      await save();
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('click', closeSwatches);
      offTanks();
      offSel();
      offBefore();
      ro.disconnect();
      clearTimeout(codeTimer);
      ws.dispose();
    },
  };
}

/* ================= Lecture seule (enseignant) ================= */

async function mountReadOnly(container, userId) {
  const B = window.TankBlocks;
  const data = await GET('/api/admin/users/' + userId + '/tanks');
  const list = h('ul', { class: 'tank-list' });
  const blocklyDiv = h('div', { class: 'blockly-area' });
  const title = h('h2', { class: 'editor-title' });
  const copyBtn = h('button', { class: 'btn', type: 'button' }, '⧉ Copier dans mes tanks');
  container.appendChild(h('div', { class: 'atelier' },
    h('aside', { class: 'side' },
      h('section', { class: 'card' },
        h('h3', null, 'Tanks de ' + data.pseudo),
        h('p', { class: 'hint' }, 'Lecture seule : tu vois le programme tel que le joueur l\'a enregistré.'),
        list,
        h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/admin/joueurs' }, '← Retour aux joueurs')))),
    h('div', { class: 'editor' },
      h('div', { class: 'editor-bar' }, title, h('span', { class: 'grow' }), copyBtn),
      h('div', { class: 'editor-body' }, h('div', { class: 'editor-wrap' }, blocklyDiv)))));

  const ws = window.Blockly.inject(blocklyDiv, {
    readOnly: true, theme: B.theme, renderer: 'zelos', media: '/vendor/blockly/media/',
    zoom: { controls: true, wheel: true, startScale: 0.8 }, move: { scrollbars: true, drag: true, wheel: false },
  });
  const ro = new ResizeObserver(() => window.Blockly.svgResize(ws));
  ro.observe(blocklyDiv);
  let shown = null;

  function show(t) {
    shown = t;
    ws.clear();
    try { window.Blockly.serialization.workspaces.load(t.workspace || {}, ws); } catch (err) { toast(err.message, 'error'); }
    ws.scrollCenter();
    fill(title, dot(t.color), ' ', t.name, h('span', { class: 'muted small' }, ' — modifié ' + formatDate(t.updatedAt)));
    for (const li of list.children) li.classList.toggle('current', li.dataset.id === String(t.id));
  }

  copyBtn.addEventListener('click', async () => {
    if (!shown) return;
    try {
      await POST('/api/tanks', { name: (shown.name + ' (' + data.pseudo + ')').slice(0, 40), color: shown.color, workspace: shown.workspace });
      await loadTanks();
      toast('Copie ajoutée à tes tanks.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  if (!data.tanks.length) {
    fill(list, h('li', { class: 'empty' }, 'Aucun tank pour le moment.'));
    copyBtn.disabled = true;
  } else {
    fill(list, data.tanks.map((t) => h('li', { class: 'mine', dataset: { id: t.id }, onclick: () => show(t) },
      dot(t.color), h('div', { class: 'info' }, h('div', { class: 'name' }, t.name), h('div', { class: 'meta' }, formatDate(t.updatedAt))))));
    show(data.tanks[0]);
  }

  return {
    unmount() {
      ro.disconnect();
      ws.dispose();
    },
  };
}
