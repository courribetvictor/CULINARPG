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

// Neon cold-start : on ajoute connect_timeout si absent
const _dbUrl = (process.env.DATABASE_URL || '');
if (_dbUrl && !_dbUrl.includes('connect_timeout')) {
  process.env.DATABASE_URL = _dbUrl + (_dbUrl.includes('?') ? '&' : '?') + 'connect_timeout=30';
}

// Retry automatique sur erreurs de connexion Neon (P1001 / P1002 = cold-start)
const _baseClient = new PrismaClient();
const prisma = _baseClient.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            return await query(args);
          } catch (err) {
            const isRetryable = err.code === 'P1001' || err.code === 'P1002' || err.code === 'P1008';
            if (isRetryable && attempt < 4) {
              console.log(`⏳ DB retry ${attempt}/3 (${err.code}) — attente ${attempt * 3}s...`);
              await new Promise((r) => setTimeout(r, attempt * 3000));
            } else {
              throw err;
            }
          }
        }
      },
    },
  },
});
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

  const pendingFriendsCount = await prisma.friendship.count({ where: { addresseeId: user.id, status: 'pending' } });

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
    pendingFriendsCount,
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
    select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, avatarImage: true, totalXp: true, chefClass: true, isPro: true },
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
// Profil public & Amis
// ---------------------------------------------------------------------------
const FRIEND_USER_SELECT = { id: true, username: true, displayName: true, avatar: true, avatarColor: true, avatarImage: true, totalXp: true, isPro: true, chefClass: true };

// Recherche de joueurs par pseudo partiel (min 2 caractères)
app.get('/api/users/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);
  const users = await prisma.user.findMany({
    where: { username: { contains: q }, NOT: { id: req.user.id } },
    select: { username: true, displayName: true, avatar: true, avatarColor: true, avatarImage: true, totalXp: true, isPro: true },
    take: 6,
    orderBy: { totalXp: 'desc' },
  });
  res.json(users);
}));

app.get('/api/users/:username', wrap(async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { username: String(req.params.username).toLowerCase() },
    include: { skills: true },
  });
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });

  const skills = SKILLS.map((skill) => target.skills.find((s) => s.skill === skill) || { skill, xp: 0 });
  const [recipesCooked, uniqueRecipes, dailiesDone, bakingCooks] = await Promise.all([
    prisma.userRecipeCompletion.count({ where: { userId: target.id } }),
    prisma.userRecipeCompletion.groupBy({ by: ['recipeId'], where: { userId: target.id } }).then((g) => g.length),
    prisma.userDailyCompletion.count({ where: { userId: target.id } }),
    prisma.userRecipeCompletion.count({ where: { userId: target.id, recipe: { category: { in: ['Desserts', 'Boulangerie', 'Dessert'] } } } }),
  ]);

  let friendStatus = 'none';
  try {
    const friendship = await prisma.friendship.findFirst({
      where: { OR: [{ requesterId: req.user.id, addresseeId: target.id }, { requesterId: target.id, addresseeId: req.user.id }] },
    });
    if (friendship) {
      if (friendship.status === 'accepted') friendStatus = 'friends';
      else if (friendship.requesterId === req.user.id) friendStatus = 'pending_sent';
      else friendStatus = 'pending_received';
    }
  } catch (_) { /* table Friendship pas encore créée, on continue avec 'none' */ }

  res.json({
    id: target.id, username: target.username, displayName: target.displayName,
    avatar: target.avatar, avatarColor: target.avatarColor, avatarImage: target.avatarImage,
    chefClass: target.chefClass, isPro: target.isPro,
    title: displayTitle(target, skills),
    level: globalLevel(target.totalXp), totalXp: target.totalXp,
    global: globalProgress(target.totalXp),
    skills: skills.map((s) => ({ skill: s.skill, ...skillProgress(s.xp) })),
    badges: computeBadges({ user: target, skills, recipesCooked, uniqueRecipes, dailiesDone, bakingCooks }),
    stats: { recipesCooked, bestStreak: target.bestStreak },
    friendStatus,
  });
}));

app.get('/api/friends', wrap(async (req, res) => {
  const friendships = await prisma.friendship.findMany({
    where: { OR: [{ requesterId: req.user.id }, { addresseeId: req.user.id }] },
    include: { requester: { select: FRIEND_USER_SELECT }, addressee: { select: FRIEND_USER_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  const friends = [], pendingReceived = [], pendingSent = [];
  for (const f of friendships) {
    const other = f.requesterId === req.user.id ? f.addressee : f.requester;
    const enriched = { ...other, level: globalLevel(other.totalXp) };
    if (f.status === 'accepted') friends.push(enriched);
    else if (f.requesterId === req.user.id) pendingSent.push(enriched);
    else pendingReceived.push(enriched);
  }
  friends.sort((a, b) => b.totalXp - a.totalXp);
  res.json({ friends, pendingReceived, pendingSent });
}));

app.post('/api/friends/:username', wrap(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: String(req.params.username).toLowerCase() } });
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'ajouter toi-même' });
  const existing = await prisma.friendship.findFirst({
    where: { OR: [{ requesterId: req.user.id, addresseeId: target.id }, { requesterId: target.id, addresseeId: req.user.id }] },
  });
  if (existing) return res.status(409).json({ error: 'Demande déjà existante' });
  await prisma.friendship.create({ data: { requesterId: req.user.id, addresseeId: target.id } });
  res.json({ ok: true });
}));

app.post('/api/friends/:username/accept', wrap(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: String(req.params.username).toLowerCase() } });
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });
  const f = await prisma.friendship.findFirst({ where: { requesterId: target.id, addresseeId: req.user.id, status: 'pending' } });
  if (!f) return res.status(404).json({ error: 'Demande introuvable' });
  await prisma.friendship.update({ where: { id: f.id }, data: { status: 'accepted' } });
  res.json({ ok: true });
}));

app.delete('/api/friends/:username', wrap(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { username: String(req.params.username).toLowerCase() } });
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });
  const deleted = await prisma.friendship.deleteMany({
    where: { OR: [{ requesterId: req.user.id, addresseeId: target.id }, { requesterId: target.id, addresseeId: req.user.id }] },
  });
  if (!deleted.count) return res.status(404).json({ error: 'Relation introuvable' });
  res.json({ ok: true });
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
  const unlockMap = Object.fromEntries(unlocks.map((u) => [u.lessonId, u]));
  res.json(lessons.map((l) => ({
    id: l.id, slug: l.slug, title: l.title, description: l.description,
    category: l.category, skill: l.skill, difficulty: l.difficulty,
    icon: l.icon, gemCost: l.gemCost, xpReward: l.xpReward, order: l.order,
    unlocked: l.gemCost === 0 || req.user.isPro || !!unlockMap[l.id],
    completed: !!unlockMap[l.id]?.completed,
  })));
}));

