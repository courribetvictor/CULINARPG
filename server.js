/* eslint-disable no-console */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { PrismaClient, Prisma } = require('@prisma/client');
const {
  SKILLS, CHEF_CLASSES, CLASS_BONUS, skillLevel, globalLevel, skillProgress, globalProgress, titleForLevel, titlesFor,
} = require('./lib/game');
const auth = require('./lib/auth');
const { normalizeText } = require('./lib/text');
const { resolveRecipeImages } = require('./lib/images');

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT) || 3000;

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

// CORS uniquement si des origines sont explicitement autorisées (ex. app mobile empaquetée)
if (process.env.CORS_ORIGINS) {
  app.use(cors({ origin: process.env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true }));
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const requireAuth = auth.requireAuth(prisma);
const authLimiter = auth.rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const badRequest = (res, error, field) => res.status(400).json({ error, field });

// ---------------------------------------------------------------------------
// Dates & streak
// ---------------------------------------------------------------------------
function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

// Streak affiché : cassé si la dernière activité date d'avant-hier ou plus
function effectiveStreak(user) {
  if (!user.lastActiveDate) return 0;
  return [dayKey(), yesterdayKey()].includes(user.lastActiveDate) ? user.currentStreak : 0;
}

function nextStreak(user) {
  if (user.lastActiveDate === dayKey()) return user.currentStreak;
  if (user.lastActiveDate === yesterdayKey()) return user.currentStreak + 1;
  return 1;
}

// ---------------------------------------------------------------------------
// Présentation du joueur
// ---------------------------------------------------------------------------
function displayTitle(user, skills) {
  if (user.selectedTitle) {
    const t = titlesFor(user.totalXp, skills).find((x) => x.name === user.selectedTitle && x.unlocked);
    if (t) return t.name;
  }
  return titleForLevel(globalLevel(user.totalXp));
}

function publicUser(user, skills = []) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    bio: user.bio,
    avatar: user.avatar,
    avatarColor: user.avatarColor,
    avatarImage: user.avatarImage,
    chefClass: user.chefClass,
    selectedTitle: user.selectedTitle,
    title: displayTitle(user, skills),
    onboarded: user.onboarded,
    level: globalLevel(user.totalXp),
    createdAt: user.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Attribution d'XP (transaction) + détection des level-ups
// ---------------------------------------------------------------------------
async function grantXp(userId, baseRewards, extraOps = []) {
  return prisma.$transaction(async (tx) => {
    // Verrou de ligne : deux gains simultanés pour le même joueur s'exécutent l'un après l'autre
    // (sinon chacun lirait l'ancien total d'XP et l'un des deux gains serait perdu)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, include: { skills: true } });
    const before = Object.fromEntries(user.skills.map((s) => [s.skill, s.xp]));

    // Bonus de classe (+10 % sur la compétence de prédilection)
    const rewards = { ...baseRewards };
    let classBonus = 0;
    if (user.chefClass && rewards[user.chefClass]) {
      const boosted = Math.round(rewards[user.chefClass] * (1 + CLASS_BONUS));
      classBonus = boosted - rewards[user.chefClass];
      rewards[user.chefClass] = boosted;
    }
    const gained = Object.values(rewards).reduce((a, b) => a + b, 0);

    const skillLevelUps = [];
    for (const [skill, xp] of Object.entries(rewards)) {
      if (!SKILLS.includes(skill) || xp <= 0) continue;
      const prev = before[skill] || 0;
      await tx.userSkill.upsert({
        where: { userId_skill: { userId, skill } },
        update: { xp: { increment: xp } },
        create: { userId, skill, xp },
      });
      const from = skillLevel(prev);
      const to = skillLevel(prev + xp);
      if (to > from) skillLevelUps.push({ skill, from, to });
    }

    const streak = nextStreak(user);
    const newTotal = user.totalXp + gained;
    const fromLvl = globalLevel(user.totalXp);
    const toLvl = globalLevel(newTotal);

    await tx.user.update({
      where: { id: userId },
      data: {
        totalXp: newTotal,
        currentStreak: streak,
        bestStreak: Math.max(user.bestStreak, streak),
        lastActiveDate: dayKey(),
      },
    });

    for (const op of extraOps) await op(tx, gained);

    return {
      xpGained: gained,
      rewards,
      classBonus: classBonus ? { skill: user.chefClass, xp: classBonus } : null,
      streak,
      streakIncreased: streak > effectiveStreak(user),
      globalLevelUp: toLvl > fromLvl ? {
        from: fromLvl,
        to: toLvl,
        title: titleForLevel(toLvl),
        newTitle: titleForLevel(toLvl) !== titleForLevel(fromLvl) ? titleForLevel(toLvl) : null,
      } : null,
      skillLevelUps,
      global: globalProgress(newTotal),
    };
  });
}

// ---------------------------------------------------------------------------
// Badges (calculés à la volée)
// ---------------------------------------------------------------------------
function computeBadges({ user, skills, recipesCooked, uniqueRecipes, dailiesDone, bakingCooks }) {
  const lvl = globalLevel(user.totalXp);
  const maxSkill = Math.max(...skills.map((s) => skillLevel(s.xp)));
  const allSkills3 = skills.every((s) => skillLevel(s.xp) >= 3);
  return [
    { id: 'first-dish', name: 'Premier Plat', description: 'Cuisine ta première recette', icon: 'utensils', unlocked: recipesCooked >= 1 },
    { id: 'line-cook', name: 'Cuisinier de Ligne', description: 'Cuisine 10 recettes', icon: 'chef-hat', unlocked: recipesCooked >= 10 },
    { id: 'explorer', name: 'Explorateur', description: 'Cuisine 25 recettes différentes', icon: 'compass', unlocked: uniqueRecipes >= 25 },
    { id: 'disciplined', name: 'Discipliné', description: 'Complète 20 dailies', icon: 'calendar-check', unlocked: dailiesDone >= 20 },
    { id: 'on-fire', name: 'En Feu', description: 'Streak de 3 jours', icon: 'flame', unlocked: user.bestStreak >= 3 },
    { id: 'unstoppable', name: 'Inarrêtable', description: 'Streak de 7 jours', icon: 'zap', unlocked: user.bestStreak >= 7 },
    { id: 'baker', name: 'Mitron', description: '5 recettes de pâtisserie ou boulangerie', icon: 'croissant', unlocked: bakingCooks >= 5 },
    { id: 'specialist', name: 'Spécialiste', description: 'Une compétence niveau 5', icon: 'award', unlocked: maxSkill >= 5 },
    { id: 'all-rounder', name: 'Polyvalent', description: 'Toutes les compétences niveau 3', icon: 'hexagon', unlocked: allSkills3 },
    { id: 'sous-chef', name: 'Sous-Chef', description: 'Atteins le niveau global 8', icon: 'crown', unlocked: lvl >= 8 },
  ];
}

function serializeRecipe(r, cookedCount = 0) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    area: r.area,
    source: r.source,
    imageUrl: r.imageUrl,
    emoji: r.emoji,
    timeMinutes: r.timeMinutes,
    difficulty: r.difficulty,
    skillRewards: JSON.parse(r.skillRewards),
    totalXp: r.totalXp,
    cookedCount,
    ...(r.imageSource !== undefined && { imageSource: r.imageSource }),
    ...(r.ingredients !== undefined && { ingredients: JSON.parse(r.ingredients) }),
    ...(r.instructions !== undefined && { instructions: r.instructions }),
  };
}

