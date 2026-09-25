/* eslint-disable no-console */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { PrismaClient, Prisma } = require('@prisma/client');
const {
  SKILLS, LEAGUES, CHEF_CLASSES, CLASS_BONUS, skillLevel, globalLevel, skillProgress, globalProgress, titleForLevel, titlesFor, userLeague, computeRewards,
} = require('./lib/game');
const auth = require('./lib/auth');
const { normalizeText } = require('./lib/text');
const { resolveRecipeImages } = require('./lib/images');

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

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
app.use(express.json({
  limit: '512kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
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
    gems: user.gems || 0,
    isPro: user.isPro || false,
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

// Mode privé : si SIGNUP_CODE est défini, l'inscription exige ce code d'invitation
const SIGNUP_CODE = (process.env.SIGNUP_CODE || '').trim();

app.get('/api/meta', (req, res) => {
  res.json({
    classes: Object.entries(CHEF_CLASSES).map(([skill, c]) => ({ skill, ...c })),
    avatarColors: auth.AVATAR_COLORS,
    classBonus: CLASS_BONUS,
    inviteRequired: Boolean(SIGNUP_CODE),
  });
});

// Liaison app Android (TWA) ↔ site : sans ce fichier, Android affiche une barre d'adresse
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = (process.env.TWA_PACKAGE_NAME || '').trim();
  const fingerprints = (process.env.TWA_SHA256_FINGERPRINTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json(pkg && fingerprints.length ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fingerprints },
  }] : []);
});

// Politique de confidentialité (exigée par le Play Store) — e-mail de contact via CONTACT_EMAIL
const PRIVACY_HTML = require('fs').readFileSync(path.join(__dirname, 'views', 'privacy.html'), 'utf8');
app.get(['/privacy', '/privacy.html'], (req, res) => {
  const contact = (process.env.CONTACT_EMAIL || 'contact@exemple.fr').replace(/[<>"&]/g, '');
  res.type('html').send(PRIVACY_HTML.replace(/\{\{CONTACT_EMAIL\}\}/g, contact));
});

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const username = auth.normUsername(req.body.username);
  const email = auth.normEmail(req.body.email);
  const { password } = req.body;
  const displayName = String(req.body.displayName || req.body.username || '').trim().slice(0, 30);

  if (SIGNUP_CODE && String(req.body.inviteCode || '').trim() !== SIGNUP_CODE) {
    return res.status(403).json({ error: 'Code d\'invitation invalide.', field: 'inviteCode' });
  }

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

// ---------------------------------------------------------------------------
// Recettes personnelles (privées)
// ---------------------------------------------------------------------------
app.get('/api/recipes/mine', wrap(async (req, res) => {
  const recipes = await prisma.recipe.findMany({
    where: { creatorId: req.user.id, isCustom: true },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { completions: true } } },
  });
  res.json(recipes.map((r) => ({ ...serializeRecipe(r), cookedCount: r._count.completions })));
}));

app.post('/api/recipes/mine', wrap(async (req, res) => {
  const { title, category, timeMinutes, ingredients, instructions, imageUrl } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Le titre est requis', field: 'title' });
  if (!Array.isArray(ingredients) || !ingredients.length) return res.status(400).json({ error: 'Au moins un ingrédient requis', field: 'ingredients' });
  if (!instructions?.trim()) return res.status(400).json({ error: 'Les étapes sont requises', field: 'instructions' });

  const { difficulty, skillRewards, totalXp } = computeRewards({
    instructions,
    ingredientsCount: ingredients.length,
    timeMinutes: Number(timeMinutes) || 30,
    category: category || '',
  });
  const mainSkill = Object.entries(skillRewards).sort((a, b) => b[1] - a[1])[0]?.[0] || 'prep';

  const recipe = await prisma.recipe.create({
    data: {
      source: 'custom',
      name: title.trim(),
      description: '',
      category: category || 'Autre',
      timeMinutes: Math.max(1, Number(timeMinutes) || 30),
      difficulty,
      ingredients: JSON.stringify(ingredients),
      instructions: instructions.trim(),
      skillRewards: JSON.stringify(skillRewards),
      mainSkill,
      totalXp,
      searchText: normalizeText(title),
      emoji: '🍽️',
      imageUrl: imageUrl || null,
      isCustom: true,
      creatorId: req.user.id,
    },
  });
  res.status(201).json(serializeRecipe(recipe));
}));

