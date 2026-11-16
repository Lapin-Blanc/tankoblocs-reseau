import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

test('premier lancement : création du compte enseignant, une seule fois', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.get('/api/status')).data.setupNeeded, true);
  const r = await c.post('/api/setup', { pseudo: 'Prof', password: 'secret123' });
  assert.equal(r.status, 201);
  assert.equal(r.data.me.role, 'teacher');
  assert.equal((await c.get('/api/status')).data.setupNeeded, false);
  const again = await new Client(srv.base).post('/api/setup', { pseudo: 'Pirate', password: 'secret123' });
  assert.equal(again.status, 409);
  srv.prof = c;
});

test('inscription avec le code du cours, connexion, déconnexion', async () => {
  const course = (await srv.prof.post('/api/admin/courses', { name: 'Programmation' })).data.course;
  assert.match(course.code, /^[A-Z]{4}-\d{4}$/);

  const c = new Client(srv.base);
  assert.equal((await c.post('/api/register', { pseudo: 'Zoé', password: 'motdepasse', code: 'FAUX-0000' })).status, 400);
  assert.equal((await c.post('/api/register', { pseudo: 'Z', password: 'motdepasse', code: course.code })).status, 400);
  assert.equal((await c.post('/api/register', { pseudo: 'Zoé', password: '123', code: course.code })).status, 400);
  const r = await c.post('/api/register', { pseudo: 'Zoé', password: 'motdepasse', code: course.code.toLowerCase() });
  assert.equal(r.status, 201);
  assert.equal(r.data.me.courseId, course.id);
  assert.equal((await new Client(srv.base).post('/api/register', { pseudo: 'zoé', password: 'motdepasse', code: course.code })).status, 409);

  assert.equal((await c.get('/api/me')).data.me.pseudo, 'Zoé');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).status, 401);

  assert.equal((await c.post('/api/login', { pseudo: 'zoé', password: 'mauvais' })).status, 401);
  assert.equal((await c.post('/api/login', { pseudo: 'ZOÉ', password: 'motdepasse' })).status, 200);
  srv.zoe = c;
});

test('les requêtes d\'une autre origine sont refusées', async () => {
  const res = await fetch(srv.base + '/api/tanks', {
    method: 'POST',
    headers: { Cookie: srv.zoe.cookie, Origin: 'http://pirate.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('tanks : créer, lire, modifier, supprimer (seulement les siens)', async () => {
  const c = srv.zoe;
  const t = (await c.post('/api/tanks', { name: '  Tornade  ', color: '#AABBCC' })).data.tank;
  assert.equal(t.name, 'Tornade');
  assert.equal(t.color, '#aabbcc');
  assert.ok(t.workspace.blocks, 'le modèle de départ est utilisé');

  const ws = { blocks: { languageVersion: 0, blocks: [{ type: 'ct_on_run', x: 10, y: 10 }] } };
  assert.equal((await c.put('/api/tanks/' + t.id, { workspace: ws, name: 'Tornade 2' })).status, 200);
  const back = (await c.get('/api/tanks/' + t.id)).data.tank;
  assert.deepEqual(back.workspace, ws);
  assert.equal(back.name, 'Tornade 2');

  assert.equal((await c.get('/api/tanks')).data.tanks.length, 1);
  // l'enseignant ne peut pas modifier le tank d'un joueur par cette route
  assert.equal((await srv.prof.put('/api/tanks/' + t.id, { name: 'X' })).status, 404);
  assert.equal((await c.put('/api/tanks/' + t.id, { name: '   ' })).status, 400);
  assert.equal((await c.del('/api/tanks/' + t.id)).status, 200);
  assert.equal((await c.get('/api/tanks/' + t.id)).status, 404);
});

test('administration : réservée à l\'enseignant ; mot de passe provisoire', async () => {
  assert.equal((await srv.zoe.get('/api/admin/users')).status, 403);
  const users = (await srv.prof.get('/api/admin/users')).data.users;
  const zoe = users.find((u) => u.pseudo === 'Zoé');
  assert.ok(zoe);
  const r = await srv.prof.post('/api/admin/users/' + zoe.id + '/password');
  assert.match(r.data.password, /^[a-z]{4}-[a-z]{4}-\d{2}$/);
  // l'ancienne session est fermée
  assert.equal((await srv.zoe.get('/api/me')).status, 401);
  const login = await srv.zoe.post('/api/login', { pseudo: 'Zoé', password: r.data.password });
  assert.equal(login.data.me.mustChangePassword, true);
  const ch = await srv.zoe.post('/api/me/password', { current: r.data.password, next: 'nouveau-mdp' });
  assert.equal(ch.data.me.mustChangePassword, false);

  // le dernier enseignant ne peut pas être rétrogradé
  const prof = users.find((u) => u.role === 'teacher');
  assert.equal((await srv.prof.put('/api/admin/users/' + prof.id, { role: 'player' })).status, 400);

  // compte désactivé : connexion refusée
  await srv.prof.put('/api/admin/users/' + zoe.id, { disabled: true });
  assert.equal((await new Client(srv.base).post('/api/login', { pseudo: 'Zoé', password: 'nouveau-mdp' })).status, 403);
  await srv.prof.put('/api/admin/users/' + zoe.id, { disabled: false });
});

test('réglages bornés et inscriptions fermées', async () => {
  const s = (await srv.prof.put('/api/admin/settings', { maxOpponents: 99, maxDurationSec: 5, registrationOpen: false })).data.settings;
  assert.equal(s.maxOpponents, 3);
  assert.equal(s.maxDurationSec, 10);
  const course = (await srv.prof.get('/api/admin/courses')).data.courses[0];
  const r = await new Client(srv.base).post('/api/register', { pseudo: 'Tard', password: 'motdepasse', code: course.code });
  assert.equal(r.status, 403);
  await srv.prof.put('/api/admin/settings', { registrationOpen: true, maxDurationSec: 300 });
});

test('fichiers statiques : page, Blockly, fichiers partagés ; rien d\'autre', async () => {
  for (const p of ['/', '/vendor/blockly/blockly_compressed.js', '/vendor/blockly/msg/fr.js', '/vendor/blockly/media/sprites.png', '/vendor/tankoblocs/js/engine.js', '/vendor/tankoblocs/guide.html']) {
    const res = await fetch(srv.base + p);
    assert.equal(res.status, 200, p);
  }
  for (const p of ['/vendor/blockly/package.json', '/vendor/blockly/../ws/index.js', '/vendor/tankoblocs/LICENSE', '/../server/index.js', '/%2e%2e/server/index.js']) {
    const res = await fetch(srv.base + p);
    assert.equal(res.status, 404, p);
  }
});