// ===========================================================================
// Routes publiques
// ===========================================================================
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/meta', (req, res) => {
  res.json({
    classes: Object.entries(CHEF_CLASSES).map(([skill, c]) => ({ skill, ...c })),
    avatarColors: auth.AVATAR_COLORS,
    classBonus: CLASS_BONUS,
  });
});

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const username = auth.normUsername(req.body.username);
  const email = auth.normEmail(req.body.email);
  const { password } = req.body;
  const displayName = String(req.body.displayName || req.body.username || '').trim().slice(0, 30);

  if (!auth.USERNAME_RE.test(username)) return badRequest(res, 'Pseudo : 3 à 20 caractères (lettres, chiffres, « _ » ou « . »).', 'username');
  if (!auth.EMAIL_RE.test(email)) return badRequest(res, 'Adresse e-mail invalide.', 'email');
  const pwError = auth.validatePassword(password);
  if (pwError) return badRequest(res, pwError, 'password');

  const taken = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { username: true } });
  if (taken) {
    return res.status(409).json(taken.username === username
      ? { error: 'Ce pseudo est déjà pris.', field: 'username' }
      : { error: 'Un compte existe déjà avec cet e-mail.', field: 'email' });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        username,
        email,
        displayName: displayName || username,
        passwordHash: await auth.hashPassword(password),
        skills: { create: SKILLS.map((skill) => ({ skill })) },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'Pseudo ou e-mail déjà utilisé.' });
    }
    throw err;
  }
  await auth.createSession(prisma, req, res, user.id);
  return res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const identifier = String(req.body.identifier || req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!identifier || !password) return badRequest(res, 'Identifiant et mot de passe requis.');

  const user = await prisma.user.findFirst({
    where: identifier.includes('@') ? { email: identifier } : { username: auth.normUsername(identifier) },
    include: { skills: true },
  });
  const ok = user ? await auth.verifyPassword(password, user.passwordHash) : await auth.verifyAgainstDummy(password);
  if (!ok) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });

  await auth.createSession(prisma, req, res, user.id);
  return res.json({ user: publicUser(user, user.skills) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await auth.destroySession(prisma, req, res);
  res.json({ ok: true });
}));