app.delete('/api/recipes/mine/:id', wrap(async (req, res) => {
  const recipe = await prisma.recipe.findFirst({
    where: { id: Number(req.params.id) || 0, creatorId: req.user.id, isCustom: true },
  });
  if (!recipe) return res.status(404).json({ error: 'Recette introuvable' });
  await prisma.recipe.delete({ where: { id: recipe.id } });
  res.json({ ok: true });
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
    (tx, xpGained) => tx.user.update({ where: { id: req.user.id }, data: { gems: { increment: Math.max(1, Math.floor(xpGained / 10)) } } }),
  ]);
  const gemsEarned = Math.max(1, Math.floor(result.xpGained / 10));
  const updatedUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { gems: true } });
  res.json({
    ...result,
    multiplier,
    gemsEarned,
    gems: updatedUser.gems,
    recipe: { id: recipe.id, name: recipe.name, emoji: recipe.emoji, imageUrl: recipe.imageUrl },
  });
}));

// ---------------------------------------------------------------------------
// Classement Ranked
// ---------------------------------------------------------------------------
app.get('/api/ranked', wrap(async (req, res) => {
  const players = await prisma.user.findMany({
    select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, avatarImage: true, totalXp: true, chefClass: true },
    orderBy: { totalXp: 'desc' },
    take: 50,
  });
  const leaderboard = players.map((p, i) => ({
    rank: i + 1,
    ...p,
    league: userLeague(p.totalXp),
    level: globalLevel(p.totalXp),
  }));
  let me = leaderboard.find((p) => p.id === req.user.id);
  if (!me) {
    const above = await prisma.user.count({ where: { totalXp: { gt: req.user.totalXp } } });
    me = { rank: above + 1, ...req.user, league: userLeague(req.user.totalXp), level: globalLevel(req.user.totalXp) };
  }
  res.json({
    leaderboard,
    me,
    myLeague: userLeague(req.user.totalXp),
    leagues: LEAGUES,
    season: { number: 1, name: 'Saison des Premières Flammes', endDate: '2025-12-31' },
  });
}));

// ---------------------------------------------------------------------------
// Quêtes personnalisées
// ---------------------------------------------------------------------------
app.get('/api/quests', wrap(async (req, res) => {
  const quests = await prisma.userQuest.findMany({
    where: { userId: req.user.id },
    orderBy: [{ completed: 'asc' }, { createdAt: 'desc' }],
  });
  res.json(quests);
}));

app.post('/api/quests', wrap(async (req, res) => {
  const { title, description, skill, targetCount, icon } = req.body || {};
  const t = String(title || '').trim();
  if (t.length < 2 || t.length > 60) return badRequest(res, 'Titre : 2 à 60 caractères.', 'title');
  if (!SKILLS.includes(skill)) return badRequest(res, 'Compétence invalide.', 'skill');
  const target = Math.min(50, Math.max(1, parseInt(targetCount, 10) || 1));
  const quest = await prisma.userQuest.create({
    data: {
      userId: req.user.id,
      title: t,
      description: String(description || '').trim().slice(0, 200),
      skill,
      icon: String(icon || 'target').slice(0, 30),
      targetCount: target,
    },
  });
  res.status(201).json(quest);
}));

app.post('/api/quests/:id/log', wrap(async (req, res) => {
  const quest = await prisma.userQuest.findFirst({ where: { id: Number(req.params.id) || 0, userId: req.user.id } });
  if (!quest) return res.status(404).json({ error: 'Quête introuvable' });
  if (quest.completed) return res.status(409).json({ error: 'Quête déjà complétée' });
  const newCount = quest.currentCount + 1;
  const completing = newCount >= quest.targetCount;
  await prisma.userQuest.update({
    where: { id: quest.id },
    data: { currentCount: newCount, completed: completing, completedAt: completing ? new Date() : undefined },
  });
  let xpResult = null;
  if (completing) {
    const xpBase = Math.min(200, 50 + quest.targetCount * 15);
    xpResult = await grantXp(req.user.id, { [quest.skill]: xpBase });
    await prisma.user.update({ where: { id: req.user.id }, data: { gems: { increment: 5 } } });
  }
  res.json({ quest: { ...quest, currentCount: newCount, completed: completing }, xpResult });
}));

