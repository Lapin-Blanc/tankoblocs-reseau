import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupClass, Client } from './helpers.js';

let srv;
let cls;
before(async () => {
  srv = await startServer();
  cls = await setupClass(srv.base, ['Alice', 'Bruno', 'Chloé']);
});
after(() => srv.close());

test('le WebSocket exige une session et la même origine', async () => {
  const anon = new Client(srv.base);
  await assert.rejects(anon.socket(), /401/);
  const [alice] = cls.players;
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws', { headers: { Cookie: alice.cookie, Origin: 'http://pirate.example' } });
  await assert.rejects(new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
  }), /403/);
});

test('un combat complet entre deux joueurs et un bot, puis historique et replay', { timeout: 30000 }, async () => {
  const [alice, bruno, chloe] = cls.players;
  const a = await alice.socket();
  const b = await bruno.socket();
  const c = await chloe.socket();
  await a.wait('hello', 2000, true);

  a.send({ type: 'create', tankId: alice.tank.id, durationSec: 10, public: false, title: 'Duel test', opponents: [{ kind: 'player' }, { kind: 'bot', botId: 'sentinelle' }] });
  const created = await a.wait('created');
  const uid = created.uid;

  // Bruno voit le combat dans le salon et le rejoint
  await b.wait((m) => m.type === 'lobby' && m.matches.some((x) => x.uid === uid && x.status === 'waiting'), 2000, true);
  // Chloé ne peut pas regarder un combat privé
  c.send({ type: 'watch', uid });
  const refused = await c.wait('error');
  assert.match(refused.text, /privé/);
  // on ne peut pas s'inscrire avec le tank de quelqu'un d'autre
  c.send({ type: 'join', uid, tankId: alice.tank.id });
  assert.match((await c.wait('error')).text, /tanks/);

  b.send({ type: 'join', uid, tankId: bruno.tank.id });
  const cd = await b.wait('countdown');
  assert.equal(cd.uid, uid);
  // le combat est complet : Chloé ne peut plus entrer
  c.send({ type: 'join', uid, tankId: chloe.tank.id });
  assert.match((await c.wait('error')).text, /plus de joueurs|complet/);

  a.send({ type: 'watch', uid });
  b.send({ type: 'watch', uid });
  const start = await a.wait('start', 4000);
  assert.equal(start.header.tanks.length, 3);
  assert.ok(start.header.tanks.some((t) => t.pseudo === 'Alice'));
  assert.ok(start.header.tanks.some((t) => t.bot === 'sentinelle'));
  // aucun programme n'est envoyé aux navigateurs
  assert.ok(!JSON.stringify(start).includes('tank.quand'));

  const frame = await b.wait('frame', 3000);
  assert.equal(frame.d.t.length, 3);

  const end = await a.wait('end', 20000);
  assert.equal(end.results.ranking.length, 3);
  const frames = a.messages.filter((m) => m.type === 'frame').length;
  assert.ok(frames > 500, 'environ 60 images par seconde (' + frames + ')');

  // historique et classement
  const hist = (await alice.get('/api/matches')).data.matches;
  assert.equal(hist[0].uid, uid);
  assert.equal(hist[0].status, 'finished');
  assert.equal(hist[0].humans, 2);
  // Chloé n'y a pas accès (combat privé), l'enseignant oui
  assert.equal((await chloe.get('/api/matches/' + uid)).status, 403);
  assert.equal((await cls.prof.get('/api/matches/' + uid)).status, 200);

  // le replay recalculé donne exactement le même combat
  const rep = await bruno.get('/api/matches/' + uid + '/replay');
  assert.equal(rep.status, 200);
  assert.equal(rep.data.consistent, true);
  assert.equal(rep.data.frames.length, end.results.ticks + 1);
  // Bruno ne reçoit que ses propres journaux (et les messages publics)
  const brunoIdx = start.header.tanks.find((t) => t.pseudo === 'Bruno').index;
  assert.ok(rep.data.logs.every((l) => l.kind === 'info' || l.tank === brunoIdx || l.tank < 0));

  const lb = (await alice.get('/api/leaderboard')).data.rows;
  assert.equal(lb.find((r) => r.pseudo === 'Alice').pvpPlayed, 1);

  a.close(); b.close(); c.close();
});

test('quitter, annuler, remplir avec des bots, déconnexion pendant l\'attente', { timeout: 15000 }, async () => {
  const [alice, bruno] = cls.players;
  const a = await alice.socket();
  const b = await bruno.socket();
  a.send({ type: 'create', tankId: alice.tank.id, durationSec: 10, opponents: [{ kind: 'player' }, { kind: 'player' }] });
  const { uid } = await a.wait('created');

  // une seule inscription à la fois
  a.send({ type: 'create', tankId: alice.tank.id, durationSec: 10, opponents: [{ kind: 'player' }] });
  assert.match((await a.wait('error')).text, /déjà inscrit/);

  b.send({ type: 'join', uid, tankId: bruno.tank.id });
  await a.wait((m) => m.type === 'toast' && /rejoint/.test(m.text));
  b.send({ type: 'leave', uid });
  await a.wait((m) => m.type === 'toast' && /quitté/.test(m.text));

  // Bruno revient puis se déconnecte : sa place est libérée après le délai de grâce
  b.send({ type: 'join', uid, tankId: bruno.tank.id });
  await a.wait((m) => m.type === 'lobby' && m.matches.find((x) => x.uid === uid)?.slots[1].user?.pseudo === 'Bruno');
  b.close();
  await a.wait((m) => m.type === 'toast' && /déconnecté/.test(m.text), 3000);

  // seul le créateur peut remplir avec des bots
  const b2 = await bruno.socket();
  b2.send({ type: 'fillBots', uid });
  assert.match((await b2.wait('error')).text, /créateur/);
  a.send({ type: 'fillBots', uid });
  const filled = await a.wait((m) => m.type === 'lobby' && m.matches.find((x) => x.uid === uid)?.status === 'countdown');
  assert.ok(filled.matches.find((x) => x.uid === uid).slots.slice(1).every((s) => s.kind === 'bot'));

  // le créateur annule pendant le décompte
  a.send({ type: 'cancel', uid });
  await a.wait((m) => m.type === 'lobby' && !m.matches.some((x) => x.uid === uid));
  a.close(); b2.close();
});

test('l\'enseignant peut arrêter un combat en cours', { timeout: 15000 }, async () => {
  const [alice] = cls.players;
  const a = await alice.socket();
  const p = await cls.prof.socket();
  a.send({ type: 'create', tankId: alice.tank.id, durationSec: 30, public: true, opponents: [{ kind: 'bot', botId: 'chasseur' }] });
  const { uid } = await a.wait('created');
  p.send({ type: 'watch', uid });
  await p.wait('start', 4000);
  a.send({ type: 'cancel', uid });
  assert.match((await a.wait('error')).text, /enseignant/);
  p.send({ type: 'cancel', uid });
  const end = await p.wait('end', 3000);
  assert.equal(end.aborted, true);
  const d = (await cls.prof.get('/api/matches/' + uid)).data.match;
  assert.equal(d.status, 'aborted');
  a.close(); p.close();
});