app.get('/api/lessons/:id', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const unlock = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  const accessible = lesson.gemCost === 0 || req.user.isPro || !!unlock;
  if (!accessible) return res.status(403).json({ error: 'Leçon verrouillée', gemCost: lesson.gemCost, gems: req.user.gems });
  res.json({ ...lesson, content: JSON.parse(lesson.content), completed: !!unlock?.completed });
}));

// Déverrouille l'accès à une leçon (déduit les gemmes, pas d'XP)
app.post('/api/lessons/:id/unlock', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const existing = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  if (existing) return res.json({ ok: true, alreadyUnlocked: true, gems: req.user.gems });
  if (lesson.gemCost > 0 && !req.user.isPro) {
    if (req.user.gems < lesson.gemCost) {
      return res.status(402).json({ error: `Gemmes insuffisantes (${req.user.gems}/${lesson.gemCost})`, gems: req.user.gems });
    }
    await prisma.user.update({ where: { id: req.user.id }, data: { gems: { decrement: lesson.gemCost } } });
  }
  await prisma.userLessonUnlock.create({ data: { userId: req.user.id, lessonId: lesson.id } });
  const updatedUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { gems: true } });
  res.json({ ok: true, gems: updatedUser.gems });
}));

// Marque une leçon comme complétée et accorde l'XP
app.post('/api/lessons/:id/complete', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'Leçon introuvable' });
  const unlock = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  const accessible = lesson.gemCost === 0 || req.user.isPro || !!unlock;
  if (!accessible) return res.status(403).json({ error: 'Leçon verrouillée' });
  if (unlock?.completed) return res.status(409).json({ error: 'Leçon déjà complétée' });
  if (!unlock) {
    await prisma.userLessonUnlock.create({ data: { userId: req.user.id, lessonId: lesson.id, completed: true, completedAt: new Date() } });
  } else {
    await prisma.userLessonUnlock.update({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } }, data: { completed: true, completedAt: new Date() } });
  }
  const xpResult = await grantXp(req.user.id, { [lesson.skill]: lesson.xpReward });
  res.json({ ok: true, xpResult });
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
  // Juste déverrouiller l'accès — l'XP est accordé quand le joueur clique "J'ai compris !"
  await prisma.userLessonUnlock.create({ data: { userId, lessonId: lesson.id } });
  return { ok: true };
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
    const result = await fulfillLesson(req.user.id, lesson);
    if (!result) return res.status(409).json({ error: 'Leçon déjà débloquée' });
    return res.json({ simulated: true });
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
  console.error('[ERR]', err.code || '', err.message || err);
  // Erreurs Stripe : renvoyer le message pour faciliter le diagnostic
  if (err.type && err.type.startsWith('Stripe')) return res.status(402).json({ error: err.message });
  // Base de données inaccessible (Neon cold-start / réseau)
  if (err.code === 'P1001' || err.code === 'P1002' || err.code === 'P1008') {
    return res.status(503).json({ error: 'Service temporairement indisponible. Réessayez dans quelques secondes.' });
  }
  return res.status(err.status || 500).json({ error: 'Erreur serveur' });
});