app.delete('/api/quests/:id', wrap(async (req, res) => {
  const deleted = await prisma.userQuest.deleteMany({ where: { id: Number(req.params.id) || 0, userId: req.user.id } });
  if (!deleted.count) return res.status(404).json({ error: 'Quête introuvable' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Leçons
// ---------------------------------------------------------------------------
app.get('/api/lessons', wrap(async (req, res) => {
  const [lessons, unlocks] = await Promise.all([
    prisma.lesson.findMany({ orderBy: { order: 'asc' } }),
    prisma.userLessonUnlock.findMany({ where: { userId: req.user.id } }),
  ]);
  const unlockedIds = new Set(unlocks.map((u) => u.lessonId));
  res.json(lessons.map((l) => ({
    id: l.id, slug: l.slug, title: l.title, description: l.description,
    category: l.category, skill: l.skill, difficulty: l.difficulty,
    icon: l.icon, gemCost: l.gemCost, xpReward: l.xpReward, order: l.order,
    unlocked: l.gemCost === 0 || req.user.isPro || unlockedIds.has(l.id),
    completed: unlockedIds.has(l.id),
  })));
}));

app.get('/api/lessons/:id', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const unlock = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  const accessible = lesson.gemCost === 0 || req.user.isPro || !!unlock;
  if (!accessible) return res.status(403).json({ error: 'Leçon verrouillée', gemCost: lesson.gemCost, gems: req.user.gems });
  res.json({ ...lesson, content: JSON.parse(lesson.content), completed: !!unlock });
}));

app.post('/api/lessons/:id/unlock', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const existing = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  if (existing) return res.status(409).json({ error: 'Leçon déjà débloquée' });
  if (lesson.gemCost > 0 && !req.user.isPro) {
    if (req.user.gems < lesson.gemCost) {
      return res.status(402).json({ error: `Gemmes insuffisantes (${req.user.gems}/${lesson.gemCost})`, gems: req.user.gems });
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { gems: { decrement: lesson.gemCost } } });
  }
  await prisma.userLessonUnlock.create({ data: { userId: req.user.id, lessonId: lesson.id } });
  const xpResult = await grantXp(req.user.id, { [lesson.skill]: lesson.xpReward });
  const updatedUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { gems: true } });
  res.json({ ok: true, gems: updatedUser.gems, xpResult });
}));

// ---------------------------------------------------------------------------
// Boutique & Stripe
// ---------------------------------------------------------------------------
const GEM_PACKS = {
  starter: { gems: 100,  unitAmount: 199,  label: '100 gemmes'   },
  valeur:  { gems: 500,  unitAmount: 499,  label: '500 gemmes'   },
  maxi:    { gems: 1500, unitAmount: 999,  label: '1 500 gemmes' },
};
const PRO_PLANS = {
  monthly: { unitAmount: 399,  interval: 'month', label: 'Pro mensuel' },
  annual:  { unitAmount: 2999, interval: 'year',  label: 'Pro annuel'  },
};

// Helper : fulfil a payment (called by webhook AND simulation fallback)
async function fulfillGems(userId, pack) {
  const updated = await prisma.user.update({ where: { id: userId }, data: { gems: { increment: pack.gems } }, select: { gems: true } });
  return { gems: updated.gems, earned: pack.gems };
}
async function fulfillPro(userId) {
  await prisma.user.update({ where: { id: userId }, data: { isPro: true } });
}
async function fulfillLesson(userId, lesson) {
  const exists = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId, lessonId: lesson.id } } });
  if (exists) return null;
  await prisma.userLessonUnlock.create({ data: { userId, lessonId: lesson.id } });
  return grantXp(userId, { [lesson.skill]: lesson.xpReward });
}

// Helper : crée une session Stripe et renvoie { url } ou une erreur lisible
async function stripeSession(params, res, createFn) {
  try {
    const session = await createFn(params);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe]', err.message);
    return res.status(402).json({ error: err.message || 'Erreur Stripe' });
  }
}