// ===========================================================================
// Routes protégées
// ===========================================================================
app.use('/api', (req, res, next) => (req.path.startsWith('/auth/') ? next() : requireAuth(req, res, next)));

app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
  const skills = await prisma.userSkill.findMany({ where: { userId: req.user.id } });
  res.json({ user: publicUser(req.user, skills) });
}));

app.get('/api/user/profile', wrap(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { skills: true } });
  const skills = SKILLS.map((skill) => user.skills.find((s) => s.skill === skill) || { skill, xp: 0 });

  const [recipesCooked, uniqueRecipes, dailiesDone, bakingCooks, recent] = await Promise.all([
    prisma.userRecipeCompletion.count({ where: { userId: user.id } }),
    prisma.userRecipeCompletion.groupBy({ by: ['recipeId'], where: { userId: user.id } }).then((g) => g.length),
    prisma.userDailyCompletion.count({ where: { userId: user.id } }),
    prisma.userRecipeCompletion.count({ where: { userId: user.id, recipe: { category: { in: ['Desserts', 'Boulangerie', 'Dessert'] } } } }),
    prisma.userRecipeCompletion.findMany({
      where: { userId: user.id },
      orderBy: { cookedAt: 'desc' },
      take: 5,
      include: { recipe: { select: { id: true, name: true, emoji: true, imageUrl: true } } },
    }),
  ]);

  res.json({
    ...publicUser(user, skills),
    totalXp: user.totalXp,
    global: globalProgress(user.totalXp),
    streak: effectiveStreak(user),
    bestStreak: user.bestStreak,
    activeToday: user.lastActiveDate === dayKey(),
    skills: skills.map((s) => ({ skill: s.skill, ...skillProgress(s.xp) })),
    titles: titlesFor(user.totalXp, skills),
    stats: { recipesCooked, uniqueRecipes, dailiesDone },
    badges: computeBadges({ user, skills, recipesCooked, uniqueRecipes, dailiesDone, bakingCooks }),
    recent: recent.map((c) => ({ id: c.id, xpGained: c.xpGained, cookedAt: c.cookedAt, recipe: c.recipe })),
  });
}));