// ---------------------------------------------------------------------------
// Seed leçons (au démarrage si la table est vide)
// ---------------------------------------------------------------------------
const LESSON_SEED = [
  {
    slug: 'coupes-essentielles',
    title: 'Les coupes essentielles',
    description: 'Julienne, brunoise, chiffonnade… maîtrise les 6 coupes de base avec précision.',
    category: 'knife', skill: 'knife', difficulty: 1, icon: 'scissors', gemCost: 0, xpReward: 80, order: 1,
    content: JSON.stringify([
      { type: 'text', text: 'Le couteau est le prolongement de ta main. Avant de maîtriser les sauces, les cuissons ou la pâtisserie, tu dois maîtriser les coupes. Chaque taille a une utilité précise : uniformité de cuisson, esthétique du plat, texture en bouche.' },
      { type: 'heading', text: 'La prise en main correcte' },
      { type: 'technique', title: 'La prise "en pince"', text: 'Pince la lame entre le pouce et l\'index, juste devant le manche. Les autres doigts tiennent le manche. C\'est la prise standard des cuisiniers professionnels : elle offre contrôle, précision et réduction de la fatigue.' },
      { type: 'technique', title: 'La "griffe de chat"', text: 'Les doigts de la main qui tient l\'aliment sont repliés : les premières phalanges touchent la lame et guident la coupe, les bouts des doigts sont en retrait. La lame glisse contre les phalanges — jamais contre les ongles.' },
      { type: 'warning', text: 'Ne jamais couper avec le poignet. Le mouvement vient de l\'épaule et du coude. Le couteau bascule d\'avant en arrière, la pointe reste en contact avec la planche.' },
      { type: 'heading', text: 'Les 6 coupes fondamentales' },
      { type: 'technique', title: 'Émincer', text: 'Tranches fines et régulières, 1 à 3 mm. Technique de base pour oignons, champignons, courgettes. Objectif : régularité absolue pour une cuisson homogène.' },
      { type: 'technique', title: 'Julienne', text: 'Bâtonnets de 3×3×50 mm. On commence par des tranches de 3 mm d\'épaisseur, puis on les empile et on taille en bâtonnets. Idéale pour légumes sautés, salades croquantes, garnitures.' },
      { type: 'technique', title: 'Brunoise', text: 'Dés de 3×3×3 mm. On part d\'une julienne qu\'on coupe perpendiculairement tous les 3 mm. Parfaite pour les sauces, farces, soupes. La brunoise fine (1×1×1 mm) est réservée aux grandes tables.' },
      { type: 'technique', title: 'Mirepoix', text: 'Dés grossiers de 1 à 2 cm. Carottes, céleri, oignon. Utilisée comme base aromatique pour bouillons, braises et ragoûts — la taille n\'a pas besoin d\'être parfaite, les légumes finissent souvent retirés.' },
      { type: 'technique', title: 'Chiffonnade', text: 'Feuilles (basilic, salade, oseille, menthe) empilées, roulées en cigare, puis coupées en fines lanières. Ne jamais hacher les herbes fragiles — la pression du couteau les oxyde et les noircit.' },
      { type: 'technique', title: 'Ciseler', text: 'Couper l\'oignon ou l\'échalote en petits dés fins sans les séparer. On incise d\'abord horizontalement (sans couper la racine), puis verticalement, puis on tranche. La racine maintient l\'oignon en place jusqu\'à la fin.' },
      { type: 'heading', text: 'Ton matériel' },
      { type: 'tip', text: 'Un couteau de chef 20 cm bien affûté fait 90 % du travail. Aiguise-le avant chaque usage avec un fusil ou une pierre. Un couteau émoussé demande plus de force, ce qui augmente le risque de glissement.' },
      { type: 'tip', text: 'Planche en bois ou en plastique épaisse. Jamais de verre ou de marbre — ils abîment le fil du couteau instantanément. Glisse un torchon humide sous la planche pour l\'empêcher de bouger.' },
      { type: 'warning', text: 'Ne jamais mettre ses couteaux au lave-vaisselle. La chaleur, l\'humidité et les chocs abîment le bois du manche et ramollissent le métal. Laver à la main, sécher immédiatement.' },
      { type: 'recap', text: 'Émincer → tranches fines. Julienne → bâtonnets. Brunoise → petits dés. Mirepoix → gros dés aromatiques. Chiffonnade → herbes en lanières. Ciseler → oignons en dés sans les séparer.' },
      { type: 'exercise', text: 'Prends une carotte. Taille-la en julienne (bâtonnets 3×3×50 mm), puis coupe ces bâtonnets en brunoise (3×3×3 mm). Compte le temps. Objectif : moins de 3 minutes avec des dés réguliers.' },
    ]),
  },
  {
    slug: 'mise-en-place',
    title: 'La mise en place',
    description: 'L\'art de l\'organisation. Prépare comme un pro, cuisine sans stress ni improvisation.',
    category: 'prep', skill: 'prep', difficulty: 1, icon: 'layout-grid', gemCost: 0, xpReward: 80, order: 2,
    content: JSON.stringify([
      { type: 'text', text: '"Mise en place" — littéralement "mettre en place" — est le principe fondateur de toute cuisine professionnelle. C\'est l\'art de préparer, organiser et disposer chaque ingrédient, outil et équipement avant d\'allumer le feu. Sans elle, on improvise. Avec elle, on cuisine.' },
      { type: 'heading', text: 'Avant de commencer : lire et planifier' },
      { type: 'technique', title: 'Lire la recette en entier', text: 'Pas juste les ingrédients — la recette complète, deux fois. Identifie les temps de repos (pâte à laisser lever, viande à mariner, crème à refroidir), les étapes parallèles et les équipements spéciaux (thermomètre, film alimentaire, poche à douille).' },
      { type: 'technique', title: 'Dresser la liste du matériel', text: 'Couteaux, planches, casseroles, saladiers, tamis, spatules… Tout sortir avant de commencer. Rien de plus frustrant que de chercher une écumoire alors que la sauce est en train de brûler.' },
      { type: 'tip', text: 'Identifie les étapes critiques qui ne pardonnent pas l\'improvisation : monter une mayonnaise, tempérer du chocolat, cuire un caramel. Ces étapes demandent 100 % de ton attention. Tout le reste doit être prêt avant.' },
      { type: 'heading', text: 'Préparer les ingrédients' },
      { type: 'technique', title: 'Peser et mesurer', text: 'Tous les ingrédients pesés et disposés dans des bols ou ramequins avant de commencer. En cuisine professionnelle, on appelle ça les "bols de mis en place". Ça évite les erreurs de dosage et permet de cuisiner sans interruption.' },
      { type: 'technique', title: 'Préparer dans l\'ordre d\'utilisation', text: 'Commence par les ingrédients qui prennent le plus de temps à préparer (légumes à tailler, viande à mariner) et termine par ceux qui s\'utilisent en dernier. Regrouper les ingrédients par étape de la recette.' },
      { type: 'technique', title: 'Étiqueter si nécessaire', text: 'Pour les préparations à l\'avance (bouillon, fond, crème), couvre avec du film et étiquette : contenu + date. En cuisine pro, on date systématiquement. Chez toi, ça évite de "goûter pour deviner".' },
      { type: 'warning', text: 'Ne jamais laisser des protéines crues (viande, poisson) à température ambiante plus de 20 minutes. Prépare-les en dernier et remets-les au frais si la recette le permet.' },
      { type: 'heading', text: 'Organiser l\'espace de travail' },
      { type: 'technique', title: 'Zone propre / zone sale', text: 'Délimite mentalement ta planche (zone de travail propre) et un côté "déchets" où vont les épluchures et parures. Ne jamais mettre de déchets sur la zone de travail propre.' },
      { type: 'technique', title: 'Nettoyer au fur et à mesure', text: 'Après chaque préparation, essuie la planche, range les bols vides, jette les déchets. Un plan de travail encombré ralentit et génère des erreurs. C\'est ce qu\'on appelle "clean as you go".' },
      { type: 'tip', text: 'Garde un torchon propre sur l\'épaule (comme les chefs) pour essuyer tes mains, nettoyer les rebords des plats, saisir les poignées chaudes. Change-le souvent : un torchon sale est une source de contamination.' },
      { type: 'tip', text: 'Préchauffer le four, faire bouillir l\'eau, sortir le beurre du frigo à l\'avance font partie de la mise en place. Le thermomètre du four ment souvent — laisse 15 min de plus que la recette recommande.' },
      { type: 'recap', text: 'Lire en entier → peser tous les ingrédients → préparer dans l\'ordre → organiser l\'espace → nettoyer au fur et à mesure. La mise en place transforme une session stressante en cuisine fluide et maîtrisée.' },
      { type: 'exercise', text: 'Choisis une recette de 4-5 étapes. Avant d\'allumer quoi que ce soit, prépare et dispose tous les ingrédients en bols. Lis chaque étape et imagine-la mentalement. Puis cuisine. Compare le stress et le résultat avec ta façon de cuisiner habituelle.' },
    ]),
  },
  {
    slug: 'aromates-de-base',
    title: 'Les aromates de base',
    description: 'Les 5 piliers du goût, herbes, épices, zestes : construire la profondeur d\'un plat.',
    category: 'seasoning', skill: 'seasoning', difficulty: 1, icon: 'leaf', gemCost: 0, xpReward: 80, order: 3,
    content: JSON.stringify([
      { type: 'text', text: 'L\'assaisonnement est l\'art de construire l\'équilibre. Un plat fade n\'est pas un plat sans sel — c\'est un plat sans complexité. Les cinq piliers du goût sont : le salé, l\'acide, le sucré, l\'amer et l\'umami. Comprendre comment les doser et les combiner transforme radicalement ta cuisine.' },
      { type: 'heading', text: 'Les 5 piliers du goût' },
      { type: 'technique', title: 'Le salé — amplificateur universel', text: 'Le sel ne sale pas seulement : il amplifie tous les autres arômes. Sel fin pour assaisonner en cours de cuisson, fleur de sel pour finir. Saler en plusieurs fois, dès le début (légumes, eau de cuisson, sauces), pas uniquement à la fin.' },
      { type: 'technique', title: 'L\'acidité — le révélateur', text: 'Un filet de citron, une cuillère de vinaigre ou un verre de vin blanc après la cuisson "ouvre" les saveurs d\'un plat qui semblait fade. L\'acide équilibre aussi les plats trop gras ou trop sucrés. Sources : citron, vinaigre (balsamique, de vin, de cidre), tomate, yaourt.' },
      { type: 'technique', title: 'Le sucré — équilibreur', text: 'Une pincée de sucre dans une sauce tomate acide ou une réduction de vinaigre balsamique change tout. Le sucré atténue l\'amertume et l\'acidité. Ne jamais en mettre trop — le but est de ne pas sentir le sucre, juste de gommer un déséquilibre.' },
      { type: 'technique', title: 'L\'umami — la profondeur', text: 'Saveur de "5e goût" : bouillon réduit, parmesan, champignons séchés, sauce soja, tomate concentrée, anchois. L\'umami donne la sensation de plat "qui a du fond". Une cuillère de parmesan râpé dans une soupe de légumes la transforme complètement.' },
      { type: 'technique', title: 'L\'amer — la sophistication', text: 'Café, chocolat noir, radicchio, endive, zeste. L\'amer en petite dose apporte complexité et équilibre le sucré. En excès, il domine tout. Le beurre, le gras ou le sucré adoucissent un amer trop prononcé.' },
      { type: 'heading', text: 'Herbes aromatiques' },
      { type: 'technique', title: 'Herbes fragiles — en fin de cuisson', text: 'Basilic, coriandre, persil plat, ciboulette, estragon, menthe. La chaleur détruit leurs arômes volatils en quelques secondes. Les ajouter hors du feu, juste avant de servir. Le basilic noircit aussi par pression — ciseler, jamais hacher.' },
      { type: 'technique', title: 'Herbes robustes — en début de cuisson', text: 'Thym, romarin, sauge, laurier, origan. Leurs huiles essentielles résistent à la chaleur et se libèrent avec le temps. Les ajouter en début de cuisson pour une infusion progressive dans la matière grasse ou le liquide.' },
      { type: 'tip', text: 'Le bouquet garni classique (thym + laurier + queue de persil) est la base de 80 % des plats mijotés français. On le met au début, on le retire avant de servir.' },
      { type: 'heading', text: 'Épices et zestes' },
      { type: 'technique', title: 'Torréfier les épices', text: 'Passer les épices entières 1-2 minutes à sec dans une poêle chaude avant de les moudre. La chaleur libère les huiles essentielles et multiplie leur intensité. Indispensable pour cumin, coriandre, cardamome, poivre.' },
      { type: 'technique', title: 'Les zestes d\'agrumes', text: 'Ne prélever que la partie colorée, jamais le blanc (albédo) qui est amer. Zester au-dessus du plat pour capturer les huiles essentielles qui s\'en échappent. Une pincée de zeste de citron dans un risotto, une vinaigrette ou une crème change la dimension du plat.' },
      { type: 'warning', text: 'Ne jamais assaisonner une viande crue et la laisser reposer longtemps avec du sel — il commence à "cuire" les protéines et peut assécher la chair. Saler juste avant la cuisson, ou au moins 40 minutes avant (saumurage à sec).' },
      { type: 'tip', text: 'La règle d\'or : goûte toujours avant de servir. Ton nez peut te dire si un plat manque d\'acidité ou d\'umami, mais seule ta bouche peut confirmer l\'équilibre final. Goûte et rectifie.' },
      { type: 'recap', text: 'Sel → amplifie. Acide → révèle et équilibre. Sucré → adoucit. Umami → donne de la profondeur. Amer → complexifie. Herbes fragiles en fin, robustes en début. Toujours goûter avant de servir.' },
      { type: 'exercise', text: 'Prépare un bouillon de légumes simple (eau + carotte + oignon + céleri). Goûte à blanc. Ajoute du sel progressivement, goûte. Puis un filet de citron, goûte. Puis une pincée de parmesan râpé, goûte. Observe comment chaque ajout transforme la perception du plat.' },
    ]),
  },
  {
    slug: 'bases-patisserie',
    title: 'Les bases de la pâtisserie',
    description: 'Crèmes incontournables, pâtes fondamentales, règles d\'or du four.',
    category: 'baking', skill: 'baking', difficulty: 2, icon: 'cake', gemCost: 30, xpReward: 120, order: 4,
    content: JSON.stringify([
      { type: 'text', text: 'La pâtisserie est une science exacte. Là où la cuisine tolère l\'improvisation, la pâtisserie exige précision, température et timing. Maîtriser les crèmes de base et les pâtes fondamentales, c\'est avoir les clés de 90 % des desserts classiques.' },
      { type: 'heading', text: 'Règles d\'or avant de commencer' },
      { type: 'technique', title: 'Peser, ne pas mesurer en volume', text: 'En pâtisserie, "une tasse de farine" peut varier de 120 à 160 g selon la façon dont on tasse. Toujours peser. Une balance de précision au gramme est l\'investissement le plus rentable en pâtisserie.' },
      { type: 'technique', title: 'Température des ingrédients', text: 'Beurre "pommade" = 18-20°C, malléable mais pas fondu. Œufs à température ambiante = meilleure émulsion. Crème froide = monte mieux en chantilly. La température des ingrédients n\'est pas un détail, c\'est une variable critique.' },
      { type: 'tip', text: 'Préchauffer le four 20 min minimum. La plupart des fours domestiques mettent 15 min à atteindre la température affichée — et ils mentent souvent de 10 à 20°C. Un thermomètre de four (5€) est indispensable.' },
      { type: 'heading', text: 'Les crèmes fondamentales' },
      { type: 'technique', title: 'Crème pâtissière', text: 'Base des éclairs, millefeuilles, tartes aux fruits. Recette : 500 ml lait + 4 jaunes + 100 g sucre (blanchir) + 50 g fécule de maïs. Porter le lait à frémissement, verser en filet sur le mélange jaunes/sucre/fécule sans cesser de fouetter, puis remettre sur feu moyen en remuant jusqu\'à épaississement (85°C). Film au contact, refroidir.' },
      { type: 'technique', title: 'Crème chantilly', text: 'Crème entière (min 30% MG) très froide, bol et fouet au congélateur 10 min. Fouetter à vitesse moyenne jusqu\'à traces molles, puis rapide jusqu\'à consistance ferme. Ajouter le sucre glace à mi-parcours. S\'arrêter à la bonne texture — 30 secondes de trop et c\'est du beurre.' },
      { type: 'technique', title: 'Crème anglaise', text: 'Base des glaces et des îles flottantes. 500 ml lait + 5 jaunes + 100 g sucre. Blanchir les jaunes avec le sucre, verser le lait chaud, cuire à la nappe (82-84°C) : la crème nappe la cuillère et le trait du doigt tient. Ne jamais dépasser 85°C — les jaunes coagulent et font des grumeaux.' },
      { type: 'warning', text: 'La crème pâtissière trop cuite ou mal remuée forme des grumeaux. Si ça arrive, passe au tamis fin ou au mixeur plongeant. La crème anglaise au-delà de 85°C tourne en scrambled eggs — c\'est irréparable.' },
      { type: 'heading', text: 'Les pâtes de base' },
      { type: 'technique', title: 'Pâte brisée', text: 'Pour tartes salées et sucrées non-garnies. 250 g farine + 125 g beurre froid en dés + 1 pincée sel + 60 ml eau glacée. Sabler (frotter beurre + farine entre les paumes jusqu\'à texture sable), puis lier avec l\'eau minimum. Ne pas pétrir : former une boule sans travailler. 1h au frais minimum.' },
      { type: 'technique', title: 'Pâte sucrée', text: 'Pour tartes sucrées et fonds de gâteaux. 250 g farine + 150 g beurre pommade + 100 g sucre glace + 1 jaune + 1 pincée sel. Crémer beurre + sucre, ajouter le jaune, puis la farine en une fois. Fraiser (pousser la pâte contre le plan de travail) une fois, filmer, réfrigérer 1h. Plus fragile que la brisée, ne pas trop travailler.' },
      { type: 'technique', title: 'Génoise', text: 'Base des biscuits de Savoie, bûches, entremets. 4 œufs + 120 g sucre (au bain-marie jusqu\'à 50°C, monter au ruban) + 120 g farine tamisée (incorporer en pluie en 3 fois en soulevant). Four 180°C, 20-25 min. Ne pas ouvrir le four avant 18 min.' },
      { type: 'tip', text: 'Pour vérifier la cuisson d\'un biscuit ou d\'un gâteau : piquer avec un couteau ou une aiguille. Il doit ressortir sec. Si la pointe ressort humide, prolonger par tranches de 3 minutes.' },
      { type: 'warning', text: 'Ne jamais ouvrir le four en cours de cuisson d\'une génoise ou d\'un soufflé — le choc thermique fait retomber la préparation. Attendre 80 % du temps de cuisson indiqué avant de vérifier.' },
      { type: 'recap', text: 'Crème pâtissière : liaison chaude à 85°C, film au contact. Chantilly : crème froide, arrêter au bon moment. Pâte brisée : sabler, lier minimum, ne pas pétrir. Pâte sucrée : crémer, fraiser, refroidir. Génoise : œufs montés, farine en pluie.' },
      { type: 'exercise', text: 'Réalise une crème pâtissière. Couvre-la d\'un film au contact, laisse refroidir 1h au réfrigérateur. Elle doit être lisse, sans grumeaux, et suffisamment ferme pour tenir sur une cuillère retournée. C\'est la base de ta première tarte aux fraises.' },
    ]),
  },
  {
    slug: 'maitrise-saisie',
    title: 'Maîtriser la saisie',
    description: 'La réaction de Maillard, la croûte parfaite, le repos : tout sur la cuisson des protéines.',
    category: 'fire', skill: 'fire', difficulty: 2, icon: 'flame', gemCost: 30, xpReward: 120, order: 5,
    content: JSON.stringify([
      { type: 'text', text: 'La saisie est l\'une des techniques les plus mal exécutées en cuisine amateur. Résultat : une viande grise, bouillie dans son jus, sans croûte. Pourtant, les règles sont simples. Les comprendre transforme immédiatement tes cuissons.' },
      { type: 'heading', text: 'La réaction de Maillard' },
      { type: 'technique', title: 'Ce qui se passe chimiquement', text: 'À partir de 150°C, les acides aminés et les sucres réducteurs en surface réagissent pour former des centaines de molécules aromatiques : c\'est la réaction de Maillard. Elle crée la croûte dorée, les arômes de grillé, la saveur umami de la viande bien saisie. Ce n\'est pas une "caramélisation" — c\'est une réaction de brunissement non enzymatique.' },
      { type: 'warning', text: 'Si la poêle n\'est pas assez chaude, la viande libère de l\'eau avant d\'atteindre 150°C. L\'eau forme de la vapeur qui empêche le contact avec la surface. Résultat : la viande cuit à la vapeur, devient grise, pas de croûte. C\'est l\'erreur n°1.' },
      { type: 'heading', text: 'Préparer la saisie' },
      { type: 'technique', title: 'Choisir la bonne poêle', text: 'Fonte ou acier : conduisent et retiennent mieux la chaleur que l\'inox. L\'inox convient mais demande plus de vigilance. Antiadhésif : uniquement pour les préparations délicates (poisson, œufs). Pour les viandes, éviter — il ne monte pas assez chaud.' },
      { type: 'technique', title: 'Préchauffer correctement', text: 'Feu vif, 3 à 4 minutes à vide. Test : quelques gouttes d\'eau doivent s\'évaporer instantanément en crépitant (effet Leidenfrost). Ajouter la matière grasse 30 secondes avant la viande : huile à haute température de fumée (arachide, pépins de raisin) ou beurre clarifié.' },
      { type: 'technique', title: 'Sécher la surface', text: 'Essuyer la viande avec du papier absorbant avant de saisir. L\'humidité en surface = vapeur = pas de Maillard. Pour un résultat optimal, laisser la viande à découvert au réfrigérateur 1h avant cuisson (sèche à l\'air).' },
      { type: 'tip', text: 'Sortir la viande du réfrigérateur 20-30 min avant cuisson. Une viande froide refroidit la poêle dès le contact et peut empêcher la saisie de démarrer correctement, surtout pour les pièces épaisses.' },
      { type: 'heading', text: 'Pendant la cuisson' },
      { type: 'technique', title: 'Ne pas bouger la pièce', text: 'Déposer et ne pas toucher pendant 2-3 min. La viande adhère à la poêle au début, puis se décolle seule quand la croûte est formée. Si elle résiste quand tu essaies de la déplacer, c\'est qu\'elle n\'est pas prête — attends.' },
      { type: 'technique', title: 'L\'arrosage au beurre (basting)', text: 'En fin de saisie : ajouter une noix de beurre, thym, ail écrasé. Incliner la poêle et arroser continuellement la viande avec le beurre fondu à l\'aide d\'une cuillère. Dore et parfume à la fois — technique des chefs pour les steaks et côtes de veau.' },
      { type: 'technique', title: 'Les températures à cœur', text: 'Bœuf bleu : 45-48°C. Saignant : 50-52°C. Rosé : 55-57°C. À point : 60-63°C. Bien cuit : >68°C. Poulet min : 74°C. Porc : 65°C. Poisson mi-cuit : 45-50°C. Sans thermomètre sonde, la cuisson parfaite est impossible à reproduire.' },
      { type: 'heading', text: 'Le repos — étape cruciale oubliée' },
      { type: 'technique', title: 'Pourquoi laisser reposer', text: 'Pendant la cuisson, les jus migrent vers le centre. En reposant sur une grille (jamais sur une surface froide), les fibres musculaires se relâchent et les jus se redistribuent. Sans repos, ils coulent dans l\'assiette. Règle : le temps de repos = la moitié du temps de cuisson, minimum 5 minutes.' },
      { type: 'tip', text: 'Couvrir la viande lâchement avec du papier aluminium pendant le repos — pas hermétiquement (la vapeur ramolle la croûte). L\'intérieur continue à cuire légèrement : prévoir 2-3°C de moins que la température cible.' },
      { type: 'recap', text: 'Poêle très chaude + viande sèche = réaction de Maillard. Ne pas bouger = croûte qui se décolle seule. Température à cœur avec thermomètre. Repos = jus redistribués. Ces 4 règles changent tout.' },
      { type: 'exercise', text: 'Prends un steak ou un blanc de poulet. Sèche la surface au papier absorbant, préchauffe ta poêle 3 min à feu vif. Saisis sans bouger, puis arroge au beurre. Mesure la température à cœur avec un thermomètre. Laisse reposer 5 min. Compare avec ta saisie habituelle.' },
    ]),
  },
  {
    slug: 'coupes-avancees',
    title: 'Coupes avancées',
    description: 'Tournée, jardinière, paysanne, mandoline : les coupes qui impressionnent et servent.',
    category: 'knife', skill: 'knife', difficulty: 2, icon: 'git-branch', gemCost: 30, xpReward: 120, order: 6,
    content: JSON.stringify([
      { type: 'text', text: 'Après les coupes de base, voici les tailles qui font la différence dans un plat professionnel. Elles servent deux objectifs : l\'esthétique (présentation) et la fonctionnalité (cuisson homogène, texture en bouche). Une carotte tournée cuit à la même vitesse qu\'une autre carotte tournée — la précision n\'est pas uniquement décorative.' },
      { type: 'heading', text: 'Coupes utilitaires' },
      { type: 'technique', title: 'Paysanne', text: 'Tranches de légumes de forme irrégulière (triangles, carrés, demi-cercles), 3-4 mm d\'épaisseur. Coupe rustique pour soupes et ragoûts — la forme importe peu, l\'uniformité d\'épaisseur est clé pour une cuisson égale. Technique rapide, parfaite pour les préparations mijotées.' },
      { type: 'technique', title: 'Jardinière', text: 'Bâtonnets de 4×4×20 mm. Entre la julienne (fine) et la mirepoix (grosse). Idéale pour les légumes d\'accompagnement sautés ou à la vapeur — assez petite pour cuire vite, assez grosse pour avoir de la mâche. Base des bouquets de légumes glacés.' },
      { type: 'technique', title: 'En losanges / biais', text: 'Couper en diagonale à 45°, en tranches de 3-5 mm. Donne des formes oblongues élégantes. Utilisé pour carottes, courgettes, poireaux, asperges. L\'avantage : plus de surface exposée à la chaleur = cuisson plus rapide et plus de brunissement.' },
      { type: 'technique', title: 'Ciseler finement les échalotes', text: 'Couper l\'échalote en deux, côté plat sur la planche. Incisions horizontales parallèles à la planche (sans couper la racine), puis incisions verticales rapprochées, puis trancher perpendiculairement. Résultat : brunoise fine d\'échalote en quelques secondes.' },
      { type: 'heading', text: 'La taille tournée' },
      { type: 'technique', title: 'Légumes tournés', text: 'Tailler en forme de football américain à 7 facettes égales, 4-5 cm de long. Technique classique de la cuisine française pour les carottes, navets, pommes de terre. On utilise un couteau à tourner (ou un office). Tenir le légume entre pouce et index, tourner le légume vers soi en incisant. C\'est la taille la plus difficile — la régularité vient avec la pratique.' },
      { type: 'tip', text: 'Les chutes des légumes tournés ne sont pas perdues : elles servent pour les bouillons, les purées ou les veloutés. En cuisine professionnelle, rien ne se jette.' },
      { type: 'heading', text: 'La mandoline' },
      { type: 'technique', title: 'Utiliser une mandoline', text: 'Pour les tranches ultra-fines (1-2 mm) impossibles au couteau : fenouil, betterave, radis, courgette. Toujours utiliser le protège-doigts fourni, jamais les mains nues. Mouvement régulier, pression constante. La lame est chirurgicale — même une coupure légère est profonde.' },
      { type: 'warning', text: 'La mandoline est l\'outil le plus dangereux de la cuisine. Aucune exception : toujours le protège-doigts. Quand le légume devient trop petit pour être tenu en sécurité, s\'arrêter — la chute n\'est pas un luxe.' },
      { type: 'heading', text: 'Entretien du couteau' },
      { type: 'technique', title: 'Affûtage au fusil', text: 'Avant chaque utilisation : 5-6 passes de chaque côté au fusil à 20°. Le fusil réaligne le fil sans enlever de métal. Il "rafraîchit" le tranchant entre les affûtages profonds.' },
      { type: 'technique', title: 'Affûtage à la pierre', text: 'Tous les 2-3 mois selon l\'usage. Pierre grain 1000 (affûtage) puis grain 3000-6000 (finition). Angle constant à 15-20° selon le couteau. Ajouter de l\'eau ou de l\'huile selon la pierre. 10-15 passes de chaque côté, puis finir au fusil.' },
      { type: 'tip', text: 'Test du papier : un couteau bien affûté coupe une feuille de papier en un seul mouvement, sans déchirer. Test de la tomate : si la tomate s\'écrase au lieu d\'être tranchée, le couteau est émoussé.' },
      { type: 'recap', text: 'Paysanne → rustique, soupe. Jardinière → sauté, accompagnement. Biais → légumes élégants, plus de surface. Tournée → présentation classique. Mandoline → ultra-fine avec protège-doigts OBLIGATOIRE.' },
      { type: 'exercise', text: 'Taille 3 carottes en jardinière (4×4×20 mm). Puis taille 2 tranches de fenouil à la mandoline (2 mm). Observe la différence de régularité entre le couteau et la mandoline. Fais sauter les carottes à la poêle — leur cuisson est uniforme ? Si non, tes tailles n\'étaient pas assez régulières.' },
    ]),
  },
  {
    slug: 'cuisson-basse-temp',
    title: 'Cuisson basse température',
    description: 'La science de la cuisson douce : températures, timing, technique du bain-marie.',
    category: 'fire', skill: 'fire', difficulty: 3, icon: 'thermometer', gemCost: 50, xpReward: 180, order: 7,
    content: JSON.stringify([
      { type: 'text', text: 'La cuisson basse température est l\'une des révolutions de la cuisine moderne. Entre 55 et 80°C, les protéines coagulent sans se contracter violemment. Résultat : viandes d\'une tendreté exceptionnelle, jus conservés, textures impossibles à obtenir à feu vif. C\'est la technique des cuisiniers étoilés — et elle est accessible.' },
      { type: 'heading', text: 'La science derrière' },
      { type: 'technique', title: 'Pourquoi les protéines durcissent à la chaleur', text: 'À haute température (>70°C), les fibres musculaires se contractent fortement et expulsent leur eau. C\'est pour ça qu\'une côte de bœuf bien cuite est sèche. En dessous de 65°C, les fibres coagulent mais restent souples, les jus restent à l\'intérieur. La différence de 10°C change tout.' },
      { type: 'technique', title: 'Le collagène et le temps', text: 'Les morceaux durs (paleron, joue, jarret) sont riches en collagène. Ce collagène se transforme en gélatine à partir de 70°C — mais seulement avec le temps (3-8 heures). C\'est pourquoi un bœuf bourguignon mijoté 3h est fondant alors qu\'une côte de bœuf à 70°C pendant 20 min serait sèche.' },
      { type: 'heading', text: 'Températures cibles par protéine' },
      { type: 'technique', title: 'Bœuf et agneau', text: 'Bleu : 45-48°C. Saignant : 50-52°C. Rosé (recommandé) : 55-57°C. À point : 60-63°C. Bien cuit : >68°C. Pour un rôti basse température : four à 65°C, temps calculé selon l\'épaisseur (30 min par cm). Toujours terminer par une saisie à feu vif pour la croûte.' },
      { type: 'technique', title: 'Volaille', text: 'Poulet minimum 74°C (sécurité alimentaire). Canard magret rosé : 58-60°C. Dinde entière : 74°C à cœur dans la partie la plus épaisse (cuisse). La volaille est moins indulgente que le bœuf — ne pas descendre sous les seuils de sécurité.' },
      { type: 'technique', title: 'Poisson', text: 'Mi-cuit (nacré) : 45-50°C. Cuit à cœur : 55-60°C. Le poisson est extrêmement sensible : 5°C de trop et les protéines se désagrègent. Le bain-marie au four à 60°C est idéal pour un saumon entier ou un filet épais.' },
      { type: 'technique', title: 'Porc et veau', text: 'Porc rosé : 63°C (OMS 2011, revu à la baisse de 71°C). Veau rosé : 58-60°C. Le filet de porc à basse température reste rosé et incroyablement juteux — à l\'opposé du filet sec et gris de la cuisson traditionnelle.' },
      { type: 'heading', text: 'Techniques pratiques sans matériel pro' },
      { type: 'technique', title: 'Méthode four + thermomètre', text: 'Four à 65-75°C (chaleur tournante). Saisir la pièce en cocotte à feu vif pour le Maillard. Enfourner avec thermomètre sonde, alarme réglée sur la température cible moins 3°C (la cuisson continue après sortie). Temps indicatif : 30-45 min par cm d\'épaisseur.' },
      { type: 'technique', title: 'Le bain-marie au four', text: 'Pour les poissons et préparations délicates. Plat dans un bain d\'eau chaude (80°C), four à 80-90°C. L\'eau ne dépasse jamais 100°C et régule parfaitement la température. Idéal pour terrine, pâté, crème brûlée, saumon entier.' },
      { type: 'technique', title: 'La glacière comme bain-marie', text: 'Pour maintenir une température précise sans matériel : remplir une glacière d\'eau à la bonne température (vérifier avec thermomètre). Immerger la pièce emballée sous vide (sac congélation zip avec l\'air chassé). Surveiller toutes les 30 min. Technique "pauvre" mais efficace pour les cuissons longues.' },
      { type: 'warning', text: 'Ne jamais maintenir un aliment dans la zone de danger : 4°C à 60°C est la plage de développement des bactéries. Les cuissons basse température autour de 55°C doivent être courtes (<4h) ou utiliser une pasteurisation précise. Pour les longues cuissons (>4h), rester à 65°C minimum.' },
      { type: 'tip', text: 'Un thermomètre sonde à lecture instantanée (15-30€) est l\'investissement qui change le plus la cuisine. Il rend la cuisson reproductible. Sans lui, même un chef expérimenté ne peut garantir un résultat constant.' },
      { type: 'recap', text: 'Protéines < 65°C = tendres et juteuses. Collagène + temps = gélatine fondante. Saisie avant ou après pour la croûte. Thermomètre indispensable. Ne pas rester en zone 4-60°C plus de 4h. Four + bain-marie = technique accessible sans matériel pro.' },
      { type: 'exercise', text: 'Cuis un filet de saumon épais (3 cm) au bain-marie : four à 80°C, plat dans de l\'eau chaude, 20-25 min. Contrôle la température à cœur : 48-50°C pour mi-cuit nacré. Compare la texture avec un saumon cuit à la poêle à feu vif. La différence est radicale.' },
    ]),
  },
  {
    slug: 'levures-fermentation',
    title: 'Levures et fermentation',
    description: 'Levures, gluten, pointage, apprêt : comprendre la biologie du pain pour le maîtriser.',
    category: 'baking', skill: 'baking', difficulty: 3, icon: 'activity', gemCost: 50, xpReward: 180, order: 8,
    content: JSON.stringify([
      { type: 'text', text: 'Faire du pain, c\'est travailler avec du vivant. La levure est un champignon microscopique qui transforme les sucres en CO₂ et en alcool. Ce gaz fait lever la pâte, l\'alcool s\'évapore à la cuisson. Comprendre ce processus biologique te permet de contrôler le résultat au lieu de subir la fermentation.' },
      { type: 'heading', text: 'Les types de levures' },
      { type: 'technique', title: 'Levure boulangère fraîche', text: 'Levure fraîche (cube gris) : 20-25 g pour 500 g de farine. Plus active, arômes plus complexes. Conserver au réfrigérateur, utiliser dans les 2 semaines. Émietter directement dans la farine — pas besoin de la diluer dans l\'eau, contrairement à la croyance populaire.' },
      { type: 'technique', title: 'Levure sèche active et instantanée', text: 'Levure sèche active : réhydrater 10 min dans eau tiède (35°C) avec pincée de sucre avant utilisation. Levure instantanée (la plus courante) : mélanger directement à la farine sèche. Dosage : 7 g (un sachet) pour 500 g de farine. Conservation : 1 an à l\'abri de l\'humidité.' },
      { type: 'technique', title: 'Le levain naturel', text: 'Farine + eau + bactéries lactiques naturelles. Fermentation lente (12-24h), arômes complexes (légèrement acide), meilleure conservation du pain. Entretien quotidien : nourrir avec farine + eau. Le levain actif double de volume en 4-6h après alimentation. Un levain bien entretenu dure des années.' },
      { type: 'warning', text: 'Ne jamais mettre la levure en contact direct avec le sel — le sel est un bactéricide et tue la levure instantanément. Ajouter le sel d\'un côté de la cuve, la levure de l\'autre, mélanger après.' },
      { type: 'heading', text: 'Le gluten et le pétrissage' },
      { type: 'technique', title: 'Comprendre le gluten', text: 'Le gluten est un réseau de protéines (gliadine + gluténine) qui se forment quand la farine est hydratée et travaillée. Ce réseau élastique piège le CO₂ produit par la levure — sans gluten, les bulles s\'échappent et le pain reste plat. Plus on pétrit, plus le réseau est fort.' },
      { type: 'technique', title: 'Le pétrissage classique', text: 'Pousser la pâte avec la paume de la main, replier vers soi, tourner d\'un quart de tour, recommencer. 10-15 minutes à la main. La pâte est prête quand elle est lisse, élastique et ne colle plus aux doigts. Test du voile : étirer un morceau de pâte entre les doigts — elle doit former un voile transparent sans se déchirer.' },
      { type: 'technique', title: 'L\'autolyse', text: 'Technique moderne : mélanger farine + eau uniquement (sans sel ni levure), laisser reposer 20-60 min. La farine s\'hydrate naturellement et le gluten commence à se former sans effort. Résultat : pâte plus extensible, moins de pétrissage nécessaire, meilleure texture finale.' },
      { type: 'heading', text: 'Les deux fermentations' },
      { type: 'technique', title: 'Le pointage — première pousse', text: 'Après le pétrissage, la pâte repose à couvert dans un récipient légèrement huilé. Elle doit doubler de volume. Température ambiante (22-24°C) : 1h30 à 2h. Réfrigérateur (4°C) : 8-12h (pousse lente, arômes plus complexes). Le froid ralentit la levure mais ne la tue pas.' },
      { type: 'technique', title: 'Le façonnage et l\'apprêt', text: 'Après le pointage : dégazer délicatement (appuyer pour chasser le CO₂), façonner (boule, baguette, miche), placer sur papier cuisson ou banneton fariné. Laisser lever une 2e fois (l\'apprêt) : 45 min à 1h30 à température ambiante. La pâte doit avoir légèrement gonflé et rebondir mollement au toucher.' },
      { type: 'tip', text: 'Test de la fermentation : appuyer un doigt fariné sur la pâte. Si l\'empreinte remonte lentement → parfait. Si elle remonte immédiatement → pas assez fermenté. Si elle ne remonte pas → sur-fermenté (la pâte sera dense et acide).' },
      { type: 'heading', text: 'La cuisson' },
      { type: 'technique', title: 'La buée et la croûte', text: 'Four le plus chaud possible (240-260°C, préchauffé 30 min). Créer de la buée les 10 premières minutes : jeter 100 ml d\'eau dans la lèchefrite, ou cuire dans une cocotte fermée. La buée retarde la formation de la croûte et permet au pain de prendre son volume. Ensuite : ouvrir le four, évacuer la buée, finir la cuisson à sec pour la croûte dorée.' },
      { type: 'technique', title: 'La scarification (grigne)', text: 'Inciser le pain avec une lame de rasoir (grigne) juste avant d\'enfourner. Profondeur : 5 mm, angle : 45°. La scarification dirige l\'expansion du pain, évite qu\'il éclate aléatoirement et crée le motif distinctif du pain artisanal.' },
      { type: 'warning', text: 'Un four domestique ne dépasse généralement pas 250°C contre 300-350°C pour un four de boulangerie professionnel. Compense avec une plus longue préchauffage, une pierre à pizza ou une cocotte en fonte pour stocker la chaleur.' },
      { type: 'recap', text: 'Levure + sucres → CO₂ qui fait lever. Sel ≠ levure (jamais en contact direct). Gluten = réseau élastique qui piège les bulles. Pointage → 1e pousse, apprêt → 2e pousse. Buée au four → volume et croûte craquante. Test du doigt pour vérifier la fermentation.' },
      { type: 'exercise', text: 'Fais un pain basique : 500 g farine T65 + 7 g levure instantanée + 10 g sel + 320 ml eau tiède. Pétris 10 min, laisse pousser 1h30, façonne en boule, appret 1h, scarifie, four 240°C avec buée. Le résultat sera meilleur que tu ne l\'imagines — et tu comprendras chaque étape en faisant.' },
    ]),
  },
];

