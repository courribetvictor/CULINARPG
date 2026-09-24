/* eslint-disable no-console */
// CulinaRPG — seed : 500 recettes de base + photos Wikipédia + dailies (+ TheMealDB / compte démo en option).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { SKILLS, computeRewards } = require('../lib/game');
const { resolveRecipeImages, loadCache } = require('../lib/images');
const { hashPassword } = require('../lib/auth');
const { normalizeText } = require('../lib/text');

const prisma = new PrismaClient();
const DATA_DIR = path.join(__dirname, 'data', 'recipes');
const IMAGE_TITLES = require('./data/image-titles');
const truthy = (v) => /^(1|true|yes)$/i.test(v || '');

const slugify = (s) => s.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const DESCRIPTIONS = {
  'Petit-déjeuner': 'Une quête matinale pour bien démarrer la journée.',
  Entrées: 'Une entrée classique pour affûter ton couteau et ton palais.',
  Soupes: 'Une soupe réconfortante : patience et précision.',
  Œufs: 'Maîtrise l\'œuf, la base de toute cuisine.',
  'Pâtes & Riz': 'Un grand classique des féculents à dompter.',
  Viandes: 'Une épreuve de feu et de cuisson maîtrisée.',
  Volailles: 'Une volaille à sublimer, entre saisie et mijotage.',
  Poissons: 'Délicatesse et précision : la mer comme terrain de jeu.',
  Végétarien: 'Les légumes à l\'honneur, sans compromis sur le goût.',
  Accompagnements: 'L\'accompagnement parfait, celui qui fait la différence.',
  Sauces: 'Une base indispensable du répertoire.',
  Boulangerie: 'Pâte, levée et four : l\'art du boulanger.',
  Desserts: 'Une épreuve sucrée pour les pâtissiers en herbe.',
  'Street food': 'Rapide, gourmand et redoutablement efficace.',
};

// ---------------------------------------------------------------------------
// Catalogue des 500 recettes de base
// ---------------------------------------------------------------------------
function loadBaseRecipes() {
  const recipes = [];
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.js')).sort()) {
    const { category, recipes: list } = require(path.join(DATA_DIR, file));
    for (const [name, emoji, timeMinutes, ingredientsStr, stepsStr, wikiTitle] of list) {
      const ingredients = ingredientsStr.split(';').map((s) => {
        const [n, measure] = s.split('=');
        return { name: n.trim(), measure: (measure || '').trim() };
      });
      const steps = stepsStr.split('|').map((s) => s.trim()).filter(Boolean);
      const instructions = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const { difficulty, skillRewards, totalXp } = computeRewards({
        instructions, ingredientsCount: ingredients.length, timeMinutes, category,
      });
      recipes.push({
        externalId: `base-${slugify(name)}`,
        source: 'base',
        name,
        description: DESCRIPTIONS[category] || 'Une recette de base à maîtriser.',
        category,
        area: null,
        searchText: normalizeText([name, category, ...ingredients.map((g) => g.name)].join(' ')),
        wikiTitle: IMAGE_TITLES[name] || wikiTitle || name,
        emoji,
        timeMinutes,
        difficulty,
        ingredients: JSON.stringify(ingredients),
        instructions,
        skillRewards: JSON.stringify(skillRewards),
        totalXp,
      });
    }
  }
  return recipes;
}

// ---------------------------------------------------------------------------
// Import TheMealDB (optionnel : MEALDB_IMPORT=true)
// ---------------------------------------------------------------------------
const MEALDB_URL = 'https://www.themealdb.com/api/json/v1/1/search.php';
const MEALDB_LETTERS = (process.env.MEALDB_LETTERS || 'abcdefghiklmnprst').split('');
const CATEGORY_EMOJI = {
  Beef: '🥩', Chicken: '🍗', Dessert: '🍰', Lamb: '🍖', Miscellaneous: '🍲', Pasta: '🍝', Pork: '🥓',
  Seafood: '🦐', Side: '🥗', Starter: '🥟', Vegan: '🥦', Vegetarian: '🥕', Breakfast: '🍳', Goat: '🐐',
};

function mealToRecipe(meal) {
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const name = (meal[`strIngredient${i}`] || '').trim();
    if (name) ingredients.push({ name, measure: (meal[`strMeasure${i}`] || '').trim() });
  }
  const instructions = (meal.strInstructions || '').trim();
  const steps = instructions.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const timeMinutes = Math.min(180, Math.max(15, Math.round((ingredients.length * 3 + steps * 4) / 5) * 5));
  const { difficulty, skillRewards, totalXp } = computeRewards({
    instructions, ingredientsCount: ingredients.length, timeMinutes, category: meal.strCategory,
  });
  return {
    externalId: `mealdb-${meal.idMeal}`,
    source: 'themealdb',
    name: meal.strMeal,
    description: `${meal.strArea || 'World'} · ${meal.strCategory || 'Cuisine'} — recette importée de TheMealDB.`,
    category: meal.strCategory || 'Miscellaneous',
    area: meal.strArea || null,
    searchText: normalizeText([meal.strMeal, meal.strCategory, meal.strArea, ...ingredients.map((g) => g.name)].join(' ')),
    imageUrl: meal.strMealThumb || null,
    imageSource: 'https://www.themealdb.com',
    imageChecked: true,
    emoji: CATEGORY_EMOJI[meal.strCategory] || '🍽️',
    timeMinutes,
    difficulty,
    ingredients: JSON.stringify(ingredients),
    instructions,
    skillRewards: JSON.stringify(skillRewards),
    totalXp,
  };
}

