/* eslint-disable no-console */
// Résolution de photos réalistes via l'API Wikipédia (images libres Wikimedia Commons).
// Stratégie : titre exact sur fr.wikipedia → recherche fr → recherche en. Résultats mis en cache
// dans prisma/data/images.json pour ne jamais refaire les mêmes requêtes.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { normalizeText } = require('./text');

const CACHE_FILE = path.join(__dirname, '..', 'prisma', 'data', 'images.json');
const THUMB_SIZE = 800;
const BATCH = 50;
const http = axios.create({
  timeout: 12000,
  headers: { 'User-Agent': 'CulinaRPG/1.0 (recipe images; https://github.com/courribetvictor/CULINARPG)' },
});

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  const sorted = Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]]));
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

// Retire les paramètres de suivi ajoutés par l'API aux URL de vignettes
const cleanUrl = (u) => String(u).split('?')[0];

async function wikiQuery(lang, params) {
  const { data } = await http.get(`https://${lang}.wikipedia.org/w/api.php`, {
    params: {
      action: 'query', format: 'json', formatversion: 2, redirects: 1,
      prop: 'pageimages', piprop: 'thumbnail', pithumbsize: THUMB_SIZE, ...params,
    },
  });
  return data.query || {};
}

const pageUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

// Recherche par titres exacts, par lots de 50. Renvoie { titreDemandé: { url, source } }.
async function byTitles(lang, titles) {
  const found = {};
  for (let i = 0; i < titles.length; i += BATCH) {
    const chunk = titles.slice(i, i + BATCH);
    const q = await wikiQuery(lang, { titles: chunk.join('|') });
    const alias = {};
    for (const n of q.normalized || []) alias[n.from] = n.to;
    for (const r of q.redirects || []) alias[r.from] = r.to;
    const pages = Object.fromEntries((q.pages || []).map((p) => [p.title, p]));
    for (const t of chunk) {
      let cur = t;
      for (let hop = 0; hop < 3 && alias[cur]; hop++) cur = alias[cur];
      const p = pages[cur];
      if (p?.thumbnail?.source) found[t] = { url: cleanUrl(p.thumbnail.source), source: pageUrl(lang, p.title) };
    }
  }
  return found;
}

// Mots significatifs (≥ 4 lettres, sans accents) pour vérifier qu'un résultat de recherche est pertinent
const STOP = new Set(['avec', 'sans', 'pour', 'maison', 'facon', 'sauce', 'express']);
const keywords = (s) => new Set(normalizeText(s).split(/[^a-z]+/)
  .filter((w) => w.length >= 4 && !STOP.has(w))
  .map((w) => w.replace(/s$/, '')));

async function bySearch(lang, text) {
  const q = await wikiQuery(lang, { generator: 'search', gsrsearch: text, gsrlimit: 5, gsrnamespace: 0 });
  const wanted = keywords(text);
  const pages = (q.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0));
  // On n'accepte qu'un article dont le titre partage au moins un mot avec la recette
  const p = pages.find((pg) => pg.thumbnail?.source && [...keywords(pg.title)].some((w) => wanted.has(w)));
  return p ? { url: cleanUrl(p.thumbnail.source), source: pageUrl(lang, p.title) } : null;
}

// « en:Titre » → { lang: 'en', title: 'Titre' }
const splitTitle = (t) => (t.startsWith('en:') ? { lang: 'en', title: t.slice(3) } : { lang: 'fr', title: t });

/**
 * Résout les images des recettes non encore vérifiées (imageChecked = false).
 * Best-effort : en cas d'erreur réseau, s'arrête et laisse les recettes pour un prochain essai.
 */
async function resolveRecipeImages(prisma, { log = console.log } = {}) {
  const pending = await prisma.recipe.findMany({
    where: { imageChecked: false },
    select: { id: true, name: true, wikiTitle: true },
  });
  if (!pending.length) return { resolved: 0, missing: 0, pending: 0 };

  const cache = loadCache();
  let resolved = 0; let missing = 0;

  const apply = async (recipe, hit) => {
    cache[recipe.name] = hit || null;
    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { imageUrl: hit?.url ?? null, imageSource: hit?.source ?? null, imageChecked: true },
    });
    if (hit) resolved++; else missing++;
  };

  try {
    const todo = [];
    for (const r of pending) {
      if (Object.prototype.hasOwnProperty.call(cache, r.name)) await apply(r, cache[r.name]);
      else todo.push(r);
    }
    if (todo.length) {
      log(`  🖼️  Recherche de photos pour ${todo.length} recettes sur Wikipédia…`);
      const exact = {};
      for (const lang of ['fr', 'en']) {
        const titles = [...new Set(todo.map((r) => splitTitle(r.wikiTitle || r.name)).filter((t) => t.lang === lang).map((t) => t.title))];
        const found = await byTitles(lang, titles);
        for (const [t, hit] of Object.entries(found)) exact[`${lang}:${t}`] = hit;
      }
      const rest = [];
      for (const r of todo) {
        const t = splitTitle(r.wikiTitle || r.name);
        const hit = exact[`${t.lang}:${t.title}`];
        if (hit) await apply(r, hit); else rest.push(r);
      }
      for (const r of rest) {
        const hit = (await bySearch('fr', r.name)) || (await bySearch('en', r.name));
        await apply(r, hit);
      }
    }
  } catch (err) {
    log(`  ⚠️  Wikipédia injoignable (${err.code || err.message}) — photos à compléter plus tard (npm run images).`);
  } finally {
    saveCache(cache);
  }
  const left = await prisma.recipe.count({ where: { imageChecked: false } });
  log(`  🖼️  Photos : ${resolved} trouvées, ${missing} sans photo, ${left} en attente.`);
  return { resolved, missing, pending: left };
}

module.exports = { resolveRecipeImages, loadCache };

// Exécution directe : `npm run images` (option --retry pour re-tenter les recettes sans photo)
if (require.main === module) {
  require('dotenv').config();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  (async () => {
    if (process.argv.includes('--retry')) {
      const cache = loadCache();
      for (const [k, v] of Object.entries(cache)) if (v === null) delete cache[k];
      saveCache(cache);
      await prisma.recipe.updateMany({ where: { imageUrl: null }, data: { imageChecked: false } });
    }
    await resolveRecipeImages(prisma);
  })().finally(() => prisma.$disconnect());
}