async function seedLessons() {
  for (const lesson of LESSON_SEED) {
    await prisma.lesson.upsert({
      where: { slug: lesson.slug },
      update: { title: lesson.title, description: lesson.description, content: lesson.content, difficulty: lesson.difficulty, gemCost: lesson.gemCost, xpReward: lesson.xpReward },
      create: lesson,
    });
  }
  console.log(`🎓 ${LESSON_SEED.length} leçons mises à jour`);
}

// Comptes Pro permanents : liste de usernames séparés par virgule dans PRO_USERNAMES
async function grantProToFixedAccounts() {
  const raw = (process.env.PRO_USERNAMES || '').trim();
  if (!raw) return;
  const usernames = raw.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (!usernames.length) return;
  const { count } = await prisma.user.updateMany({ where: { username: { in: usernames }, isPro: false }, data: { isPro: true } });
  if (count) console.log(`⭐ ${count} compte(s) Pro activé(s) : ${usernames.join(', ')}`);
}

app.listen(PORT, () => {
  const dbHost = (process.env.DATABASE_URL || 'sqlite').replace(/\/\/[^@]+@/, '//***@').split('/')[2] || 'local';
  console.log(`🔥 CulinaRPG en ligne sur http://localhost:${PORT} — DB: ${dbHost}`);

  // Pré-chauffe la connexion Neon + crée les tables manquantes
  (async () => {
    for (let i = 1; i <= 5; i++) {
      try {
        await _baseClient.$queryRaw`SELECT 1`;
        console.log('✅ Base de données connectée.');
        break;
      } catch (err) {
        console.log(`⏳ DB tentative ${i}/5 (${err.code || err.message?.slice(0, 40)}) — attente ${i * 4}s...`);
        if (i < 5) await new Promise((r) => setTimeout(r, i * 4000));
        else { console.error('❌ DB inaccessible après 5 tentatives.'); return; }
      }
    }
    // S'assure que la table Friendship existe (créée après le déploiement initial)
    try {
      await _baseClient.$executeRaw`
        CREATE TABLE IF NOT EXISTS "Friendship" (
          "id" SERIAL NOT NULL,
          "requesterId" INTEGER NOT NULL,
          "addresseeId" INTEGER NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'pending',
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "Friendship_requesterId_addresseeId_key" UNIQUE ("requesterId", "addresseeId"),
          CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE,
          CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE
        )
      `;
      await _baseClient.$executeRaw`CREATE INDEX IF NOT EXISTS "Friendship_addresseeId_idx" ON "Friendship"("addresseeId")`;
      console.log('✅ Table Friendship prête.');
    } catch (err) {
      console.log('⚠️ Friendship table check:', err.message?.slice(0, 80));
    }
  })();

  seedLessons().catch(console.error);
  grantProToFixedAccounts().catch(console.error);
  if (process.env.RESOLVE_IMAGES_ON_START !== 'false') {
    setTimeout(() => resolveRecipeImages(prisma, { log: (m) => console.log(m) }).catch(() => {}), 3000);
  }
  setInterval(() => prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {}), 6 * 3600 * 1000).unref();
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