// POST /api/stripe/checkout/gems
app.post('/api/stripe/checkout/gems', requireAuth, wrap(async (req, res) => {
  const pack = GEM_PACKS[req.body?.pack];
  if (!pack) return badRequest(res, 'Pack invalide');
  if (!stripe) {
    const result = await fulfillGems(req.user.id, pack);
    return res.json({ simulated: true, ...result });
  }
  return stripeSession({}, res, () => stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: pack.unitAmount, product_data: { name: `CulinaRPG · ${pack.label}`, description: `${pack.gems} gemmes pour débloquer des leçons premium` } } }],
    metadata: { type: 'gems', userId: String(req.user.id), gemPack: req.body.pack, gemAmount: String(pack.gems) },
    success_url: `${APP_URL}/?payment=success&type=gems&earned=${pack.gems}`,
    cancel_url: `${APP_URL}/#profile`,
  }));
}));

// POST /api/stripe/checkout/pro
app.post('/api/stripe/checkout/pro', requireAuth, wrap(async (req, res) => {
  const plan = PRO_PLANS[req.body?.plan] || PRO_PLANS.annual;
  if (!stripe) {
    await fulfillPro(req.user.id);
    return res.json({ simulated: true, isPro: true });
  }
  return stripeSession({}, res, () => stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: plan.unitAmount, recurring: { interval: plan.interval }, product_data: { name: `CulinaRPG Pro · ${plan.label}`, description: 'Accès illimité à toutes les leçons et fonctionnalités avancées' } } }],
    metadata: { type: 'pro', userId: String(req.user.id), plan: req.body?.plan || 'annual' },
    success_url: `${APP_URL}/?payment=success&type=pro`,
    cancel_url: `${APP_URL}/#pro`,
  }));
}));

// POST /api/stripe/checkout/lesson
app.post('/api/stripe/checkout/lesson', requireAuth, wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.body?.lessonId) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  if (!stripe) {
    const xpResult = await fulfillLesson(req.user.id, lesson);
    if (!xpResult) return res.status(409).json({ error: 'Leçon déjà débloquée' });
    return res.json({ simulated: true, xpResult });
  }
  const existing = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  if (existing) return res.status(409).json({ error: 'Leçon déjà débloquée' });
  return stripeSession({}, res, () => stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 99, product_data: { name: `CulinaRPG · Leçon : ${lesson.title}`, description: lesson.description } } }],
    metadata: { type: 'lesson', userId: String(req.user.id), lessonId: String(lesson.id), lessonSkill: lesson.skill, lessonXp: String(lesson.xpReward) },
    success_url: `${APP_URL}/?payment=success&type=lesson`,
    cancel_url: `${APP_URL}/#lessons`,
  }));
}));

// Backward-compat simulation aliases (utilisés quand Stripe n'est pas configuré)
app.post('/api/shop/gems', requireAuth, wrap(async (req, res) => {
  const pack = GEM_PACKS[req.body?.pack];
  if (!pack) return badRequest(res, 'Pack invalide');
  const result = await fulfillGems(req.user.id, pack);
  res.json({ ok: true, ...result });
}));
app.post('/api/shop/pro', requireAuth, wrap(async (req, res) => {
  await fulfillPro(req.user.id);
  res.json({ ok: true, isPro: true });
}));
app.post('/api/lessons/:id/buy', requireAuth, wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const xpResult = await fulfillLesson(req.user.id, lesson);
  if (!xpResult) return res.status(409).json({ error: 'Leçon déjà débloquée' });
  res.json({ ok: true, xpResult });
}));

// POST /api/stripe/webhook
app.post('/api/stripe/webhook', wrap(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook Stripe non configuré (STRIPE_WEBHOOK_SECRET manquant)' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Signature invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { type, userId, gemPack, gemAmount, lessonId, lessonSkill, lessonXp } = session.metadata || {};
    const uid = parseInt(userId, 10);
    try {
      if (type === 'gems') {
        const pack = GEM_PACKS[gemPack] || { gems: parseInt(gemAmount, 10) };
        await fulfillGems(uid, pack);
        console.log(`[Stripe] Gems fulfilled: user ${uid} +${pack.gems}`);
      } else if (type === 'pro') {
        await fulfillPro(uid);
        console.log(`[Stripe] Pro fulfilled: user ${uid}`);
      } else if (type === 'lesson') {
        const lesson = { id: parseInt(lessonId, 10), skill: lessonSkill, xpReward: parseInt(lessonXp, 10) };
        await fulfillLesson(uid, lesson);
        console.log(`[Stripe] Lesson fulfilled: user ${uid} lesson ${lessonId}`);
      }
    } catch (e) { console.error('[Stripe] Fulfillment error:', e); }
  }
  res.json({ received: true });
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
  // Erreurs Stripe : renvoyer le message pour faciliter le diagnostic
  if (err.type && err.type.startsWith('Stripe')) return res.status(402).json({ error: err.message });
  return res.status(err.status || 500).json({ error: 'Erreur serveur' });
});