app.patch('/api/user/profile', wrap(async (req, res) => {
  const b = req.body || {};
  const data = {};

  if (b.displayName !== undefined) {
    const v = String(b.displayName).trim();
    if (v.length < 1 || v.length > 30) return badRequest(res, 'Nom affiché : 1 à 30 caractères.', 'displayName');
    data.displayName = v;
  }
  if (b.username !== undefined) {
    const v = auth.normUsername(b.username);
    if (!auth.USERNAME_RE.test(v)) return badRequest(res, 'Pseudo : 3 à 20 caractères (lettres, chiffres, « _ » ou « . »).', 'username');
    if (v !== req.user.username) {
      const taken = await prisma.user.findUnique({ where: { username: v }, select: { id: true } });
      if (taken) return res.status(409).json({ error: 'Ce pseudo est déjà pris.', field: 'username' });
    }
    data.username = v;
  }
  if (b.bio !== undefined) {
    const v = String(b.bio).trim();
    if (v.length > 160) return badRequest(res, 'Bio : 160 caractères maximum.', 'bio');
    data.bio = v;
  }
  if (b.avatar !== undefined) {
    const v = String(b.avatar);
    if (!v || v.length > 16 || /[<>"'&\s]/.test(v)) return badRequest(res, 'Avatar invalide.', 'avatar');
    data.avatar = v;
  }
  if (b.avatarColor !== undefined) {
    if (!auth.AVATAR_COLORS.includes(b.avatarColor)) return badRequest(res, 'Couleur invalide.', 'avatarColor');
    data.avatarColor = b.avatarColor;
  }
  if (b.avatarImage !== undefined) {
    if (b.avatarImage === null || b.avatarImage === '') data.avatarImage = null;
    else if (typeof b.avatarImage !== 'string' || b.avatarImage.length > auth.AVATAR_IMAGE_MAX || !auth.AVATAR_IMAGE_RE.test(b.avatarImage)) {
      return badRequest(res, 'Photo invalide ou trop lourde.', 'avatarImage');
    } else data.avatarImage = b.avatarImage;
  }
  if (b.chefClass !== undefined) {
    if (b.chefClass !== null && !SKILLS.includes(b.chefClass)) return badRequest(res, 'Classe invalide.', 'chefClass');
    data.chefClass = b.chefClass;
  }
  if (b.selectedTitle !== undefined) {
    if (b.selectedTitle === null || b.selectedTitle === '') data.selectedTitle = null;
    else {
      const skills = await prisma.userSkill.findMany({ where: { userId: req.user.id } });
      const t = titlesFor(req.user.totalXp, skills).find((x) => x.name === b.selectedTitle);
      if (!t || !t.unlocked) return badRequest(res, 'Ce titre n\'est pas encore débloqué.', 'selectedTitle');
      data.selectedTitle = t.name;
    }
  }
  if (b.onboarded !== undefined) data.onboarded = Boolean(b.onboarded);

  const user = await prisma.user.update({ where: { id: req.user.id }, data, include: { skills: true } });
  res.json({ user: publicUser(user, user.skills) });
}));

app.post('/api/user/password', authLimiter, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await auth.verifyPassword(String(currentPassword || ''), req.user.passwordHash))) {
    return res.status(403).json({ error: 'Mot de passe actuel incorrect.', field: 'currentPassword' });
  }
  const pwError = auth.validatePassword(newPassword);
  if (pwError) return badRequest(res, pwError, 'newPassword');
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await auth.hashPassword(newPassword) } });
  // Déconnecte les autres appareils
  await prisma.session.deleteMany({ where: { userId: req.user.id, NOT: { id: req.sessionId } } });
  res.json({ ok: true });
}));

app.delete('/api/user', authLimiter, wrap(async (req, res) => {
  if (!(await auth.verifyPassword(String(req.body?.password || ''), req.user.passwordHash))) {
    return res.status(403).json({ error: 'Mot de passe incorrect.', field: 'password' });
  }
  await prisma.user.delete({ where: { id: req.user.id } });
  await auth.destroySession(prisma, req, res);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Dailies
// ---------------------------------------------------------------------------
app.get('/api/dailies', wrap(async (req, res) => {
  const date = dayKey();
  const [tasks, done] = await Promise.all([
    prisma.dailyTask.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
    prisma.userDailyCompletion.findMany({ where: { userId: req.user.id, date } }),
  ]);
  const doneIds = new Set(done.map((d) => d.dailyTaskId));
  res.json({
    date,
    tasks: tasks.map((t) => ({ ...t, completed: doneIds.has(t.id) })),
    completedCount: doneIds.size,
    totalCount: tasks.length,
  });
}));

app.post('/api/dailies/:id/complete', wrap(async (req, res) => {
  const task = await prisma.dailyTask.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });

  const date = dayKey();
  try {
    const result = await grantXp(req.user.id, { [task.skill]: task.xpReward }, [
      (tx) => tx.userDailyCompletion.create({ data: { userId: req.user.id, dailyTaskId: task.id, date } }),
    ]);
    return res.json({ ...result, task: { id: task.id, title: task.title } });
  } catch (err) {
    // Contrainte unique (userId, dailyTaskId, date) : la transaction est annulée, pas d'XP en double
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'Déjà complétée aujourd\'hui' });
    }
    throw err;
  }
}));

