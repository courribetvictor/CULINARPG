// Logique de jeu partagée (serveur + seed)

const SKILLS = ['knife', 'fire', 'seasoning', 'prep', 'baking'];

const skillLevel = (xp) => Math.floor(Math.sqrt(xp) / 5) + 1;
const globalLevel = (xp) => Math.floor(Math.sqrt(xp) / 10) + 1;

// XP nécessaire pour atteindre un niveau donné (inverse des formules)
const skillXpForLevel = (lvl) => Math.pow((lvl - 1) * 5, 2);
const globalXpForLevel = (lvl) => Math.pow((lvl - 1) * 10, 2);

function progress(xp, levelFn, xpForLevelFn) {
  const level = levelFn(xp);
  const floor = xpForLevelFn(level);
  const ceil = xpForLevelFn(level + 1);
  return {
    xp,
    level,
    currentLevelXp: xp - floor,
    nextLevelXp: ceil - floor,
    percent: Math.min(100, Math.round(((xp - floor) / (ceil - floor)) * 100)),
  };
}

const skillProgress = (xp) => progress(xp, skillLevel, skillXpForLevel);
const globalProgress = (xp) => progress(xp, globalLevel, globalXpForLevel);

// ---------------------------------------------------------------------------
// Classes de chef : +10 % d'XP sur la compétence de prédilection
// ---------------------------------------------------------------------------
const CLASS_BONUS = 0.1;
const CHEF_CLASSES = {
  knife: { name: 'Lame', description: 'Précision chirurgicale : +10 % d\'XP Couteau.' },
  fire: { name: 'Pyromancien', description: 'Maître des flammes : +10 % d\'XP Feu.' },
  seasoning: { name: 'Alchimiste', description: 'Palais d\'exception : +10 % d\'XP Assaisonnement.' },
  prep: { name: 'Stratège', description: 'Organisation parfaite : +10 % d\'XP Préparation.' },
  baking: { name: 'Artisan', description: 'Magie du four : +10 % d\'XP Pâtisserie.' },
};

// ---------------------------------------------------------------------------
// Titres
// ---------------------------------------------------------------------------
const GLOBAL_TITLES = [
  [1, 'Commis de Cuisine'],
  [3, 'Apprenti Cuisinier'],
  [5, 'Chef de Partie'],
  [8, 'Sous-Chef'],
  [12, 'Chef de Cuisine'],
  [16, 'Chef Étoilé'],
  [20, 'Monarque des Fourneaux'],
];
const SKILL_TITLES = {
  knife: 'Maître Lame',
  fire: 'Seigneur des Flammes',
  seasoning: 'Grand Alchimiste',
  prep: 'Stratège Suprême',
  baking: 'Artisan du Four',
};
const SKILL_TITLE_LEVEL = 5;

const titleForLevel = (lvl) => GLOBAL_TITLES.filter(([l]) => lvl >= l).pop()[1];

// Tous les titres, avec leur condition et leur état pour un joueur donné
function titlesFor(totalXp, skills) {
  const lvl = globalLevel(totalXp);
  const byLevel = GLOBAL_TITLES.map(([l, name]) => ({
    name, requirement: `Niveau global ${l}`, unlocked: lvl >= l,
  }));
  const bySkill = SKILLS.map((s) => {
    const xp = skills.find((k) => k.skill === s)?.xp || 0;
    return { name: SKILL_TITLES[s], requirement: `Compétence niveau ${SKILL_TITLE_LEVEL}`, skill: s, unlocked: skillLevel(xp) >= SKILL_TITLE_LEVEL };
  });
  return [...byLevel, ...bySkill];
}

// ---------------------------------------------------------------------------
// Récompenses dynamiques
// ---------------------------------------------------------------------------
// Racines de mots (FR + EN) ; un « $ » final impose un mot entier.
const KEYWORDS = {
  knife: ['éminc', 'hach', 'cisel', 'tranch', 'découp', 'taill', 'brunoise', 'julienne', 'râp', 'éplu', 'dés$', 'lamelles', 'rondelles', 'effiloch', 'concass', 'coup', 'couteau', 'chop', 'dice', 'slice', 'mince', 'cut', 'peel', 'fillet'],
  fire: ['saisi', 'sauter', 'sauté', 'poêl', 'grill', 'rôti', 'mijot', 'frire', 'frit', 'bouill', 'ébullition', 'brais', 'flamb', 'dorer', 'doré', 'revenir', 'caramél', 'caramel', 'réduire', 'confire', 'pocher', 'fry', 'sear', 'roast', 'boil', 'simmer'],
  seasoning: ['assaisonn', 'sel$', 'saler', 'poivr', 'épice', 'ail$', 'herbes', 'cumin', 'paprika', 'piment', 'curry', 'gingembre', 'sauce', 'marin', 'citron', 'vinaigre', 'moutarde', 'safran', 'cannelle', 'season', 'salt', 'pepper', 'spice', 'garlic'],
  prep: ['mélang', 'fouett', 'réserv', 'prépar', 'mesur', 'mix', 'égoutt', 'incorpor', 'monter', 'émulsion', 'reposer', 'répartir', 'dresser', 'garnir', 'battre', 'whisk', 'combine'],
  baking: ['four$', 'préchauff', 'pâte', 'farine', 'levure', 'pétri', 'gâteau', 'tarte', 'moule', 'lever', 'abaisser', 'façonner', 'pocher des', 'bake', 'oven', 'dough', 'flour', 'knead'],
};
const KEYWORD_RE = Object.fromEntries(Object.entries(KEYWORDS).map(([skill, list]) => [
  skill,
  list.map((kw) => (kw.endsWith('$')
    ? new RegExp(`(?<!\\p{L})${kw.slice(0, -1)}(?!\\p{L})`, 'giu')
    : new RegExp(`(?<!\\p{L})${kw}`, 'giu'))),
]));