// ---------------------------------------------------------------------------
// Seed leçons (au démarrage si la table est vide)
// ---------------------------------------------------------------------------
const LESSON_SEED = [
  { slug: 'coupes-essentielles', title: 'Les coupes essentielles', description: 'Julienne, brunoise, chiffonnade… maîtrise les coupes de base.', category: 'knife', skill: 'knife', difficulty: 1, icon: 'scissors', gemCost: 0, xpReward: 80, order: 1, content: JSON.stringify([{ type: 'text', text: 'La maîtrise du couteau est la base de toute cuisine professionnelle.' }, { type: 'technique', title: 'Julienne', text: 'Bâtonnets de 3×3×50mm. Idéale pour les légumes sautés et salades.' }, { type: 'technique', title: 'Brunoise', text: 'Dés de 3×3×3mm. Parfaite pour les sauces, soupes et farces.' }, { type: 'tip', text: 'Garde les doigts repliés en "griffe de chat" pour protéger les bouts.' }, { type: 'technique', title: 'Chiffonnade', text: 'Rouler les feuilles et couper en fines lanières. Idéal pour basilic, menthe.' }]) },
  { slug: 'mise-en-place', title: 'La mise en place', description: 'L\'art de l\'organisation. Prépare comme un pro, cuisine sans stress.', category: 'prep', skill: 'prep', difficulty: 1, icon: 'layout-grid', gemCost: 0, xpReward: 80, order: 2, content: JSON.stringify([{ type: 'text', text: 'Mise en place = tout préparer avant de cuisiner. La philosophie de toute grande cuisine.' }, { type: 'technique', title: 'Lire la recette entière', text: 'Identifier les temps de repos, étapes parallèles et équipements nécessaires avant de commencer.' }, { type: 'tip', text: 'Peser et disposer tous les ingrédients dans des bols avant la première étape.' }, { type: 'technique', title: 'Nettoyer au fur et à mesure', text: 'Un plan de travail propre = plus de vitesse et de précision.' }]) },
  { slug: 'aromates-de-base', title: 'Les aromates de base', description: 'Herbes, épices, zestes. Construire de la profondeur de goût.', category: 'seasoning', skill: 'seasoning', difficulty: 1, icon: 'leaf', gemCost: 0, xpReward: 80, order: 3, content: JSON.stringify([{ type: 'text', text: 'L\'assaisonnement construit complexité et équilibre. Sel, acide, gras, sucre, umami — tes cinq piliers.' }, { type: 'technique', title: 'Le sel en étapes', text: 'Saler pendant la cuisson, pas seulement à la fin. Le sel pénètre et rehausse tous les arômes.' }, { type: 'technique', title: 'L\'acidité', text: 'Un filet de citron ou vinaigre à la fin "ouvre" les saveurs d\'un plat qui paraît fade.' }, { type: 'tip', text: 'Herbes fragiles (basilic, coriandre) : fin de cuisson. Herbes robustes (thym, romarin) : début.' }]) },
  { slug: 'bases-patisserie', title: 'Les bases de la pâtisserie', description: 'Crèmes fondamentales, pâtes de base, techniques essentielles.', category: 'baking', skill: 'baking', difficulty: 2, icon: 'cake', gemCost: 30, xpReward: 120, order: 4, content: JSON.stringify([{ type: 'text', text: 'La pâtisserie est une science exacte. Les proportions doivent être respectées à la gramme près.' }, { type: 'technique', title: 'Crème pâtissière', text: 'Jaunes + sucre (blanchir) + fécule → incorporer le lait chaud progressivement sans cesser de fouetter.' }, { type: 'technique', title: 'Pâte brisée', text: 'Sabler le beurre froid dans la farine, lier avec eau glacée minimum. Ne pas trop travailler.' }, { type: 'tip', text: 'Préchauffer le four 15 min minimum. La stabilité de température est cruciale en pâtisserie.' }]) },
  { slug: 'maitrise-saisie', title: 'Maîtriser la saisie', description: 'Croûte parfaite, jus préservé. Comprends la réaction de Maillard.', category: 'fire', skill: 'fire', difficulty: 2, icon: 'flame', gemCost: 30, xpReward: 120, order: 5, content: JSON.stringify([{ type: 'text', text: 'La réaction de Maillard (>150°C) crée la croûte dorée et parfumée. Elle nécessite une surface sèche et une poêle très chaude.' }, { type: 'technique', title: 'Préchauffer à vif', text: 'Laisser monter la poêle à feu vif 2-3 min. Quelques gouttes d\'eau doivent s\'évaporer instantanément.' }, { type: 'tip', text: 'Sécher la surface de la viande au papier absorbant. L\'humidité = vapeur = pas de croûte.' }, { type: 'technique', title: 'Ne pas toucher', text: 'Déposer et ne pas bouger 2-3 min. La pièce se décollera seule quand la croûte sera formée.' }]) },
  { slug: 'coupes-avancees', title: 'Coupes avancées', description: 'Paysanne, taille en losanges, chiffonnade fine.', category: 'knife', skill: 'knife', difficulty: 2, icon: 'git-branch', gemCost: 30, xpReward: 120, order: 6, content: JSON.stringify([{ type: 'text', text: 'Ces tailles apportent élégance et cuisson uniforme à tes plats.' }, { type: 'technique', title: 'Paysanne', text: 'Tranches irrégulières de 3-4mm. Idéale pour les soupes et ragoûts rustiques.' }, { type: 'technique', title: 'En losanges', text: 'Couper en biais pour des formes géométriques élégantes, souvent utilisé pour les carottes.' }, { type: 'tip', text: 'L\'affûtage régulier est plus important que le couteau lui-même. Un couteau tranchant est plus sûr.' }]) },
  { slug: 'cuisson-basse-temp', title: 'Cuisson basse température', description: 'Viandes parfaites, textures sublimes. Le secret des grands chefs.', category: 'fire', skill: 'fire', difficulty: 3, icon: 'thermometer', gemCost: 50, xpReward: 180, order: 7, content: JSON.stringify([{ type: 'text', text: 'Entre 60-80°C, la cuisson est douce et homogène sans rétrécissement des protéines. Résultat : viandes d\'une tendreté incroyable.' }, { type: 'technique', title: 'Rôti basse température', text: 'Saisir à feu vif pour le Maillard, puis four à 65-75°C pendant 2-4h selon épaisseur.' }, { type: 'technique', title: 'Températures cibles', text: 'Bœuf rosé : 55-57°C. À point : 60-63°C. Poulet : 65°C min. Porc : 63°C.' }, { type: 'tip', text: 'Un thermomètre sonde est indispensable. Les temps sont indicatifs, la température à cœur est la vérité.' }]) },
  { slug: 'levures-fermentation', title: 'Levures et fermentation', description: 'Comprendre la fermentation pour un pain parfait.', category: 'baking', skill: 'baking', difficulty: 3, icon: 'activity', gemCost: 50, xpReward: 180, order: 8, content: JSON.stringify([{ type: 'text', text: 'La fermentation : des micro-organismes transforment les sucres en CO₂ et alcool, ce qui fait lever les pâtes.' }, { type: 'technique', title: 'Activer la levure', text: 'Eau tiède (30-35°C) + pincée de sucre + levure → attendre 10 min pour voir les bulles.' }, { type: 'technique', title: 'Le pointage', text: 'Première fermentation : la pâte double en 1-2h à température ambiante, ou 8-12h au réfrigérateur (pousse lente = plus de goût).' }, { type: 'tip', text: 'Ne jamais mettre levure et sel en contact direct : le sel tue la levure.' }]) },
];

async function seedLessons() {
  const count = await prisma.lesson.count();
  if (count > 0) return;
  await prisma.lesson.createMany({ data: LESSON_SEED });
  console.log(`🎓 ${LESSON_SEED.length} leçons créées`);
}

app.listen(PORT, () => {
  console.log(`🔥 CulinaRPG en ligne sur http://localhost:${PORT}`);
  seedLessons().catch(console.error);
  if (process.env.RESOLVE_IMAGES_ON_START !== 'false') {
    setTimeout(() => resolveRecipeImages(prisma, { log: (m) => console.log(m) }).catch(() => {}), 3000);
  }
  setInterval(() => prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {}), 6 * 3600 * 1000).unref();
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