// ---------------------------------------------------------------------------
// Recettes
// ---------------------------------------------------------------------------
const SORTS = {
  featured: [{ id: 'asc' }],
  easy: [{ difficulty: 'asc' }, { timeMinutes: 'asc' }],
  hard: [{ difficulty: 'desc' }, { totalXp: 'desc' }],
  xp: [{ totalXp: 'desc' }],
  quick: [{ timeMinutes: 'asc' }],
  name: [{ name: 'asc' }],
};
const sortOrder = (key) => SORTS[key] || SORTS.featured;

app.get('/api/recipes/categories', wrap(async (req, res) => {
  const groups = await prisma.recipe.groupBy({ by: ['category'], _count: { _all: true }, orderBy: { category: 'asc' } });
  res.json(groups.map((g) => ({ name: g.category, count: g._count._all })));
}));

app.get('/api/recipes', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const terms = normalizeText(req.query.search).split(' ').filter(Boolean).slice(0, 6);
  const category = String(req.query.category || '').trim();
  const skill = String(req.query.skill || '').trim();

  const where = {
    AND: terms.map((t) => ({ searchText: { contains: t } })),
    ...(category && category !== 'all' && { category }),
    ...(SKILLS.includes(skill) && { mainSkill: skill }),
  };

  const [total, rows] = await Promise.all([
    prisma.recipe.count({ where }),
    prisma.recipe.findMany({
      where,
      orderBy: sortOrder(req.query.sort),
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true, name: true, description: true, category: true, area: true, source: true, imageUrl: true,
        emoji: true, timeMinutes: true, difficulty: true, skillRewards: true, totalXp: true,
      },
    }),
  ]);

  const counts = await prisma.userRecipeCompletion.groupBy({
    by: ['recipeId'],
    where: { userId: req.user.id, recipeId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const countMap = Object.fromEntries(counts.map((c) => [c.recipeId, c._count._all]));

  res.json({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    items: rows.map((r) => serializeRecipe(r, countMap[r.id] || 0)),
  });
}));

app.get('/api/recipes/:id', wrap(async (req, res) => {
  const recipe = await prisma.recipe.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!recipe) return res.status(404).json({ error: 'Recette introuvable' });
  const cookedCount = await prisma.userRecipeCompletion.count({ where: { userId: req.user.id, recipeId: recipe.id } });
  res.json(serializeRecipe(recipe, cookedCount));
}));

app.post('/api/recipes/:id/cook', wrap(async (req, res) => {
  const recipe = await prisma.recipe.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!recipe) return res.status(404).json({ error: 'Recette introuvable' });

  // Rendements décroissants : chaque répétition rapporte moins (min 40 %)
  const timesCooked = await prisma.userRecipeCompletion.count({ where: { userId: req.user.id, recipeId: recipe.id } });
  const multiplier = Math.max(0.4, 1 - timesCooked * 0.2);
  const rewards = Object.fromEntries(
    Object.entries(JSON.parse(recipe.skillRewards)).map(([k, v]) => [k, Math.max(1, Math.round(v * multiplier))]),
  );

  const result = await grantXp(req.user.id, rewards, [
    (tx, xpGained) => tx.userRecipeCompletion.create({ data: { userId: req.user.id, recipeId: recipe.id, xpGained } }),
  ]);
  res.json({
    ...result,
    multiplier,
    recipe: { id: recipe.id, name: recipe.name, emoji: recipe.emoji, imageUrl: recipe.imageUrl },
  });
}));

// ---------------------------------------------------------------------------
// Fallbacks & erreurs
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  console.error(err);
  return res.status(err.status || 500).json({ error: 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`🔥 CulinaRPG en ligne sur http://localhost:${PORT}`);
  // Complète en tâche de fond les photos manquantes (si le seed a tourné hors ligne)
  if (process.env.RESOLVE_IMAGES_ON_START !== 'false') {
    setTimeout(() => resolveRecipeImages(prisma, { log: (m) => console.log(m) }).catch(() => {}), 3000);
  }
  // Purge des sessions expirées
  setInterval(() => prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {}), 6 * 3600 * 1000).unref();
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
