#!/usr/bin/env node
/*
 * Copie dans vendor/tankoblocs/ les fichiers partagés avec TankoBlocs :
 * moteur, exécution des programmes, blocs, tanks d'exemple, dessin de
 * l'arène, sons, et les parties du guide qui décrivent les règles.
 *
 * TankoBlocs reste la source unique de ces fichiers : on ne les modifie
 * jamais ici. Pour changer une règle, on la change dans TankoBlocs, puis :
 *
 *   npm run sync-tankoblocs -- ../tankoblocs
 *
 * Le commit d'origine est noté dans vendor/tankoblocs/VERSION.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'vendor', 'tankoblocs');

const JS_FILES = ['engine.js', 'runtime.js', 'blocks.js', 'bots.js', 'renderer.js', 'audio.js'];

/** Sections du guide reprises (de la première incluse à la dernière exclue). */
const GUIDE_FROM = 'g-arene';
const GUIDE_TO = 'g-clavier';

/** Règles CSS du guide reprises (sélecteurs qui commencent par…). */
const CSS_PREFIXES = ['.guide-body', '.toc', '.two-cols', '.diagram', '.d-', '.steps', '.step', '.blocks-ref', '.b ', '.b-', '.b{', '.lead'];

function findSource() {
  const arg = process.argv[2] || process.env.TANKOBLOCS_DIR;
  const candidates = arg ? [arg] : ['../tankoblocs', '../maze'];
  for (const c of candidates) {
    const dir = path.resolve(ROOT, c);
    if (fs.existsSync(path.join(dir, 'js', 'engine.js')) && fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  console.error('Dépôt TankoBlocs introuvable. Indiquez son chemin : npm run sync-tankoblocs -- <chemin>');
  process.exit(1);
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Extrait le HTML du guide entre deux titres <h2 id="…">. */
function extractGuide(html) {
  const start = html.indexOf('<h2 id="' + GUIDE_FROM + '"');
  const end = html.indexOf('<h2 id="' + GUIDE_TO + '"');
  if (start < 0 || end < 0 || end <= start) throw new Error('sections du guide introuvables dans index.html');
  return html.slice(start, end).replace(/\n {8}/g, '\n').trim() + '\n';
}

/** Garde les règles CSS de premier niveau dont tous les sélecteurs concernent le guide. */
function extractCss(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    // trouve l'accolade fermante correspondante
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open, j);
    if (!selector.startsWith('@')) {
      const parts = selector.split(',').map((s) => s.trim());
      const keep = parts.every((p) => CSS_PREFIXES.some((pre) => (p + ' ').startsWith(pre) || p === pre.trim()));
      if (keep) out.push(selector + ' ' + body.trim());
    }
    i = j;
  }
  return out.join('\n') + '\n';
}

function main() {
  const src = findSource();
  fs.mkdirSync(path.join(DEST, 'js'), { recursive: true });

  for (const f of JS_FILES) {
    fs.copyFileSync(path.join(src, 'js', f), path.join(DEST, 'js', f));
  }

  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(DEST, 'guide.html'), extractGuide(html));

  const css = fs.readFileSync(path.join(src, 'css', 'style.css'), 'utf8');
  fs.writeFileSync(path.join(DEST, 'guide.css'), extractCss(css));

  for (const f of ['LICENSE', 'NOTICE']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(DEST, f));
  }

  const status = git(src, ['status', '--porcelain', '--', 'js', 'index.html', 'css']);
  const version = {
    source: 'https://github.com/Lapin-Blanc/tankoblocs',
    commit: git(src, ['rev-parse', 'HEAD']),
    date: git(src, ['log', '-1', '--format=%cI']),
    modifiedLocally: !!status,
    files: JS_FILES.map((f) => 'js/' + f).concat(['guide.html', 'guide.css']),
  };
  fs.writeFileSync(path.join(DEST, 'VERSION.json'), JSON.stringify(version, null, 2) + '\n');

  console.log('Fichiers TankoBlocs copiés depuis ' + src);
  console.log('Commit : ' + (version.commit || 'inconnu') + (version.modifiedLocally ? ' (avec des modifications non enregistrées)' : ''));
}

main();