const CATEGORY_BIAS = {
  'Petit-déjeuner': { prep: 1.5, baking: 1 },
  Entrées: { knife: 2, seasoning: 1 },
  Soupes: { knife: 1.5, fire: 1 },
  Œufs: { fire: 1.5, prep: 1 },
  'Pâtes & Riz': { fire: 1, prep: 1.5 },
  Viandes: { fire: 2.5, seasoning: 1 },
  Volailles: { fire: 2, seasoning: 1 },
  Poissons: { knife: 1.5, fire: 1.5 },
  Végétarien: { knife: 2, seasoning: 1 },
  Accompagnements: { knife: 1, fire: 1 },
  Sauces: { seasoning: 2.5, prep: 1.5 },
  Boulangerie: { baking: 3.5, prep: 1 },
  Desserts: { baking: 3, prep: 1.5 },
  'Street food': { fire: 1.5, prep: 1 },
  // Catégories TheMealDB (import optionnel)
  Dessert: { baking: 3, prep: 1 },
  Beef: { fire: 2, knife: 1 },
  Chicken: { fire: 2, knife: 1 },
  Lamb: { fire: 2, seasoning: 1 },
  Pork: { fire: 2, seasoning: 1 },
  Seafood: { knife: 2, fire: 1 },
  Vegetarian: { knife: 2, prep: 1 },
  Vegan: { knife: 2, prep: 1 },
  Pasta: { fire: 1, prep: 1 },
  Side: { knife: 1, seasoning: 1 },
  Starter: { knife: 1, prep: 1 },
  Breakfast: { prep: 1, fire: 1 },
  Goat: { fire: 2, seasoning: 2 },
  Miscellaneous: { prep: 1 },
};

/**
 * Calcule dynamiquement difficulté (1-5) + récompenses XP par compétence
 * à partir du texte de la recette, du nombre d'ingrédients et du temps.
 * Le temps passif (levée, repos, fermentation) est plafonné à 2 h.
 */
function computeRewards({ instructions = '', ingredientsCount = 5, timeMinutes = 30, category = '' }) {
  const text = instructions.toLowerCase();
  const weights = Object.fromEntries(SKILLS.map((s) => [s, 0.1]));

  for (const skill of SKILLS) {
    for (const re of KEYWORD_RE[skill]) {
      const hits = (text.match(re) || []).length;
      weights[skill] += Math.min(hits, 3) * 0.6;
    }
  }
  for (const [skill, bonus] of Object.entries(CATEGORY_BIAS[category] || {})) {
    weights[skill] += bonus;
  }

  const activeTime = Math.min(timeMinutes, 120);
  const steps = Math.max(1, text.split(/[.\n]/).filter((s) => s.trim().length > 12).length);
  const complexity = ingredientsCount * 1.2 + steps * 0.8 + activeTime / 15;
  const difficulty = 1 + [10, 14, 18, 22].filter((t) => complexity >= t).length;

  const pool = 40 + difficulty * 35 + Math.round(activeTime / 3);
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const skillRewards = {};
  for (const skill of SKILLS) {
    const share = Math.round((weights[skill] / totalWeight) * pool);
    if (share >= 10) skillRewards[skill] = Math.round(share / 5) * 5;
  }
  if (Object.keys(skillRewards).length === 0) skillRewards.prep = 20;

  const totalXp = Object.values(skillRewards).reduce((a, b) => a + b, 0);
  return { difficulty, skillRewards, totalXp };
}

module.exports = {
  SKILLS,
  CHEF_CLASSES,
  CLASS_BONUS,
  skillLevel,
  globalLevel,
  skillProgress,
  globalProgress,
  titleForLevel,
  titlesFor,
  computeRewards,
};
