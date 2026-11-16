import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTS, distinctify, compile } from '../server/tankoblocs.js';
import { runFast } from '../server/sim/runner.js';

const g = globalThis;

test('les six bots se compilent', () => {
  assert.equal(BOTS.length, 6);
  for (const b of BOTS) assert.match(b.code, /tank\.quand\(/);
});

test('un combat calculé dans un fil donne exactement le résultat du moteur', async () => {
  const specs = distinctify(BOTS.slice(2).map((b) => ({ name: b.name, color: b.color, code: b.code })));
  const ref = new g.TankEngine.Match({ entrants: g.TankRuntime.buildEntrants(specs, 777), seed: 777, maxTicks: 1800 });
  while (!ref.finished) { ref.step(); ref.fx.length = 0; }
  const r = await runFast({ entrants: specs, seed: 777, maxTicks: 1800 });
  assert.deepEqual(r.results, JSON.parse(JSON.stringify(ref.results)));
  assert.equal(r.frames.length, ref.tick + 1);
  const f = JSON.parse(r.frames[10]);
  assert.equal(f.k, 10);
  assert.equal(f.t.length, 4);
});

test('compilation : valeurs de menus piégées refusées, programme illisible signalé', () => {
  const evil = {
    blocks: { languageVersion: 0, blocks: [{
      type: 'ct_on_run', x: 0, y: 0,
      inputs: { DO: { block: { type: 'ct_turn', fields: { PART: 'tank', SIDE: '1); process.exit(1); (' },
        inputs: { TICKS: { shadow: { type: 'math_number', fields: { NUM: 5 } } } } } } },
    }] },
  };
  const c = compile(evil);
  assert.equal(c.error, null);
  assert.ok(!c.code.includes('process'));
  assert.ok(compile({ blocks: { blocks: [{ type: 'bloc_inexistant' }] } }).error);
  assert.ok(compile(null).error);
});

const dummy = () => ({ name: 'Cible', color: '#00ff00', code: BOTS[0].code });

test('bac à sable : ni process, ni require, ni objets du serveur', async () => {
  const code = "tank.quand('demarrage','tout',function(){ var f = (function(){}).constructor; tank.dire([typeof process, typeof require, f('return typeof process')(), typeof setTimeout].join('/')); });";
  const r = await runFast({ entrants: [{ name: 'A', color: '#ff0000', code }, dummy()], seed: 1, maxTicks: 10 });
  const said = r.logs.find((l) => l.kind === 'say');
  assert.equal(said.text, '💬 undefined/undefined/undefined/undefined');
});

test('bac à sable : un programme qui ne rend pas la main arrête le combat et est identifié', async () => {
  const code = "tank.quand('ordres','tout',function(){ for(;;){} });";
  await assert.rejects(
    runFast({ entrants: [dummy(), { name: 'Boucle', color: '#ff0000', code }], seed: 1, maxTicks: 60 }),
    (err) => err.reason === 'timeout' && err.culprit === 1,
  );
});

test('bac à sable : un programme qui dévore la mémoire arrête le combat', async () => {
  const code = "var a=[]; tank.quand('ordres','tout',function(){ for(var i=0;i<1e8;i++) a.push(new Array(1000).fill(i)); });";
  await assert.rejects(runFast({ entrants: [{ name: 'Glouton', color: '#ff0000', code }, dummy()], seed: 1, maxTicks: 60 }),
    (err) => err.reason === 'memory' || err.reason === 'timeout');
});

test('une boucle infinie faite avec les blocs met seulement le tank en panne', async () => {
  const ws = { blocks: { languageVersion: 0, blocks: [{
    type: 'ct_on_run', x: 0, y: 0,
    inputs: { DO: { block: { type: 'controls_whileUntil', fields: { MODE: 'WHILE' }, inputs: { BOOL: { block: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } } } } },
  }] } };
  const c = compile(ws);
  assert.match(c.code, /tank\.boucle\(\)/);
  const r = await runFast({ entrants: [{ name: 'Têtu', color: '#ff0000', code: c.code }, dummy()], seed: 1, maxTicks: 60 });
  const t = r.results.ranking.find((x) => x.name === 'Têtu');
  assert.equal(t.broken, true);
  assert.match(t.error, /boucle infinie/);
});