async function fetchMealDb() {
  const recipes = [];
  for (const letter of MEALDB_LETTERS) {
    try {
      const { data } = await axios.get(MEALDB_URL, { params: { f: letter }, timeout: 8000 });
      const meals = data?.meals || [];
      recipes.push(...meals.map(mealToRecipe));
      console.log(`  🌐 TheMealDB [${letter}] → ${meals.length} recettes`);
    } catch (err) {
      console.warn(`  ⚠️  TheMealDB [${letter}] indisponible (${err.code || err.message}).`);
      if (recipes.length === 0) break;
    }
  }
  return recipes;
}

// ---------------------------------------------------------------------------
// Dailies
// ---------------------------------------------------------------------------
const DAILIES = [
  { slug: 'knife-drill', title: 'Entraînement au couteau', description: 'Émince un oignon en brunoise parfaite.', icon: 'slice', skill: 'knife', xpReward: 25 },
  { slug: 'sear-master', title: 'Maître de la saisie', description: 'Saisis une protéine à feu vif sans la brûler.', icon: 'flame', skill: 'fire', xpReward: 30 },
  { slug: 'taste-test', title: 'Test du palais', description: 'Goûte et rectifie l\'assaisonnement d\'un plat 3 fois.', icon: 'sparkles', skill: 'seasoning', xpReward: 20 },
  { slug: 'mise-en-place', title: 'Mise en place', description: 'Prépare tous tes ingrédients avant d\'allumer le feu.', icon: 'timer', skill: 'prep', xpReward: 20 },
  { slug: 'dough-work', title: 'Travail de la pâte', description: 'Pétris une pâte 10 minutes (pain, pizza, brioche…).', icon: 'croissant', skill: 'baking', xpReward: 35 },
  { slug: 'clean-station', title: 'Plan de travail impeccable', description: 'Nettoie ton poste en cuisinant, pas après.', icon: 'sparkle', skill: 'prep', xpReward: 15 },
  { slug: 'spice-discovery', title: 'Découverte d\'épice', description: 'Utilise une épice que tu n\'as jamais essayée.', icon: 'flask-conical', skill: 'seasoning', xpReward: 25 },
];

async function main() {
  console.log('🍳 CulinaRPG — seed en cours…\n');

  for (const d of DAILIES) {
    await prisma.dailyTask.upsert({ where: { slug: d.slug }, update: d, create: d });
  }
  console.log(`⚡ ${DAILIES.length} tâches quotidiennes`);

  // Ancien catalogue procédural (v1) : remplacé par les recettes de base
  const removed = await prisma.recipe.deleteMany({ where: { source: 'generated' } });
  if (removed.count) console.log(`🧹 ${removed.count} anciennes recettes procédurales retirées`);

  const base = loadBaseRecipes();
  const imported = truthy(process.env.MEALDB_IMPORT) ? await fetchMealDb() : [];
  const all = [...base, ...imported];

  // Compétence principale (la plus récompensée) : sert au filtre par compétence
  for (const r of all) {
    r.mainSkill = Object.entries(JSON.parse(r.skillRewards)).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Les photos déjà trouvées (cache) sont appliquées directement ; les autres restent à résoudre
  const cache = loadCache();
  const upserts = all.map((r) => {
    const hasCache = r.source === 'base' && Object.prototype.hasOwnProperty.call(cache, r.name);
    let img = {};
    if (hasCache) img = { imageUrl: cache[r.name]?.url ?? null, imageSource: cache[r.name]?.source ?? null, imageChecked: true };
    else if (r.source === 'base') img = { imageUrl: null, imageSource: null, imageChecked: false };
    return { where: { externalId: r.externalId }, update: { ...r, ...img }, create: { ...r, ...img } };
  });
  // Par lots de 50 : rapide et sans transaction géante sur une base distante (Neon)
  for (let i = 0; i < upserts.length; i += 50) {
    await prisma.$transaction(upserts.slice(i, i + 50).map((u) => prisma.recipe.upsert(u)));
  }
  console.log(`📖 ${base.length} recettes de base${imported.length ? ` + ${imported.length} TheMealDB` : ''}`);

  await resolveRecipeImages(prisma);

  // Compte de démonstration (optionnel : SEED_DEMO_USER=true)
  if (truthy(process.env.SEED_DEMO_USER)) {
    const user = await prisma.user.upsert({
      where: { email: 'demo@culinarpg.app' },
      update: {},
      create: {
        email: 'demo@culinarpg.app', username: 'demo', displayName: 'Chef Démo',
        passwordHash: await hashPassword('demo1234'), onboarded: true, chefClass: 'fire',
      },
    });
    for (const skill of SKILLS) {
      await prisma.userSkill.upsert({
        where: { userId_skill: { userId: user.id, skill } }, update: {}, create: { userId: user.id, skill },
      });
    }
    console.log('👤 Compte démo : demo@culinarpg.app / demo1234');
  }

  const count = await prisma.recipe.count();
  const withImg = await prisma.recipe.count({ where: { imageUrl: { not: null } } });
  console.log(`\n✅ Seed terminé : ${count} recettes en base, ${withImg} avec photo.`);
}

main()
  .catch((e) => {
    console.error('❌ Seed échoué :', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
