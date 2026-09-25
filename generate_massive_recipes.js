/* eslint-disable no-console */
// Génère 1000 recettes procédurales et les injecte dans la base de données.
// Usage : node generate_massive_recipes.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { computeRewards } = require('./lib/game');
const { normalizeText } = require('./lib/text');

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Données de génération
// ---------------------------------------------------------------------------
const CATEGORIES = [
  'Viandes', 'Poissons', 'Végétarien', 'Desserts', 'Boulangerie',
  'Pâtes & Riz', 'Soupes', 'Entrées', 'Accompagnements', 'Sauces',
];

const ADJECTIVES = [
  'Royal', 'Épicé', 'Doré', 'Sauvage', 'Crémeux', 'Traditionnel',
  'Mystique', 'Céleste', 'Rustique', 'Fondant', 'Fumé', 'Glacé',
  'Caramélisé', 'Braisé', 'Rôti', 'Mariné', 'Grillé', 'Mijoté',
  'Croustillant', 'Velouté',
];

const PROTEINS = [
  { name: 'Poulet', emoji: '🍗', cat: 'Viandes' },
  { name: 'Bœuf', emoji: '🥩', cat: 'Viandes' },
  { name: 'Saumon', emoji: '🐟', cat: 'Poissons' },
  { name: 'Thon', emoji: '🐟', cat: 'Poissons' },
  { name: 'Crevettes', emoji: '🦐', cat: 'Poissons' },
  { name: 'Tofu', emoji: '🧊', cat: 'Végétarien' },
  { name: 'Pois chiches', emoji: '🫘', cat: 'Végétarien' },
  { name: 'Lentilles', emoji: '🫘', cat: 'Végétarien' },
  { name: 'Agneau', emoji: '🥩', cat: 'Viandes' },
  { name: 'Porc', emoji: '🥩', cat: 'Viandes' },
];

const BASES = [
  'avec sauce tomate maison',
  'aux herbes de Provence',
  'à la crème fraîche',
  'au beurre noisette',
  'aux épices orientales',
  'façon grand-mère',
  'au vin blanc',
  'au jus de citron',
  'à l\'ail et au persil',
  'aux champignons sautés',
];

const DESCRIPTIONS = {
  Viandes: 'Une épreuve de feu et de cuisson maîtrisée.',
  Poissons: 'Délicatesse et précision : la mer comme terrain de jeu.',
  Végétarien: 'Les légumes à l\'honneur, sans compromis sur le goût.',
  Desserts: 'Une épreuve sucrée pour les pâtissiers en herbe.',
  Boulangerie: 'Pâte, levée et four : l\'art du boulanger.',
  'Pâtes & Riz': 'Un grand classique des féculents à dompter.',
  Soupes: 'Une soupe réconfortante : patience et précision.',
  Entrées: 'Une entrée classique pour affûter ton couteau et ton palais.',
  Accompagnements: 'L\'accompagnement parfait, celui qui fait la différence.',
  Sauces: 'Une base indispensable du répertoire.',
};

const EMOJIS = {
  Viandes: '🥩', Poissons: '🐟', Végétarien: '🥗', Desserts: '🍰',
  Boulangerie: '🍞', 'Pâtes & Riz': '🍝', Soupes: '🍲',
  Entrées: '🥗', Accompagnements: '🥦', Sauces: '🫙',
};

