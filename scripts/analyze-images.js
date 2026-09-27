/* eslint-disable no-console */
// Analyse les associations recette → image et affiche les suspects
const fs = require('fs');
const path = require('path');

const recipeNames = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '../prisma/data/../../../AppData/Local/Temp/recipe_names.json'))));
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '../prisma/data/images.json')));

const normalize = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const STOP = new Set(['avec', 'sans', 'pour', 'maison', 'facon', 'sauce', 'express', 'frais', 'fraiche',
  'poele', 'four', 'grille', 'rotie', 'roti', 'sautee', 'saute', 'epice', 'epices', 'farci', 'farcie',
  'curry', 'creme', 'soupe', 'tarte', 'gateau', 'cake', 'pain', 'fond', 'base', 'simple', 'rapide',
  'homemade', 'dish', 'food', 'meal', 'recette', 'wikipedia', 'file', 'image', 'photo', 'commons', 'thumbnail']);
const keywords = (s) => new Set(normalize(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)));

const bad = [];
for (const [name, val] of Object.entries(cache)) {
  if (!recipeNames.has(name)) continue;
  if (!val || !val.url) continue;
  const last = val.url.split('/').pop();
  const file = last.replace(/^\d+px-/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/%[0-9a-f]{2}/gi, ' ');
  const recipeKw = keywords(name);
  const fileKw = keywords(file);
  const shared = [...recipeKw].filter((w) => fileKw.has(w)).length;
  bad.push({ name, file: file.trim().substring(0, 80), shared, total: recipeKw.size, url: val.url });
}
bad.sort((a, b) => a.shared - b.shared || a.name.localeCompare(b.name));
const zero = bad.filter((b) => b.shared === 0);
console.log(`Current recipes with 0 matching keywords: ${zero.length}`);
zero.forEach((b) => console.log(`${b.name}  =>  ${b.file}`));