// ---------------------------------------------------------------------------
// Génération des instructions selon la catégorie
// ---------------------------------------------------------------------------
function buildInstructions(proteinName, base, category, timeMinutes) {
  const steps = [];

  if (['Viandes', 'Poissons', 'Volailles'].includes(category)) {
    steps.push(`1. Découper et émincer le ${proteinName} en morceaux réguliers.`);
    steps.push(`2. Assaisonner avec sel, poivre et épices, puis mariner 10 minutes.`);
    steps.push(`3. Chauffer l'huile dans une poêle et saisir à feu vif 3-4 minutes de chaque côté.`);
    steps.push(`4. Préparer la sauce ${base}.`);
    steps.push(`5. Mijoter à feu doux ${Math.max(10, timeMinutes - 20)} minutes jusqu'à cuisson complète.`);
    steps.push(`6. Dresser dans l'assiette et servir chaud.`);
  } else if (category === 'Boulangerie' || category === 'Desserts') {
    steps.push(`1. Préchauffer le four à 180°C.`);
    steps.push(`2. Mélanger les ingrédients secs : farine, levure, sel.`);
    steps.push(`3. Incorporer le ${proteinName}, les œufs et le beurre fondu.`);
    steps.push(`4. Pétrir la pâte jusqu'à obtenir une texture homogène et lisse.`);
    steps.push(`5. Laisser lever ${Math.max(20, timeMinutes - 30)} minutes dans un endroit chaud.`);
    steps.push(`6. Enfourner ${Math.max(15, timeMinutes - 25)} minutes à 180°C.`);
    steps.push(`7. Laisser refroidir sur une grille avant de démouler.`);
  } else if (category === 'Soupes') {
    steps.push(`1. Émincer et hacher les légumes finement.`);
    steps.push(`2. Faire revenir l'ail et l'oignon dans l'huile d'olive.`);
    steps.push(`3. Ajouter le ${proteinName} et mélanger.`);
    steps.push(`4. Verser le bouillon et porter à ébullition.`);
    steps.push(`5. Assaisonner selon le goût ${base}.`);
    steps.push(`6. Mijoter ${Math.max(15, timeMinutes - 10)} minutes à feu doux.`);
    steps.push(`7. Fouetter et mixer si souhaité, puis servir.`);
  } else if (category === 'Sauces') {
    steps.push(`1. Réserver tous les ingrédients mesurés.`);
    steps.push(`2. Faire réduire le fond ${base} à feu moyen.`);
    steps.push(`3. Incorporer le ${proteinName} et fouetter vigoureusement.`);
    steps.push(`4. Assaisonner et ajuster la texture en ajoutant le liquide progressivement.`);
    steps.push(`5. Passer au tamis et servir en saucière.`);
  } else {
    steps.push(`1. Préparer et découper les ingrédients avec soin.`);
    steps.push(`2. Chauffer l'huile dans une grande poêle à feu moyen.`);
    steps.push(`3. Ajouter le ${proteinName} et faire dorer ${Math.max(5, timeMinutes / 4)} minutes.`);
    steps.push(`4. Assaisonner ${base}.`);
    steps.push(`5. Mélanger et incorporer tous les ingrédients, laisser mijoter.`);
    steps.push(`6. Dresser et servir immédiatement.`);
  }
  return steps.join('\n');
}

// ---------------------------------------------------------------------------
// Construction d'une recette
// ---------------------------------------------------------------------------
function buildRecipe(i) {
  const category = CATEGORIES[i % CATEGORIES.length];
  const adj = ADJECTIVES[i % ADJECTIVES.length];
  const protein = PROTEINS[i % PROTEINS.length];
  const base = BASES[i % BASES.length];

  const name = `${adj} ${protein.name} #${i}`;
  const timeMinutes = 15 + (i % 75); // 15–90 min
  const instructions = buildInstructions(protein.name, base, category, timeMinutes);

  const ingredients = [
    { name: protein.name, measure: '200 g' },
    { name: 'Huile d\'olive', measure: '2 c. à soupe' },
    { name: 'Ail', measure: '2 gousses' },
    { name: 'Sel et poivre', measure: 'selon goût' },
    { name: 'Herbes fraîches', measure: '1 bouquet' },
  ];
  if (i % 3 === 0) ingredients.push({ name: 'Oignon', measure: '1 unité' });
  if (i % 4 === 0) ingredients.push({ name: 'Crème fraîche', measure: '100 ml' });
  if (i % 5 === 0) ingredients.push({ name: 'Bouillon de volaille', measure: '200 ml' });
  if (i % 7 === 0) ingredients.push({ name: 'Vin blanc', measure: '100 ml' });

  const { difficulty, skillRewards, totalXp } = computeRewards({
    instructions,
    ingredientsCount: ingredients.length,
    timeMinutes,
    category,
  });
  const mainSkill = Object.entries(skillRewards).sort((a, b) => b[1] - a[1])[0]?.[0] || 'prep';

  const slugify = (s) => s.toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  return {
    externalId: `gen-${slugify(name)}`,
    source: 'generated',
    name,
    description: DESCRIPTIONS[category] || 'Une recette générée pour développer tes compétences.',
    category,
    area: null,
    searchText: normalizeText([name, category, ...ingredients.map((g) => g.name)].join(' ')),
    wikiTitle: null,
    imageUrl: null,
    imageChecked: false,
    emoji: EMOJIS[category] || '🍽️',
    timeMinutes,
    difficulty,
    ingredients: JSON.stringify(ingredients),
    instructions,
    skillRewards: JSON.stringify(skillRewards),
    mainSkill,
    totalXp,
  };
}

// ---------------------------------------------------------------------------
// Script principal
// ---------------------------------------------------------------------------
async function main() {
  console.log('🎮 Génération de 1000 recettes procédurales pour CulinaRPG...\n');

  const TOTAL = 1000;
  const BATCH = 100;
  let inserted = 0;
  let skipped = 0;

  for (let batch = 0; batch < TOTAL / BATCH; batch++) {
    const data = [];
    for (let j = 1; j <= BATCH; j++) {
      data.push(buildRecipe(batch * BATCH + j));
    }
    const result = await prisma.recipe.createMany({ data, skipDuplicates: true });
    inserted += result.count;
    skipped += BATCH - result.count;
    console.log(`  Lot ${batch + 1}/10 — ${inserted} insérées, ${skipped} doublons ignorés.`);
  }

  console.log(`\n✨ Terminé : ${inserted} nouvelles recettes ajoutées à la base.`);
}

main()
  .catch((e) => { console.error('Erreur :', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
