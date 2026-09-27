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
              console.log(`â³ DB retry ${attempt}/3 (${err.code}) â€” attente ${attempt * 3}s...`);
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

// Google Play Billing â€” Android Publisher API
// Env vars: GOOGLE_SERVICE_ACCOUNT_JSON (service account JSON string)
//           TWA_PACKAGE_NAME (Android package name, ex: com.culinarpg.app)
const PLAY_PACKAGE = (process.env.TWA_PACKAGE_NAME || process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.courribetvictor.culinarpg').trim();
let androidPublisher = null;
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && PLAY_PACKAGE) {
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    androidPublisher = google.androidpublisher({ version: 'v3', auth });
    console.log('[Play] Google Play Billing initialisÃ© pour', PLAY_PACKAGE);
  } catch (e) {
    console.error('[Play] Erreur init Google Play Billing:', e.message);
  }
}

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

// CORS uniquement si des origines sont explicitement autorisÃ©es (ex. app mobile empaquetÃ©e)
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

// Streak affichÃ© : cassÃ© si la derniÃ¨re activitÃ© date d'avant-hier ou plus
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
// PrÃ©sentation du joueur
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
// Attribution d'XP (transaction) + dÃ©tection des level-ups
// ---------------------------------------------------------------------------
async function grantXp(userId, baseRewards, extraOps = []) {
  return prisma.$transaction(async (tx) => {
    // Verrou de ligne : deux gains simultanÃ©s pour le mÃªme joueur s'exÃ©cutent l'un aprÃ¨s l'autre
    // (sinon chacun lirait l'ancien total d'XP et l'un des deux gains serait perdu)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, include: { skills: true } });
    const before = Object.fromEntries(user.skills.map((s) => [s.skill, s.xp]));

    // Bonus de classe (+10 % sur la compÃ©tence de prÃ©dilection)
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
// Badges (calculÃ©s Ã  la volÃ©e)
// ---------------------------------------------------------------------------
function computeBadges({ user, skills, recipesCooked, uniqueRecipes, dailiesDone, bakingCooks }) {
  const lvl = globalLevel(user.totalXp);
  const maxSkill = Math.max(...skills.map((s) => skillLevel(s.xp)));
  const allSkills3 = skills.every((s) => skillLevel(s.xp) >= 3);
  return [
    { id: 'first-dish', name: 'Premier Plat', description: 'Cuisine ta premiÃ¨re recette', icon: 'utensils', unlocked: recipesCooked >= 1 },
    { id: 'line-cook', name: 'Cuisinier de Ligne', description: 'Cuisine 10 recettes', icon: 'chef-hat', unlocked: recipesCooked >= 10 },
    { id: 'explorer', name: 'Explorateur', description: 'Cuisine 25 recettes diffÃ©rentes', icon: 'compass', unlocked: uniqueRecipes >= 25 },
    { id: 'disciplined', name: 'DisciplinÃ©', description: 'ComplÃ¨te 20 dailies', icon: 'calendar-check', unlocked: dailiesDone >= 20 },
    { id: 'on-fire', name: 'En Feu', description: 'Streak de 3 jours', icon: 'flame', unlocked: user.bestStreak >= 3 },
    { id: 'unstoppable', name: 'InarrÃªtable', description: 'Streak de 7 jours', icon: 'zap', unlocked: user.bestStreak >= 7 },
    { id: 'baker', name: 'Mitron', description: '5 recettes de pÃ¢tisserie ou boulangerie', icon: 'croissant', unlocked: bakingCooks >= 5 },
    { id: 'specialist', name: 'SpÃ©cialiste', description: 'Une compÃ©tence niveau 5', icon: 'award', unlocked: maxSkill >= 5 },
    { id: 'all-rounder', name: 'Polyvalent', description: 'Toutes les compÃ©tences niveau 3', icon: 'hexagon', unlocked: allSkills3 },
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

// Mode privÃ© : si SIGNUP_CODE est dÃ©fini, l'inscription exige ce code d'invitation
const SIGNUP_CODE = (process.env.SIGNUP_CODE || '').trim();

app.get('/api/meta', (req, res) => {
  res.json({
    classes: Object.entries(CHEF_CLASSES).map(([skill, c]) => ({ skill, ...c })),
    avatarColors: auth.AVATAR_COLORS,
    classBonus: CLASS_BONUS,
    inviteRequired: Boolean(SIGNUP_CODE),
  });
});

// Liaison app Android (TWA) â†” site : sans ce fichier, Android affiche une barre d'adresse
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = (process.env.TWA_PACKAGE_NAME || 'com.courribetvictor.culinarpg').trim();
  const fingerprints = (process.env.TWA_SHA256_FINGERPRINTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.json(fingerprints.length ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fingerprints },
  }] : []);
});

// Politique de confidentialitÃ© (exigÃ©e par le Play Store) â€” e-mail de contact via CONTACT_EMAIL
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

  if (!auth.USERNAME_RE.test(username)) return badRequest(res, 'Pseudo : 3 Ã  20 caractÃ¨res (lettres, chiffres, Â« _ Â» ou Â« . Â»).', 'username');
  if (!auth.EMAIL_RE.test(email)) return badRequest(res, 'Adresse e-mail invalide.', 'email');
  const pwError = auth.validatePassword(password);
  if (pwError) return badRequest(res, pwError, 'password');

  const taken = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { username: true } });
  if (taken) {
    return res.status(409).json(taken.username === username
      ? { error: 'Ce pseudo est dÃ©jÃ  pris.', field: 'username' }
      : { error: 'Un compte existe dÃ©jÃ  avec cet e-mail.', field: 'email' });
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
      return res.status(409).json({ error: 'Pseudo ou e-mail dÃ©jÃ  utilisÃ©.' });
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
// Routes protÃ©gÃ©es
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
    if (v.length < 1 || v.length > 30) return badRequest(res, 'Nom affichÃ© : 1 Ã  30 caractÃ¨res.', 'displayName');
    data.displayName = v;
  }
  if (b.username !== undefined) {
    const v = auth.normUsername(b.username);
    if (!auth.USERNAME_RE.test(v)) return badRequest(res, 'Pseudo : 3 Ã  20 caractÃ¨res (lettres, chiffres, Â« _ Â» ou Â« . Â»).', 'username');
    if (v !== req.user.username) {
      const taken = await prisma.user.findUnique({ where: { username: v }, select: { id: true } });
      if (taken) return res.status(409).json({ error: 'Ce pseudo est dÃ©jÃ  pris.', field: 'username' });
    }
    data.username = v;
  }
  if (b.bio !== undefined) {
    const v = String(b.bio).trim();
    if (v.length > 160) return badRequest(res, 'Bio : 160 caractÃ¨res maximum.', 'bio');
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
      if (!t || !t.unlocked) return badRequest(res, 'Ce titre n\'est pas encore dÃ©bloquÃ©.', 'selectedTitle');
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
  // DÃ©connecte les autres appareils
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
  if (!task) return res.status(404).json({ error: 'TÃ¢che introuvable' });

  const date = dayKey();
  try {
    const result = await grantXp(req.user.id, { [task.skill]: task.xpReward }, [
      (tx) => tx.userDailyCompletion.create({ data: { userId: req.user.id, dailyTaskId: task.id, date } }),
    ]);
    return res.json({ ...result, task: { id: task.id, title: task.title } });
  } catch (err) {
    // Contrainte unique (userId, dailyTaskId, date) : la transaction est annulÃ©e, pas d'XP en double
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'DÃ©jÃ  complÃ©tÃ©e aujourd\'hui' });
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
        emoji: true, timeMinutes: true, difficulty: true, skillRewards: true, totalXp: true, isCustom: true,
      },
    }),
  ]);

  const counts = await prisma.userRecipeCompletion.groupBy({
    by: ['recipeId'],
    where: { userId: req.user.id, recipeId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const countMap = Object.fromEntries(counts.map((c) => [c.recipeId, c._count._all]));

  const isPro = req.user.isPro || false;
  res.json({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    items: rows.map((r) => ({
      ...serializeRecipe(r, countMap[r.id] || 0),
      locked: !isPro && !r.isCustom && r.difficulty >= 4,
    })),
  });
}));

// ---------------------------------------------------------------------------
// Recettes personnelles (privÃ©es)
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
  if (!req.user.isPro) {
    return res.status(403).json({ error: 'La crÃ©ation de recettes est rÃ©servÃ©e aux membres Pro â­', proRequired: true });
  }
  const { title, category, timeMinutes, ingredients, instructions, imageUrl } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Le titre est requis', field: 'title' });
  if (!Array.isArray(ingredients) || !ingredients.length) return res.status(400).json({ error: 'Au moins un ingrÃ©dient requis', field: 'ingredients' });
  if (!instructions?.trim()) return res.status(400).json({ error: 'Les Ã©tapes sont requises', field: 'instructions' });

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
      emoji: 'ðŸ½ï¸',
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

// ---------------------------------------------------------------------------
// Planificateur de repas (Pro)
// ---------------------------------------------------------------------------
app.post('/api/planner/generate', wrap(async (req, res) => {
  if (!req.user.isPro) {
    return res.status(403).json({ error: 'Le planificateur est rÃ©servÃ© aux membres Pro â­', proRequired: true });
  }
  const { categories, maxTime } = req.body || {};
  const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

  const where = { isCustom: false };
  if (Array.isArray(categories) && categories.length) where.category = { in: categories };
  if (maxTime) where.timeMinutes = { lte: Number(maxTime) || 9999 };

  const pool = await prisma.recipe.findMany({
    where,
    select: {
      id: true, name: true, description: true, category: true, area: true, source: true, imageUrl: true,
      emoji: true, timeMinutes: true, difficulty: true, skillRewards: true, totalXp: true, mainSkill: true,
      ingredients: true,
    },
  });
  if (pool.length < 7) {
    return res.status(400).json({ error: 'Pas assez de recettes disponibles avec ces critÃ¨res' });
  }

  const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 7);

  const ingredientMap = {};
  for (const recipe of shuffled) {
    let ings;
    try { ings = JSON.parse(recipe.ingredients || '[]'); } catch { ings = []; }
    for (const ing of ings) {
      const raw = typeof ing === 'object' ? (ing.name || ing.item || '') : String(ing || '');
      const name = raw.trim().toLowerCase();
      if (name) ingredientMap[name] = (ingredientMap[name] || 0) + 1;
    }
  }
  const shoppingList = Object.entries(ingredientMap)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  res.json({
    days: DAYS.map((day, i) => ({ day, recipe: serializeRecipe(shuffled[i]) })),
    shoppingList,
  });
}));

app.get('/api/recipes/:id', wrap(async (req, res) => {
  const recipe = await prisma.recipe.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!recipe) return res.status(404).json({ error: 'Recette introuvable' });
  if (!req.user.isPro && !recipe.isCustom && recipe.difficulty >= 4) {
    return res.status(403).json({ error: 'Cette recette est rÃ©servÃ©e aux membres Pro â­', proRequired: true });
  }
  const cookedCount = await prisma.userRecipeCompletion.count({ where: { userId: req.user.id, recipeId: recipe.id } });
  res.json(serializeRecipe(recipe, cookedCount));
}));

app.post('/api/recipes/:id/cook', wrap(async (req, res) => {
  const recipe = await prisma.recipe.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!recipe) return res.status(404).json({ error: 'Recette introuvable' });

  // Rendements dÃ©croissants : chaque rÃ©pÃ©tition rapporte moins (min 40 %)
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
    season: { number: 1, name: 'Saison des PremiÃ¨res Flammes', endDate: '2025-12-31' },
  });
}));

// ---------------------------------------------------------------------------
// Profil public & Amis
// ---------------------------------------------------------------------------
const FRIEND_USER_SELECT = { id: true, username: true, displayName: true, avatar: true, avatarColor: true, avatarImage: true, totalXp: true, isPro: true, chefClass: true };

// Recherche de joueurs par pseudo partiel (min 2 caractÃ¨res)
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
  } catch (_) { /* table Friendship pas encore crÃ©Ã©e, on continue avec 'none' */ }

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
  if (target.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'ajouter toi-mÃªme' });
  const existing = await prisma.friendship.findFirst({
    where: { OR: [{ requesterId: req.user.id, addresseeId: target.id }, { requesterId: target.id, addresseeId: req.user.id }] },
  });
  if (existing) return res.status(409).json({ error: 'Demande dÃ©jÃ  existante' });
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
// QuÃªtes personnalisÃ©es
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
  if (t.length < 2 || t.length > 60) return badRequest(res, 'Titre : 2 Ã  60 caractÃ¨res.', 'title');
  if (!SKILLS.includes(skill)) return badRequest(res, 'CompÃ©tence invalide.', 'skill');
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
  if (!quest) return res.status(404).json({ error: 'QuÃªte introuvable' });
  if (quest.completed) return res.status(409).json({ error: 'QuÃªte dÃ©jÃ  complÃ©tÃ©e' });
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
  if (!deleted.count) return res.status(404).json({ error: 'QuÃªte introuvable' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// LeÃ§ons
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
  if (!lesson) return res.status(404).json({ error: 'LeÃ§on introuvable' });
  const unlock = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  const accessible = lesson.gemCost === 0 || req.user.isPro || !!unlock;
  if (!accessible) return res.status(403).json({ error: 'LeÃ§on verrouillÃ©e', gemCost: lesson.gemCost, gems: req.user.gems });
  res.json({ ...lesson, content: JSON.parse(lesson.content), completed: !!unlock?.completed });
}));

// DÃ©verrouille l'accÃ¨s Ã  une leÃ§on (dÃ©duit les gemmes, pas d'XP)
app.post('/api/lessons/:id/unlock', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'LeÃ§on introuvable' });
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

// Marque une leÃ§on comme complÃ©tÃ©e et accorde l'XP
app.post('/api/lessons/:id/complete', wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.params.id) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'LeÃ§on introuvable' });
  const unlock = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  const accessible = lesson.gemCost === 0 || req.user.isPro || !!unlock;
  if (!accessible) return res.status(403).json({ error: 'LeÃ§on verrouillÃ©e' });
  if (unlock?.completed) return res.status(409).json({ error: 'LeÃ§on dÃ©jÃ  complÃ©tÃ©e' });
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
  // Juste dÃ©verrouiller l'accÃ¨s â€” l'XP est accordÃ© quand le joueur clique "J'ai compris !"
  await prisma.userLessonUnlock.create({ data: { userId, lessonId: lesson.id } });
  return { ok: true };
}

// Helper : crÃ©e une session Stripe et renvoie { url } ou une erreur lisible
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
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: pack.unitAmount, product_data: { name: `CulinaRPG Â· ${pack.label}`, description: `${pack.gems} gemmes pour dÃ©bloquer des leÃ§ons premium` } } }],
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
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: plan.unitAmount, recurring: { interval: plan.interval }, product_data: { name: `CulinaRPG Pro Â· ${plan.label}`, description: 'AccÃ¨s illimitÃ© Ã  toutes les leÃ§ons et fonctionnalitÃ©s avancÃ©es' } } }],
    metadata: { type: 'pro', userId: String(req.user.id), plan: req.body?.plan || 'annual' },
    success_url: `${APP_URL}/?payment=success&type=pro`,
    cancel_url: `${APP_URL}/#pro`,
  }));
}));

// POST /api/stripe/checkout/lesson
app.post('/api/stripe/checkout/lesson', requireAuth, wrap(async (req, res) => {
  const lesson = await prisma.lesson.findUnique({ where: { id: Number(req.body?.lessonId) || 0 } });
  if (!lesson) return res.status(404).json({ error: 'LeÃ§on introuvable' });
  if (!stripe) {
    const result = await fulfillLesson(req.user.id, lesson);
    if (!result) return res.status(409).json({ error: 'LeÃ§on dÃ©jÃ  dÃ©bloquÃ©e' });
    return res.json({ simulated: true });
  }
  const existing = await prisma.userLessonUnlock.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  if (existing) return res.status(409).json({ error: 'LeÃ§on dÃ©jÃ  dÃ©bloquÃ©e' });
  return stripeSession({}, res, () => stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 99, product_data: { name: `CulinaRPG Â· LeÃ§on : ${lesson.title}`, description: lesson.description } } }],
    metadata: { type: 'lesson', userId: String(req.user.id), lessonId: String(lesson.id), lessonSkill: lesson.skill, lessonXp: String(lesson.xpReward) },
    success_url: `${APP_URL}/?payment=success&type=lesson`,
    cancel_url: `${APP_URL}/#lessons`,
  }));
}));

// Backward-compat simulation aliases (utilisÃ©s quand Stripe n'est pas configurÃ©)
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
  if (!lesson) return res.status(404).json({ error: 'LeÃ§on introuvable' });
  const xpResult = await fulfillLesson(req.user.id, lesson);
  if (!xpResult) return res.status(409).json({ error: 'LeÃ§on dÃ©jÃ  dÃ©bloquÃ©e' });
  res.json({ ok: true, xpResult });
}));

// POST /api/stripe/webhook
app.post('/api/stripe/webhook', wrap(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook Stripe non configurÃ© (STRIPE_WEBHOOK_SECRET manquant)' });
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
// Google Play Billing (TWA in-app purchases)
// ---------------------------------------------------------------------------
const PLAY_PRO_PRODUCTS = ['pro_monthly', 'pro_annual'];
const PLAY_GEM_PRODUCTS = { gems_100: 100, gems_300: 300, gems_700: 700 };

async function verifyPlaySubscription(productId, purchaseToken) {
  if (!androidPublisher) throw new Error('Google Play Billing non configurÃ©');
  const pkg = PLAY_PACKAGE;
  const res = await androidPublisher.purchases.subscriptionsv2.get({
    packageName: pkg, token: purchaseToken,
  });
  const sub = res.data;
  // lineItems[0].productId doit correspondre
  const item = (sub.lineItems || []).find((l) => l.productId === productId);
  if (!item) throw new Error('Produit non trouvÃ© dans la souscription');
  // paymentState: 1 = received, 2 = free trial
  const active = sub.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE'
    || sub.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
  return { valid: active, expiryTimeMillis: item.expiryTime ? new Date(item.expiryTime).getTime() : null };
}

async function verifyPlayPurchase(productId, purchaseToken) {
  if (!androidPublisher) throw new Error('Google Play Billing non configurÃ©');
  const pkg = PLAY_PACKAGE;
  const res = await androidPublisher.purchases.products.get({
    packageName: pkg, productId, token: purchaseToken,
  });
  // purchaseState: 0 = purchased
  return { valid: res.data.purchaseState === 0, orderId: res.data.orderId };
}

// POST /api/play/billing/pro  â€” vÃ©rifie et active Pro via Google Play Billing
app.post('/api/play/billing/pro', requireAuth, wrap(async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  if (!PLAY_PRO_PRODUCTS.includes(productId) || !purchaseToken) {
    return badRequest(res, 'productId ou purchaseToken manquant');
  }
  if (!androidPublisher) {
    // Mode dev sans credentials â†’ simuler
    await fulfillPro(req.user.id);
    return res.json({ ok: true, simulated: true, isPro: true });
  }
  try {
    const { valid } = await verifyPlaySubscription(productId, purchaseToken);
    if (!valid) return res.status(402).json({ error: 'Souscription invalide ou expirÃ©e' });
    await fulfillPro(req.user.id);
    // Acknowledge the purchase
    await androidPublisher.purchases.subscriptionsv2.acknowledge({
      packageName: PLAY_PACKAGE,
      token: purchaseToken,
    }).catch(() => {});
    console.log(`[Play] Pro fulfilled: user ${req.user.id} product ${productId}`);
    res.json({ ok: true, isPro: true });
  } catch (err) {
    console.error('[Play] Pro verify error:', err.message);
    res.status(402).json({ error: 'Impossible de vÃ©rifier l\'achat Google Play' });
  }
}));

// POST /api/play/billing/gems â€” vÃ©rifie et crÃ©dite des gemmes via Google Play Billing
app.post('/api/play/billing/gems', requireAuth, wrap(async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  const gems = PLAY_GEM_PRODUCTS[productId];
  if (!gems || !purchaseToken) return badRequest(res, 'productId ou purchaseToken manquant');
  if (!androidPublisher) {
    const result = await fulfillGems(req.user.id, { gems });
    return res.json({ ok: true, simulated: true, ...result });
  }
  try {
    const { valid, orderId } = await verifyPlayPurchase(productId, purchaseToken);
    if (!valid) return res.status(402).json({ error: 'Achat invalide' });
    const result = await fulfillGems(req.user.id, { gems });
    // Acknowledge
    await androidPublisher.purchases.products.acknowledge({
      packageName: PLAY_PACKAGE,
      productId, token: purchaseToken,
    }).catch(() => {});
    console.log(`[Play] Gems fulfilled: user ${req.user.id} +${gems} (order ${orderId})`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Play] Gems verify error:', err.message);
    res.status(402).json({ error: 'Impossible de vÃ©rifier l\'achat Google Play' });
  }
}));

// GET /api/play/billing/products â€” liste les produits disponibles (pour le frontend TWA)
app.get('/api/play/billing/products', requireAuth, (req, res) => {
  res.json({
    subscriptions: PLAY_PRO_PRODUCTS,
    products: Object.keys(PLAY_GEM_PRODUCTS),
    gemAmounts: PLAY_GEM_PRODUCTS,
  });
});

// ---------------------------------------------------------------------------
// Fallbacks & erreurs
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'RequÃªte trop volumineuse.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  console.error('[ERR]', err.code || '', err.message || err);
  // Erreurs Stripe : renvoyer le message pour faciliter le diagnostic
  if (err.type && err.type.startsWith('Stripe')) return res.status(402).json({ error: err.message });
  // Base de donnÃ©es inaccessible (Neon cold-start / rÃ©seau)
  if (err.code === 'P1001' || err.code === 'P1002' || err.code === 'P1008') {
    return res.status(503).json({ error: 'Service temporairement indisponible. RÃ©essayez dans quelques secondes.' });
  }
  return res.status(err.status || 500).json({ error: 'Erreur serveur' });
});

// ---------------------------------------------------------------------------
// Seed leÃ§ons (au dÃ©marrage si la table est vide)
// ---------------------------------------------------------------------------
const LESSON_SEED = [
  {
    slug: 'coupes-essentielles',
    title: 'Les coupes essentielles',
    description: 'Julienne, brunoise, chiffonnadeâ€¦ maÃ®trise les 6 coupes de base avec prÃ©cision.',
    category: 'knife', skill: 'knife', difficulty: 1, icon: 'scissors', gemCost: 0, xpReward: 80, order: 1,
    content: JSON.stringify([
      { type: 'text', text: 'Le couteau est le prolongement de ta main. Avant de maÃ®triser les sauces, les cuissons ou la pÃ¢tisserie, tu dois maÃ®triser les coupes. Chaque taille a une utilitÃ© prÃ©cise : uniformitÃ© de cuisson, esthÃ©tique du plat, texture en bouche.' },
      { type: 'heading', text: 'La prise en main correcte' },
      { type: 'technique', title: 'La prise "en pince"', text: 'Pince la lame entre le pouce et l\'index, juste devant le manche. Les autres doigts tiennent le manche. C\'est la prise standard des cuisiniers professionnels : elle offre contrÃ´le, prÃ©cision et rÃ©duction de la fatigue.' },
      { type: 'technique', title: 'La "griffe de chat"', text: 'Les doigts de la main qui tient l\'aliment sont repliÃ©s : les premiÃ¨res phalanges touchent la lame et guident la coupe, les bouts des doigts sont en retrait. La lame glisse contre les phalanges â€” jamais contre les ongles.' },
      { type: 'warning', text: 'Ne jamais couper avec le poignet. Le mouvement vient de l\'Ã©paule et du coude. Le couteau bascule d\'avant en arriÃ¨re, la pointe reste en contact avec la planche.' },
      { type: 'heading', text: 'Les 6 coupes fondamentales' },
      { type: 'technique', title: 'Ã‰mincer', text: 'Tranches fines et rÃ©guliÃ¨res, 1 Ã  3 mm. Technique de base pour oignons, champignons, courgettes. Objectif : rÃ©gularitÃ© absolue pour une cuisson homogÃ¨ne.' },
      { type: 'technique', title: 'Julienne', text: 'BÃ¢tonnets de 3Ã—3Ã—50 mm. On commence par des tranches de 3 mm d\'Ã©paisseur, puis on les empile et on taille en bÃ¢tonnets. IdÃ©ale pour lÃ©gumes sautÃ©s, salades croquantes, garnitures.' },
      { type: 'technique', title: 'Brunoise', text: 'DÃ©s de 3Ã—3Ã—3 mm. On part d\'une julienne qu\'on coupe perpendiculairement tous les 3 mm. Parfaite pour les sauces, farces, soupes. La brunoise fine (1Ã—1Ã—1 mm) est rÃ©servÃ©e aux grandes tables.' },
      { type: 'technique', title: 'Mirepoix', text: 'DÃ©s grossiers de 1 Ã  2 cm. Carottes, cÃ©leri, oignon. UtilisÃ©e comme base aromatique pour bouillons, braises et ragoÃ»ts â€” la taille n\'a pas besoin d\'Ãªtre parfaite, les lÃ©gumes finissent souvent retirÃ©s.' },
      { type: 'technique', title: 'Chiffonnade', text: 'Feuilles (basilic, salade, oseille, menthe) empilÃ©es, roulÃ©es en cigare, puis coupÃ©es en fines laniÃ¨res. Ne jamais hacher les herbes fragiles â€” la pression du couteau les oxyde et les noircit.' },
      { type: 'technique', title: 'Ciseler', text: 'Couper l\'oignon ou l\'Ã©chalote en petits dÃ©s fins sans les sÃ©parer. On incise d\'abord horizontalement (sans couper la racine), puis verticalement, puis on tranche. La racine maintient l\'oignon en place jusqu\'Ã  la fin.' },
      { type: 'heading', text: 'Ton matÃ©riel' },
      { type: 'tip', text: 'Un couteau de chef 20 cm bien affÃ»tÃ© fait 90 % du travail. Aiguise-le avant chaque usage avec un fusil ou une pierre. Un couteau Ã©moussÃ© demande plus de force, ce qui augmente le risque de glissement.' },
      { type: 'tip', text: 'Planche en bois ou en plastique Ã©paisse. Jamais de verre ou de marbre â€” ils abÃ®ment le fil du couteau instantanÃ©ment. Glisse un torchon humide sous la planche pour l\'empÃªcher de bouger.' },
      { type: 'warning', text: 'Ne jamais mettre ses couteaux au lave-vaisselle. La chaleur, l\'humiditÃ© et les chocs abÃ®ment le bois du manche et ramollissent le mÃ©tal. Laver Ã  la main, sÃ©cher immÃ©diatement.' },
      { type: 'recap', text: 'Ã‰mincer â†’ tranches fines. Julienne â†’ bÃ¢tonnets. Brunoise â†’ petits dÃ©s. Mirepoix â†’ gros dÃ©s aromatiques. Chiffonnade â†’ herbes en laniÃ¨res. Ciseler â†’ oignons en dÃ©s sans les sÃ©parer.' },
      { type: 'exercise', text: 'Prends une carotte. Taille-la en julienne (bÃ¢tonnets 3Ã—3Ã—50 mm), puis coupe ces bÃ¢tonnets en brunoise (3Ã—3Ã—3 mm). Compte le temps. Objectif : moins de 3 minutes avec des dÃ©s rÃ©guliers.' },
    ]),
  },
  {
    slug: 'mise-en-place',
    title: 'La mise en place',
    description: 'L\'art de l\'organisation. PrÃ©pare comme un pro, cuisine sans stress ni improvisation.',
    category: 'prep', skill: 'prep', difficulty: 1, icon: 'layout-grid', gemCost: 0, xpReward: 80, order: 2,
    content: JSON.stringify([
      { type: 'text', text: '"Mise en place" â€” littÃ©ralement "mettre en place" â€” est le principe fondateur de toute cuisine professionnelle. C\'est l\'art de prÃ©parer, organiser et disposer chaque ingrÃ©dient, outil et Ã©quipement avant d\'allumer le feu. Sans elle, on improvise. Avec elle, on cuisine.' },
      { type: 'heading', text: 'Avant de commencer : lire et planifier' },
      { type: 'technique', title: 'Lire la recette en entier', text: 'Pas juste les ingrÃ©dients â€” la recette complÃ¨te, deux fois. Identifie les temps de repos (pÃ¢te Ã  laisser lever, viande Ã  mariner, crÃ¨me Ã  refroidir), les Ã©tapes parallÃ¨les et les Ã©quipements spÃ©ciaux (thermomÃ¨tre, film alimentaire, poche Ã  douille).' },
      { type: 'technique', title: 'Dresser la liste du matÃ©riel', text: 'Couteaux, planches, casseroles, saladiers, tamis, spatulesâ€¦ Tout sortir avant de commencer. Rien de plus frustrant que de chercher une Ã©cumoire alors que la sauce est en train de brÃ»ler.' },
      { type: 'tip', text: 'Identifie les Ã©tapes critiques qui ne pardonnent pas l\'improvisation : monter une mayonnaise, tempÃ©rer du chocolat, cuire un caramel. Ces Ã©tapes demandent 100 % de ton attention. Tout le reste doit Ãªtre prÃªt avant.' },
      { type: 'heading', text: 'PrÃ©parer les ingrÃ©dients' },
      { type: 'technique', title: 'Peser et mesurer', text: 'Tous les ingrÃ©dients pesÃ©s et disposÃ©s dans des bols ou ramequins avant de commencer. En cuisine professionnelle, on appelle Ã§a les "bols de mis en place". Ã‡a Ã©vite les erreurs de dosage et permet de cuisiner sans interruption.' },
      { type: 'technique', title: 'PrÃ©parer dans l\'ordre d\'utilisation', text: 'Commence par les ingrÃ©dients qui prennent le plus de temps Ã  prÃ©parer (lÃ©gumes Ã  tailler, viande Ã  mariner) et termine par ceux qui s\'utilisent en dernier. Regrouper les ingrÃ©dients par Ã©tape de la recette.' },
      { type: 'technique', title: 'Ã‰tiqueter si nÃ©cessaire', text: 'Pour les prÃ©parations Ã  l\'avance (bouillon, fond, crÃ¨me), couvre avec du film et Ã©tiquette : contenu + date. En cuisine pro, on date systÃ©matiquement. Chez toi, Ã§a Ã©vite de "goÃ»ter pour deviner".' },
      { type: 'warning', text: 'Ne jamais laisser des protÃ©ines crues (viande, poisson) Ã  tempÃ©rature ambiante plus de 20 minutes. PrÃ©pare-les en dernier et remets-les au frais si la recette le permet.' },
      { type: 'heading', text: 'Organiser l\'espace de travail' },
      { type: 'technique', title: 'Zone propre / zone sale', text: 'DÃ©limite mentalement ta planche (zone de travail propre) et un cÃ´tÃ© "dÃ©chets" oÃ¹ vont les Ã©pluchures et parures. Ne jamais mettre de dÃ©chets sur la zone de travail propre.' },
      { type: 'technique', title: 'Nettoyer au fur et Ã  mesure', text: 'AprÃ¨s chaque prÃ©paration, essuie la planche, range les bols vides, jette les dÃ©chets. Un plan de travail encombrÃ© ralentit et gÃ©nÃ¨re des erreurs. C\'est ce qu\'on appelle "clean as you go".' },
      { type: 'tip', text: 'Garde un torchon propre sur l\'Ã©paule (comme les chefs) pour essuyer tes mains, nettoyer les rebords des plats, saisir les poignÃ©es chaudes. Change-le souvent : un torchon sale est une source de contamination.' },
      { type: 'tip', text: 'PrÃ©chauffer le four, faire bouillir l\'eau, sortir le beurre du frigo Ã  l\'avance font partie de la mise en place. Le thermomÃ¨tre du four ment souvent â€” laisse 15 min de plus que la recette recommande.' },
      { type: 'recap', text: 'Lire en entier â†’ peser tous les ingrÃ©dients â†’ prÃ©parer dans l\'ordre â†’ organiser l\'espace â†’ nettoyer au fur et Ã  mesure. La mise en place transforme une session stressante en cuisine fluide et maÃ®trisÃ©e.' },
      { type: 'exercise', text: 'Choisis une recette de 4-5 Ã©tapes. Avant d\'allumer quoi que ce soit, prÃ©pare et dispose tous les ingrÃ©dients en bols. Lis chaque Ã©tape et imagine-la mentalement. Puis cuisine. Compare le stress et le rÃ©sultat avec ta faÃ§on de cuisiner habituelle.' },
    ]),
  },
  {
    slug: 'aromates-de-base',
    title: 'Les aromates de base',
    description: 'Les 5 piliers du goÃ»t, herbes, Ã©pices, zestes : construire la profondeur d\'un plat.',
    category: 'seasoning', skill: 'seasoning', difficulty: 1, icon: 'leaf', gemCost: 0, xpReward: 80, order: 3,
    content: JSON.stringify([
      { type: 'text', text: 'L\'assaisonnement est l\'art de construire l\'Ã©quilibre. Un plat fade n\'est pas un plat sans sel â€” c\'est un plat sans complexitÃ©. Les cinq piliers du goÃ»t sont : le salÃ©, l\'acide, le sucrÃ©, l\'amer et l\'umami. Comprendre comment les doser et les combiner transforme radicalement ta cuisine.' },
      { type: 'heading', text: 'Les 5 piliers du goÃ»t' },
      { type: 'technique', title: 'Le salÃ© â€” amplificateur universel', text: 'Le sel ne sale pas seulement : il amplifie tous les autres arÃ´mes. Sel fin pour assaisonner en cours de cuisson, fleur de sel pour finir. Saler en plusieurs fois, dÃ¨s le dÃ©but (lÃ©gumes, eau de cuisson, sauces), pas uniquement Ã  la fin.' },
      { type: 'technique', title: 'L\'aciditÃ© â€” le rÃ©vÃ©lateur', text: 'Un filet de citron, une cuillÃ¨re de vinaigre ou un verre de vin blanc aprÃ¨s la cuisson "ouvre" les saveurs d\'un plat qui semblait fade. L\'acide Ã©quilibre aussi les plats trop gras ou trop sucrÃ©s. Sources : citron, vinaigre (balsamique, de vin, de cidre), tomate, yaourt.' },
      { type: 'technique', title: 'Le sucrÃ© â€” Ã©quilibreur', text: 'Une pincÃ©e de sucre dans une sauce tomate acide ou une rÃ©duction de vinaigre balsamique change tout. Le sucrÃ© attÃ©nue l\'amertume et l\'aciditÃ©. Ne jamais en mettre trop â€” le but est de ne pas sentir le sucre, juste de gommer un dÃ©sÃ©quilibre.' },
      { type: 'technique', title: 'L\'umami â€” la profondeur', text: 'Saveur de "5e goÃ»t" : bouillon rÃ©duit, parmesan, champignons sÃ©chÃ©s, sauce soja, tomate concentrÃ©e, anchois. L\'umami donne la sensation de plat "qui a du fond". Une cuillÃ¨re de parmesan rÃ¢pÃ© dans une soupe de lÃ©gumes la transforme complÃ¨tement.' },
      { type: 'technique', title: 'L\'amer â€” la sophistication', text: 'CafÃ©, chocolat noir, radicchio, endive, zeste. L\'amer en petite dose apporte complexitÃ© et Ã©quilibre le sucrÃ©. En excÃ¨s, il domine tout. Le beurre, le gras ou le sucrÃ© adoucissent un amer trop prononcÃ©.' },
      { type: 'heading', text: 'Herbes aromatiques' },
      { type: 'technique', title: 'Herbes fragiles â€” en fin de cuisson', text: 'Basilic, coriandre, persil plat, ciboulette, estragon, menthe. La chaleur dÃ©truit leurs arÃ´mes volatils en quelques secondes. Les ajouter hors du feu, juste avant de servir. Le basilic noircit aussi par pression â€” ciseler, jamais hacher.' },
      { type: 'technique', title: 'Herbes robustes â€” en dÃ©but de cuisson', text: 'Thym, romarin, sauge, laurier, origan. Leurs huiles essentielles rÃ©sistent Ã  la chaleur et se libÃ¨rent avec le temps. Les ajouter en dÃ©but de cuisson pour une infusion progressive dans la matiÃ¨re grasse ou le liquide.' },
      { type: 'tip', text: 'Le bouquet garni classique (thym + laurier + queue de persil) est la base de 80 % des plats mijotÃ©s franÃ§ais. On le met au dÃ©but, on le retire avant de servir.' },
      { type: 'heading', text: 'Ã‰pices et zestes' },
      { type: 'technique', title: 'TorrÃ©fier les Ã©pices', text: 'Passer les Ã©pices entiÃ¨res 1-2 minutes Ã  sec dans une poÃªle chaude avant de les moudre. La chaleur libÃ¨re les huiles essentielles et multiplie leur intensitÃ©. Indispensable pour cumin, coriandre, cardamome, poivre.' },
      { type: 'technique', title: 'Les zestes d\'agrumes', text: 'Ne prÃ©lever que la partie colorÃ©e, jamais le blanc (albÃ©do) qui est amer. Zester au-dessus du plat pour capturer les huiles essentielles qui s\'en Ã©chappent. Une pincÃ©e de zeste de citron dans un risotto, une vinaigrette ou une crÃ¨me change la dimension du plat.' },
      { type: 'warning', text: 'Ne jamais assaisonner une viande crue et la laisser reposer longtemps avec du sel â€” il commence Ã  "cuire" les protÃ©ines et peut assÃ©cher la chair. Saler juste avant la cuisson, ou au moins 40 minutes avant (saumurage Ã  sec).' },
      { type: 'tip', text: 'La rÃ¨gle d\'or : goÃ»te toujours avant de servir. Ton nez peut te dire si un plat manque d\'aciditÃ© ou d\'umami, mais seule ta bouche peut confirmer l\'Ã©quilibre final. GoÃ»te et rectifie.' },
      { type: 'recap', text: 'Sel â†’ amplifie. Acide â†’ rÃ©vÃ¨le et Ã©quilibre. SucrÃ© â†’ adoucit. Umami â†’ donne de la profondeur. Amer â†’ complexifie. Herbes fragiles en fin, robustes en dÃ©but. Toujours goÃ»ter avant de servir.' },
      { type: 'exercise', text: 'PrÃ©pare un bouillon de lÃ©gumes simple (eau + carotte + oignon + cÃ©leri). GoÃ»te Ã  blanc. Ajoute du sel progressivement, goÃ»te. Puis un filet de citron, goÃ»te. Puis une pincÃ©e de parmesan rÃ¢pÃ©, goÃ»te. Observe comment chaque ajout transforme la perception du plat.' },
    ]),
  },
  {
    slug: 'bases-patisserie',
    title: 'Les bases de la pÃ¢tisserie',
    description: 'CrÃ¨mes incontournables, pÃ¢tes fondamentales, rÃ¨gles d\'or du four.',
    category: 'baking', skill: 'baking', difficulty: 2, icon: 'cake', gemCost: 30, xpReward: 120, order: 4,
    content: JSON.stringify([
      { type: 'text', text: 'La pÃ¢tisserie est une science exacte. LÃ  oÃ¹ la cuisine tolÃ¨re l\'improvisation, la pÃ¢tisserie exige prÃ©cision, tempÃ©rature et timing. MaÃ®triser les crÃ¨mes de base et les pÃ¢tes fondamentales, c\'est avoir les clÃ©s de 90 % des desserts classiques.' },
      { type: 'heading', text: 'RÃ¨gles d\'or avant de commencer' },
      { type: 'technique', title: 'Peser, ne pas mesurer en volume', text: 'En pÃ¢tisserie, "une tasse de farine" peut varier de 120 Ã  160 g selon la faÃ§on dont on tasse. Toujours peser. Une balance de prÃ©cision au gramme est l\'investissement le plus rentable en pÃ¢tisserie.' },
      { type: 'technique', title: 'TempÃ©rature des ingrÃ©dients', text: 'Beurre "pommade" = 18-20Â°C, mallÃ©able mais pas fondu. Å’ufs Ã  tempÃ©rature ambiante = meilleure Ã©mulsion. CrÃ¨me froide = monte mieux en chantilly. La tempÃ©rature des ingrÃ©dients n\'est pas un dÃ©tail, c\'est une variable critique.' },
      { type: 'tip', text: 'PrÃ©chauffer le four 20 min minimum. La plupart des fours domestiques mettent 15 min Ã  atteindre la tempÃ©rature affichÃ©e â€” et ils mentent souvent de 10 Ã  20Â°C. Un thermomÃ¨tre de four (5â‚¬) est indispensable.' },
      { type: 'heading', text: 'Les crÃ¨mes fondamentales' },
      { type: 'technique', title: 'CrÃ¨me pÃ¢tissiÃ¨re', text: 'Base des Ã©clairs, millefeuilles, tartes aux fruits. Recette : 500 ml lait + 4 jaunes + 100 g sucre (blanchir) + 50 g fÃ©cule de maÃ¯s. Porter le lait Ã  frÃ©missement, verser en filet sur le mÃ©lange jaunes/sucre/fÃ©cule sans cesser de fouetter, puis remettre sur feu moyen en remuant jusqu\'Ã  Ã©paississement (85Â°C). Film au contact, refroidir.' },
      { type: 'technique', title: 'CrÃ¨me chantilly', text: 'CrÃ¨me entiÃ¨re (min 30% MG) trÃ¨s froide, bol et fouet au congÃ©lateur 10 min. Fouetter Ã  vitesse moyenne jusqu\'Ã  traces molles, puis rapide jusqu\'Ã  consistance ferme. Ajouter le sucre glace Ã  mi-parcours. S\'arrÃªter Ã  la bonne texture â€” 30 secondes de trop et c\'est du beurre.' },
      { type: 'technique', title: 'CrÃ¨me anglaise', text: 'Base des glaces et des Ã®les flottantes. 500 ml lait + 5 jaunes + 100 g sucre. Blanchir les jaunes avec le sucre, verser le lait chaud, cuire Ã  la nappe (82-84Â°C) : la crÃ¨me nappe la cuillÃ¨re et le trait du doigt tient. Ne jamais dÃ©passer 85Â°C â€” les jaunes coagulent et font des grumeaux.' },
      { type: 'warning', text: 'La crÃ¨me pÃ¢tissiÃ¨re trop cuite ou mal remuÃ©e forme des grumeaux. Si Ã§a arrive, passe au tamis fin ou au mixeur plongeant. La crÃ¨me anglaise au-delÃ  de 85Â°C tourne en scrambled eggs â€” c\'est irrÃ©parable.' },
      { type: 'heading', text: 'Les pÃ¢tes de base' },
      { type: 'technique', title: 'PÃ¢te brisÃ©e', text: 'Pour tartes salÃ©es et sucrÃ©es non-garnies. 250 g farine + 125 g beurre froid en dÃ©s + 1 pincÃ©e sel + 60 ml eau glacÃ©e. Sabler (frotter beurre + farine entre les paumes jusqu\'Ã  texture sable), puis lier avec l\'eau minimum. Ne pas pÃ©trir : former une boule sans travailler. 1h au frais minimum.' },
      { type: 'technique', title: 'PÃ¢te sucrÃ©e', text: 'Pour tartes sucrÃ©es et fonds de gÃ¢teaux. 250 g farine + 150 g beurre pommade + 100 g sucre glace + 1 jaune + 1 pincÃ©e sel. CrÃ©mer beurre + sucre, ajouter le jaune, puis la farine en une fois. Fraiser (pousser la pÃ¢te contre le plan de travail) une fois, filmer, rÃ©frigÃ©rer 1h. Plus fragile que la brisÃ©e, ne pas trop travailler.' },
      { type: 'technique', title: 'GÃ©noise', text: 'Base des biscuits de Savoie, bÃ»ches, entremets. 4 Å“ufs + 120 g sucre (au bain-marie jusqu\'Ã  50Â°C, monter au ruban) + 120 g farine tamisÃ©e (incorporer en pluie en 3 fois en soulevant). Four 180Â°C, 20-25 min. Ne pas ouvrir le four avant 18 min.' },
      { type: 'tip', text: 'Pour vÃ©rifier la cuisson d\'un biscuit ou d\'un gÃ¢teau : piquer avec un couteau ou une aiguille. Il doit ressortir sec. Si la pointe ressort humide, prolonger par tranches de 3 minutes.' },
      { type: 'warning', text: 'Ne jamais ouvrir le four en cours de cuisson d\'une gÃ©noise ou d\'un soufflÃ© â€” le choc thermique fait retomber la prÃ©paration. Attendre 80 % du temps de cuisson indiquÃ© avant de vÃ©rifier.' },
      { type: 'recap', text: 'CrÃ¨me pÃ¢tissiÃ¨re : liaison chaude Ã  85Â°C, film au contact. Chantilly : crÃ¨me froide, arrÃªter au bon moment. PÃ¢te brisÃ©e : sabler, lier minimum, ne pas pÃ©trir. PÃ¢te sucrÃ©e : crÃ©mer, fraiser, refroidir. GÃ©noise : Å“ufs montÃ©s, farine en pluie.' },
      { type: 'exercise', text: 'RÃ©alise une crÃ¨me pÃ¢tissiÃ¨re. Couvre-la d\'un film au contact, laisse refroidir 1h au rÃ©frigÃ©rateur. Elle doit Ãªtre lisse, sans grumeaux, et suffisamment ferme pour tenir sur une cuillÃ¨re retournÃ©e. C\'est la base de ta premiÃ¨re tarte aux fraises.' },
    ]),
  },
  {
    slug: 'maitrise-saisie',
    title: 'MaÃ®triser la saisie',
    description: 'La rÃ©action de Maillard, la croÃ»te parfaite, le repos : tout sur la cuisson des protÃ©ines.',
    category: 'fire', skill: 'fire', difficulty: 2, icon: 'flame', gemCost: 30, xpReward: 120, order: 5,
    content: JSON.stringify([
      { type: 'text', text: 'La saisie est l\'une des techniques les plus mal exÃ©cutÃ©es en cuisine amateur. RÃ©sultat : une viande grise, bouillie dans son jus, sans croÃ»te. Pourtant, les rÃ¨gles sont simples. Les comprendre transforme immÃ©diatement tes cuissons.' },
      { type: 'heading', text: 'La rÃ©action de Maillard' },
      { type: 'technique', title: 'Ce qui se passe chimiquement', text: 'Ã€ partir de 150Â°C, les acides aminÃ©s et les sucres rÃ©ducteurs en surface rÃ©agissent pour former des centaines de molÃ©cules aromatiques : c\'est la rÃ©action de Maillard. Elle crÃ©e la croÃ»te dorÃ©e, les arÃ´mes de grillÃ©, la saveur umami de la viande bien saisie. Ce n\'est pas une "caramÃ©lisation" â€” c\'est une rÃ©action de brunissement non enzymatique.' },
      { type: 'warning', text: 'Si la poÃªle n\'est pas assez chaude, la viande libÃ¨re de l\'eau avant d\'atteindre 150Â°C. L\'eau forme de la vapeur qui empÃªche le contact avec la surface. RÃ©sultat : la viande cuit Ã  la vapeur, devient grise, pas de croÃ»te. C\'est l\'erreur nÂ°1.' },
      { type: 'heading', text: 'PrÃ©parer la saisie' },
      { type: 'technique', title: 'Choisir la bonne poÃªle', text: 'Fonte ou acier : conduisent et retiennent mieux la chaleur que l\'inox. L\'inox convient mais demande plus de vigilance. AntiadhÃ©sif : uniquement pour les prÃ©parations dÃ©licates (poisson, Å“ufs). Pour les viandes, Ã©viter â€” il ne monte pas assez chaud.' },
      { type: 'technique', title: 'PrÃ©chauffer correctement', text: 'Feu vif, 3 Ã  4 minutes Ã  vide. Test : quelques gouttes d\'eau doivent s\'Ã©vaporer instantanÃ©ment en crÃ©pitant (effet Leidenfrost). Ajouter la matiÃ¨re grasse 30 secondes avant la viande : huile Ã  haute tempÃ©rature de fumÃ©e (arachide, pÃ©pins de raisin) ou beurre clarifiÃ©.' },
      { type: 'technique', title: 'SÃ©cher la surface', text: 'Essuyer la viande avec du papier absorbant avant de saisir. L\'humiditÃ© en surface = vapeur = pas de Maillard. Pour un rÃ©sultat optimal, laisser la viande Ã  dÃ©couvert au rÃ©frigÃ©rateur 1h avant cuisson (sÃ¨che Ã  l\'air).' },
      { type: 'tip', text: 'Sortir la viande du rÃ©frigÃ©rateur 20-30 min avant cuisson. Une viande froide refroidit la poÃªle dÃ¨s le contact et peut empÃªcher la saisie de dÃ©marrer correctement, surtout pour les piÃ¨ces Ã©paisses.' },
      { type: 'heading', text: 'Pendant la cuisson' },
      { type: 'technique', title: 'Ne pas bouger la piÃ¨ce', text: 'DÃ©poser et ne pas toucher pendant 2-3 min. La viande adhÃ¨re Ã  la poÃªle au dÃ©but, puis se dÃ©colle seule quand la croÃ»te est formÃ©e. Si elle rÃ©siste quand tu essaies de la dÃ©placer, c\'est qu\'elle n\'est pas prÃªte â€” attends.' },
      { type: 'technique', title: 'L\'arrosage au beurre (basting)', text: 'En fin de saisie : ajouter une noix de beurre, thym, ail Ã©crasÃ©. Incliner la poÃªle et arroser continuellement la viande avec le beurre fondu Ã  l\'aide d\'une cuillÃ¨re. Dore et parfume Ã  la fois â€” technique des chefs pour les steaks et cÃ´tes de veau.' },
      { type: 'technique', title: 'Les tempÃ©ratures Ã  cÅ“ur', text: 'BÅ“uf bleu : 45-48Â°C. Saignant : 50-52Â°C. RosÃ© : 55-57Â°C. Ã€ point : 60-63Â°C. Bien cuit : >68Â°C. Poulet min : 74Â°C. Porc : 65Â°C. Poisson mi-cuit : 45-50Â°C. Sans thermomÃ¨tre sonde, la cuisson parfaite est impossible Ã  reproduire.' },
      { type: 'heading', text: 'Le repos â€” Ã©tape cruciale oubliÃ©e' },
      { type: 'technique', title: 'Pourquoi laisser reposer', text: 'Pendant la cuisson, les jus migrent vers le centre. En reposant sur une grille (jamais sur une surface froide), les fibres musculaires se relÃ¢chent et les jus se redistribuent. Sans repos, ils coulent dans l\'assiette. RÃ¨gle : le temps de repos = la moitiÃ© du temps de cuisson, minimum 5 minutes.' },
      { type: 'tip', text: 'Couvrir la viande lÃ¢chement avec du papier aluminium pendant le repos â€” pas hermÃ©tiquement (la vapeur ramolle la croÃ»te). L\'intÃ©rieur continue Ã  cuire lÃ©gÃ¨rement : prÃ©voir 2-3Â°C de moins que la tempÃ©rature cible.' },
      { type: 'recap', text: 'PoÃªle trÃ¨s chaude + viande sÃ¨che = rÃ©action de Maillard. Ne pas bouger = croÃ»te qui se dÃ©colle seule. TempÃ©rature Ã  cÅ“ur avec thermomÃ¨tre. Repos = jus redistribuÃ©s. Ces 4 rÃ¨gles changent tout.' },
      { type: 'exercise', text: 'Prends un steak ou un blanc de poulet. SÃ¨che la surface au papier absorbant, prÃ©chauffe ta poÃªle 3 min Ã  feu vif. Saisis sans bouger, puis arroge au beurre. Mesure la tempÃ©rature Ã  cÅ“ur avec un thermomÃ¨tre. Laisse reposer 5 min. Compare avec ta saisie habituelle.' },
    ]),
  },
  {
    slug: 'coupes-avancees',
    title: 'Coupes avancÃ©es',
    description: 'TournÃ©e, jardiniÃ¨re, paysanne, mandoline : les coupes qui impressionnent et servent.',
    category: 'knife', skill: 'knife', difficulty: 2, icon: 'git-branch', gemCost: 30, xpReward: 120, order: 6,
    content: JSON.stringify([
      { type: 'text', text: 'AprÃ¨s les coupes de base, voici les tailles qui font la diffÃ©rence dans un plat professionnel. Elles servent deux objectifs : l\'esthÃ©tique (prÃ©sentation) et la fonctionnalitÃ© (cuisson homogÃ¨ne, texture en bouche). Une carotte tournÃ©e cuit Ã  la mÃªme vitesse qu\'une autre carotte tournÃ©e â€” la prÃ©cision n\'est pas uniquement dÃ©corative.' },
      { type: 'heading', text: 'Coupes utilitaires' },
      { type: 'technique', title: 'Paysanne', text: 'Tranches de lÃ©gumes de forme irrÃ©guliÃ¨re (triangles, carrÃ©s, demi-cercles), 3-4 mm d\'Ã©paisseur. Coupe rustique pour soupes et ragoÃ»ts â€” la forme importe peu, l\'uniformitÃ© d\'Ã©paisseur est clÃ© pour une cuisson Ã©gale. Technique rapide, parfaite pour les prÃ©parations mijotÃ©es.' },
      { type: 'technique', title: 'JardiniÃ¨re', text: 'BÃ¢tonnets de 4Ã—4Ã—20 mm. Entre la julienne (fine) et la mirepoix (grosse). IdÃ©ale pour les lÃ©gumes d\'accompagnement sautÃ©s ou Ã  la vapeur â€” assez petite pour cuire vite, assez grosse pour avoir de la mÃ¢che. Base des bouquets de lÃ©gumes glacÃ©s.' },
      { type: 'technique', title: 'En losanges / biais', text: 'Couper en diagonale Ã  45Â°, en tranches de 3-5 mm. Donne des formes oblongues Ã©lÃ©gantes. UtilisÃ© pour carottes, courgettes, poireaux, asperges. L\'avantage : plus de surface exposÃ©e Ã  la chaleur = cuisson plus rapide et plus de brunissement.' },
      { type: 'technique', title: 'Ciseler finement les Ã©chalotes', text: 'Couper l\'Ã©chalote en deux, cÃ´tÃ© plat sur la planche. Incisions horizontales parallÃ¨les Ã  la planche (sans couper la racine), puis incisions verticales rapprochÃ©es, puis trancher perpendiculairement. RÃ©sultat : brunoise fine d\'Ã©chalote en quelques secondes.' },
      { type: 'heading', text: 'La taille tournÃ©e' },
      { type: 'technique', title: 'LÃ©gumes tournÃ©s', text: 'Tailler en forme de football amÃ©ricain Ã  7 facettes Ã©gales, 4-5 cm de long. Technique classique de la cuisine franÃ§aise pour les carottes, navets, pommes de terre. On utilise un couteau Ã  tourner (ou un office). Tenir le lÃ©gume entre pouce et index, tourner le lÃ©gume vers soi en incisant. C\'est la taille la plus difficile â€” la rÃ©gularitÃ© vient avec la pratique.' },
      { type: 'tip', text: 'Les chutes des lÃ©gumes tournÃ©s ne sont pas perdues : elles servent pour les bouillons, les purÃ©es ou les veloutÃ©s. En cuisine professionnelle, rien ne se jette.' },
      { type: 'heading', text: 'La mandoline' },
      { type: 'technique', title: 'Utiliser une mandoline', text: 'Pour les tranches ultra-fines (1-2 mm) impossibles au couteau : fenouil, betterave, radis, courgette. Toujours utiliser le protÃ¨ge-doigts fourni, jamais les mains nues. Mouvement rÃ©gulier, pression constante. La lame est chirurgicale â€” mÃªme une coupure lÃ©gÃ¨re est profonde.' },
      { type: 'warning', text: 'La mandoline est l\'outil le plus dangereux de la cuisine. Aucune exception : toujours le protÃ¨ge-doigts. Quand le lÃ©gume devient trop petit pour Ãªtre tenu en sÃ©curitÃ©, s\'arrÃªter â€” la chute n\'est pas un luxe.' },
      { type: 'heading', text: 'Entretien du couteau' },
      { type: 'technique', title: 'AffÃ»tage au fusil', text: 'Avant chaque utilisation : 5-6 passes de chaque cÃ´tÃ© au fusil Ã  20Â°. Le fusil rÃ©aligne le fil sans enlever de mÃ©tal. Il "rafraÃ®chit" le tranchant entre les affÃ»tages profonds.' },
      { type: 'technique', title: 'AffÃ»tage Ã  la pierre', text: 'Tous les 2-3 mois selon l\'usage. Pierre grain 1000 (affÃ»tage) puis grain 3000-6000 (finition). Angle constant Ã  15-20Â° selon le couteau. Ajouter de l\'eau ou de l\'huile selon la pierre. 10-15 passes de chaque cÃ´tÃ©, puis finir au fusil.' },
      { type: 'tip', text: 'Test du papier : un couteau bien affÃ»tÃ© coupe une feuille de papier en un seul mouvement, sans dÃ©chirer. Test de la tomate : si la tomate s\'Ã©crase au lieu d\'Ãªtre tranchÃ©e, le couteau est Ã©moussÃ©.' },
      { type: 'recap', text: 'Paysanne â†’ rustique, soupe. JardiniÃ¨re â†’ sautÃ©, accompagnement. Biais â†’ lÃ©gumes Ã©lÃ©gants, plus de surface. TournÃ©e â†’ prÃ©sentation classique. Mandoline â†’ ultra-fine avec protÃ¨ge-doigts OBLIGATOIRE.' },
      { type: 'exercise', text: 'Taille 3 carottes en jardiniÃ¨re (4Ã—4Ã—20 mm). Puis taille 2 tranches de fenouil Ã  la mandoline (2 mm). Observe la diffÃ©rence de rÃ©gularitÃ© entre le couteau et la mandoline. Fais sauter les carottes Ã  la poÃªle â€” leur cuisson est uniforme ? Si non, tes tailles n\'Ã©taient pas assez rÃ©guliÃ¨res.' },
    ]),
  },
  {
    slug: 'cuisson-basse-temp',
    title: 'Cuisson basse tempÃ©rature',
    description: 'La science de la cuisson douce : tempÃ©ratures, timing, technique du bain-marie.',
    category: 'fire', skill: 'fire', difficulty: 3, icon: 'thermometer', gemCost: 50, xpReward: 180, order: 7,
    content: JSON.stringify([
      { type: 'text', text: 'La cuisson basse tempÃ©rature est l\'une des rÃ©volutions de la cuisine moderne. Entre 55 et 80Â°C, les protÃ©ines coagulent sans se contracter violemment. RÃ©sultat : viandes d\'une tendretÃ© exceptionnelle, jus conservÃ©s, textures impossibles Ã  obtenir Ã  feu vif. C\'est la technique des cuisiniers Ã©toilÃ©s â€” et elle est accessible.' },
      { type: 'heading', text: 'La science derriÃ¨re' },
      { type: 'technique', title: 'Pourquoi les protÃ©ines durcissent Ã  la chaleur', text: 'Ã€ haute tempÃ©rature (>70Â°C), les fibres musculaires se contractent fortement et expulsent leur eau. C\'est pour Ã§a qu\'une cÃ´te de bÅ“uf bien cuite est sÃ¨che. En dessous de 65Â°C, les fibres coagulent mais restent souples, les jus restent Ã  l\'intÃ©rieur. La diffÃ©rence de 10Â°C change tout.' },
      { type: 'technique', title: 'Le collagÃ¨ne et le temps', text: 'Les morceaux durs (paleron, joue, jarret) sont riches en collagÃ¨ne. Ce collagÃ¨ne se transforme en gÃ©latine Ã  partir de 70Â°C â€” mais seulement avec le temps (3-8 heures). C\'est pourquoi un bÅ“uf bourguignon mijotÃ© 3h est fondant alors qu\'une cÃ´te de bÅ“uf Ã  70Â°C pendant 20 min serait sÃ¨che.' },
      { type: 'heading', text: 'TempÃ©ratures cibles par protÃ©ine' },
      { type: 'technique', title: 'BÅ“uf et agneau', text: 'Bleu : 45-48Â°C. Saignant : 50-52Â°C. RosÃ© (recommandÃ©) : 55-57Â°C. Ã€ point : 60-63Â°C. Bien cuit : >68Â°C. Pour un rÃ´ti basse tempÃ©rature : four Ã  65Â°C, temps calculÃ© selon l\'Ã©paisseur (30 min par cm). Toujours terminer par une saisie Ã  feu vif pour la croÃ»te.' },
      { type: 'technique', title: 'Volaille', text: 'Poulet minimum 74Â°C (sÃ©curitÃ© alimentaire). Canard magret rosÃ© : 58-60Â°C. Dinde entiÃ¨re : 74Â°C Ã  cÅ“ur dans la partie la plus Ã©paisse (cuisse). La volaille est moins indulgente que le bÅ“uf â€” ne pas descendre sous les seuils de sÃ©curitÃ©.' },
      { type: 'technique', title: 'Poisson', text: 'Mi-cuit (nacrÃ©) : 45-50Â°C. Cuit Ã  cÅ“ur : 55-60Â°C. Le poisson est extrÃªmement sensible : 5Â°C de trop et les protÃ©ines se dÃ©sagrÃ¨gent. Le bain-marie au four Ã  60Â°C est idÃ©al pour un saumon entier ou un filet Ã©pais.' },
      { type: 'technique', title: 'Porc et veau', text: 'Porc rosÃ© : 63Â°C (OMS 2011, revu Ã  la baisse de 71Â°C). Veau rosÃ© : 58-60Â°C. Le filet de porc Ã  basse tempÃ©rature reste rosÃ© et incroyablement juteux â€” Ã  l\'opposÃ© du filet sec et gris de la cuisson traditionnelle.' },
      { type: 'heading', text: 'Techniques pratiques sans matÃ©riel pro' },
      { type: 'technique', title: 'MÃ©thode four + thermomÃ¨tre', text: 'Four Ã  65-75Â°C (chaleur tournante). Saisir la piÃ¨ce en cocotte Ã  feu vif pour le Maillard. Enfourner avec thermomÃ¨tre sonde, alarme rÃ©glÃ©e sur la tempÃ©rature cible moins 3Â°C (la cuisson continue aprÃ¨s sortie). Temps indicatif : 30-45 min par cm d\'Ã©paisseur.' },
      { type: 'technique', title: 'Le bain-marie au four', text: 'Pour les poissons et prÃ©parations dÃ©licates. Plat dans un bain d\'eau chaude (80Â°C), four Ã  80-90Â°C. L\'eau ne dÃ©passe jamais 100Â°C et rÃ©gule parfaitement la tempÃ©rature. IdÃ©al pour terrine, pÃ¢tÃ©, crÃ¨me brÃ»lÃ©e, saumon entier.' },
      { type: 'technique', title: 'La glaciÃ¨re comme bain-marie', text: 'Pour maintenir une tempÃ©rature prÃ©cise sans matÃ©riel : remplir une glaciÃ¨re d\'eau Ã  la bonne tempÃ©rature (vÃ©rifier avec thermomÃ¨tre). Immerger la piÃ¨ce emballÃ©e sous vide (sac congÃ©lation zip avec l\'air chassÃ©). Surveiller toutes les 30 min. Technique "pauvre" mais efficace pour les cuissons longues.' },
      { type: 'warning', text: 'Ne jamais maintenir un aliment dans la zone de danger : 4Â°C Ã  60Â°C est la plage de dÃ©veloppement des bactÃ©ries. Les cuissons basse tempÃ©rature autour de 55Â°C doivent Ãªtre courtes (<4h) ou utiliser une pasteurisation prÃ©cise. Pour les longues cuissons (>4h), rester Ã  65Â°C minimum.' },
      { type: 'tip', text: 'Un thermomÃ¨tre sonde Ã  lecture instantanÃ©e (15-30â‚¬) est l\'investissement qui change le plus la cuisine. Il rend la cuisson reproductible. Sans lui, mÃªme un chef expÃ©rimentÃ© ne peut garantir un rÃ©sultat constant.' },
      { type: 'recap', text: 'ProtÃ©ines < 65Â°C = tendres et juteuses. CollagÃ¨ne + temps = gÃ©latine fondante. Saisie avant ou aprÃ¨s pour la croÃ»te. ThermomÃ¨tre indispensable. Ne pas rester en zone 4-60Â°C plus de 4h. Four + bain-marie = technique accessible sans matÃ©riel pro.' },
      { type: 'exercise', text: 'Cuis un filet de saumon Ã©pais (3 cm) au bain-marie : four Ã  80Â°C, plat dans de l\'eau chaude, 20-25 min. ContrÃ´le la tempÃ©rature Ã  cÅ“ur : 48-50Â°C pour mi-cuit nacrÃ©. Compare la texture avec un saumon cuit Ã  la poÃªle Ã  feu vif. La diffÃ©rence est radicale.' },
    ]),
  },
  {
    slug: 'oeufs-mille-facons',
    title: 'Les Å“ufs : 10 techniques maÃ®trisÃ©es',
    description: 'PochÃ©, mollet, en cocotte, mayonnaiseâ€¦ L\'Å“uf est le couteau suisse de la cuisine.',
    category: 'fire', skill: 'fire', difficulty: 1, icon: 'egg', gemCost: 0, xpReward: 80, order: 4,
    content: JSON.stringify([
      { type: 'text', text: 'L\'Å“uf est l\'ingrÃ©dient le plus polyvalent de la cuisine. Il lie, Ã©mulsionne, lÃ¨ve, Ã©paissit, colore et nourrit. Chaque technique de cuisson donne un rÃ©sultat radicalement diffÃ©rent. Les maÃ®triser toutes, c\'est dÃ©bloquer une palette technique immense.' },
      { type: 'heading', text: 'Comprendre l\'Å“uf' },
      { type: 'technique', title: 'La structure', text: 'Le blanc (albumine, 60 % de l\'Å“uf) coagule Ã  partir de 62Â°C. Le jaune (lipides + protÃ©ines) coagule Ã  68-70Â°C. Cette diffÃ©rence de 6-8Â°C est la clÃ© de toutes les cuissons prÃ©cises : mollet, coulant, pochÃ© mi-cuit.' },
      { type: 'technique', title: 'FraÃ®cheur', text: 'Test de flottabilitÃ© : plonger dans un verre d\'eau. Frais â†’ tombe au fond Ã  plat. 1 semaine â†’ se redresse lÃ©gÃ¨rement. 3 semaines â†’ flotte. Un Å“uf qui flotte = Ã  jeter. Frais â‰  meilleur pour tout : un Å“uf de 1 semaine se pÃ¨le mieux dur, un Å“uf trÃ¨s frais est meilleur pochÃ©.' },
      { type: 'heading', text: 'Les 10 cuissons' },
      { type: 'technique', title: '1. Ã€ la coque (3 min)', text: 'Eau bouillante, Å“uf Ã  tempÃ©rature ambiante (choc thermique sinon fissure). 3 minutes exactement. Blanc tremblant, jaune totalement liquide. Mouillettes indispensables.' },
      { type: 'technique', title: '2. Mollet (6 min)', text: '6 minutes dans l\'eau bouillante. Blanc ferme, jaune crÃ©meux coulant au centre. Difficile Ã  peler : choc thermique eau glacÃ©e 2 min obligatoire, puis rouler doucement sur le plan de travail.' },
      { type: 'technique', title: '3. Dur (10-12 min)', text: '10 min pour jaune ferme mais encore lÃ©gÃ¨rement moelleux. 12 min = jaune sec. Choc thermique impÃ©ratif sinon le jaune vire au vert-gris (rÃ©action soufre/fer). Peler sous l\'eau froide courante.' },
      { type: 'technique', title: '4. PochÃ©', text: 'Eau frÃ©missante (88-90Â°C, jamais bouillante) + filet de vinaigre blanc. CrÃ©er un tourbillon, casser l\'Å“uf dans un ramequin d\'abord, glisser dÃ©licatement. 3 minutes. Retirer avec Ã©cumoire, Ã©ponger. Le vinaigre aide le blanc Ã  coaguler autour du jaune â€” l\'Å“uf trÃ¨s frais est indispensable.' },
      { type: 'technique', title: '5. Au plat / miroir', text: 'Beurre (ou huile) Ã  feu trÃ¨s doux. Casser dÃ©licatement. Couvrir avec couvercle â€” la vapeur cuit le dessus sans croÃ»te. Blanc pris, jaune voilÃ© mais coulant. Variante : Å“uf au plat classique = sans couvercle, blanc croustillant sur les bords, jaune liquide.' },
      { type: 'technique', title: '6. BrouillÃ©s (la technique pro)', text: 'Feu minimum. Beurre fondu. Å’ufs battus avec sel et poivre. Remuer en permanence avec spatule souple. La cuisson prend 5-7 minutes Ã  feu doux. Retirer avant que ce soit "cuit" â€” la chaleur rÃ©siduelle finit. Ajouter crÃ¨me fraÃ®che hors du feu. RÃ©sultat : texture crÃ©meuse, presque liquide, comme un nuage.' },
      { type: 'technique', title: '7. En cocotte', text: 'Ramequin beurrÃ©, fond de crÃ¨me ou coulis. Casser l\'Å“uf dedans. Bain-marie au four 180Â°C, 8-10 minutes (blanc pris, jaune coulant). Couvrir avec papier alu si le dessus dore trop vite. IdÃ©al avec truffe, champignons ou jambon IbÃ©rique.' },
      { type: 'technique', title: '8. Omelette', text: 'Fouetter les Å“ufs 30 secondes (pas trop â€” la mousse donne une omelette moins soyeuse). Beurre noisette Ã  feu vif. Verser les Å“ufs, spatule en bois pour ramener vers le centre. Plier en portefeuille avant que le dessus soit sec â€” l\'intÃ©rieur bave lÃ©gÃ¨rement. Glisser sur l\'assiette sans la retourner.' },
      { type: 'technique', title: '9. Mayonnaise maison', text: '1 jaune + 1 c. moutarde + sel + poivre. Fouetter. Ajouter 20 cl d\'huile goutte Ã  goutte au dÃ©but, puis en filet mince. L\'Ã©mulsion se forme si jaune + huile sont Ã  mÃªme tempÃ©rature. Si elle tranche : recommencer avec un jaune frais, ajouter la mayonnaise tranchÃ©e en filet dedans.' },
      { type: 'technique', title: '10. Å’ufs Ã  65Â°C', text: 'La cuisson ultime : four Ã  vapeur ou bain-marie Ã  65Â°C exactement, 1 heure. Le blanc est tout juste pris (gÃ©latineux), le jaune est coulant et d\'une onctuositÃ© extrÃªme. Texture unique impossible Ã  obtenir autrement. Technique des restaurants Ã©toilÃ©s.' },
      { type: 'warning', text: 'Ne jamais cuire des Å“ufs pochÃ©s ou mollets pour personnes vulnÃ©rables (femmes enceintes, enfants, immunodÃ©primÃ©s) â€” le jaune n\'est pas pasteurisÃ©.' },
      { type: 'tip', text: 'Pour une omelette parfaitement jaune pÃ¢le (sans marron), utiliser une poÃªle antiadhÃ©sive et feu moyen-doux. Une omelette "trop cuite" Ã  la franÃ§aise a encore l\'air crue en surface â€” c\'est voulu.' },
      { type: 'recap', text: 'Coque 3 min â†’ mollet 6 min â†’ dur 10 min. PochÃ© : vinaigre + tourbillon. BrouillÃ©s : feu doux, crÃ¨me hors feu. Omelette : plier avant que ce soit sec. Mayo : mÃªme tempÃ©rature jaune/huile. 65Â°C : texture unique.' },
      { type: 'exercise', text: 'Fais les 3 cuissons de base en 15 minutes : un Å“uf Ã  la coque (3 min), un mollet (6 min), un pochÃ©. Compare les textures. Le mollet doit avoir le blanc ferme et le jaune crÃ©meux â€” s\'il est identique au dur, tu as cuit trop longtemps.' },
    ]),
  },
  {
    slug: 'sauces-meres',
    title: 'Les 5 sauces mÃ¨res',
    description: 'BÃ©chamel, veloutÃ©, espagnole, hollandaise, tomate : les ADN de toute la gastronomie franÃ§aise.',
    category: 'fire', skill: 'fire', difficulty: 2, icon: 'droplets', gemCost: 30, xpReward: 120, order: 9,
    content: JSON.stringify([
      { type: 'text', text: 'Auguste Escoffier codifie au XIXe siÃ¨cle les 5 sauces mÃ¨res : toutes les sauces classiques en dÃ©rivent. Les maÃ®triser, c\'est dÃ©tenir les fondations de la gastronomie franÃ§aise et d\'une partie de la gastronomie mondiale. Chaque sauce repose sur une technique prÃ©cise, reproductible, immuable.' },
      { type: 'heading', text: '1. La bÃ©chamel' },
      { type: 'technique', title: 'Recette et technique', text: 'Roux blanc (beurre + farine en Ã©gales proportions, 50 g chacun) cuit 2 minutes sans coloration. Verser 500 ml lait chaud en fouettant sans cesse. Cuire 5 minutes jusqu\'Ã  Ã©paississement, sel, poivre, noix de muscade. Ã‰paisseur variable : plus de farine = plus Ã©paisse (garniture soufflÃ©) ; moins = plus fluide (lasagnes).' },
      { type: 'technique', title: 'DÃ©rivÃ©es', text: 'Mornay = bÃ©chamel + jaune d\'Å“uf + gruyÃ¨re rÃ¢pÃ© (gratin dauphinois, croque-monsieur). Soubise = bÃ©chamel + oignons fondus passÃ©s au tamis (accompagnement). Nantua = bÃ©chamel + beurre d\'Ã©crevisse (quenelles).' },
      { type: 'heading', text: '2. Le veloutÃ©' },
      { type: 'technique', title: 'Recette et technique', text: 'Roux blanc + fond blanc (volaille, veau ou poisson selon le plat) au lieu du lait. MÃªme technique, mÃªme ratio, mais rÃ©sultat plus dÃ©licat et savoureux. 500 ml de fond pour 50 g de roux. RÃ©duire lÃ©gÃ¨rement, assaisonner. La qualitÃ© du fond conditionne tout.' },
      { type: 'technique', title: 'DÃ©rivÃ©es', text: 'Sauce Allemande = veloutÃ© de veau + jaunes d\'Å“ufs + crÃ¨me (liaison Ã  l\'Å“uf). SuprÃªme = veloutÃ© de volaille + crÃ¨me rÃ©duite + beurre montÃ© (volailles pochÃ©es). Vin blanc = veloutÃ© de poisson + vin blanc rÃ©duit + crÃ¨me (sole, bar).' },
      { type: 'heading', text: '3. La sauce espagnole (fond brun)' },
      { type: 'technique', title: 'Recette et technique', text: 'Roux brun (beurre + farine cuits jusqu\'Ã  coloration noisette, 10-15 min) + fond brun (os rÃ´tis + lÃ©gumes caramÃ©lisÃ©s + eau rÃ©duite plusieurs heures). Long, complexe, riche. La base de toute cuisine braisÃ©e et de tous les jus.' },
      { type: 'technique', title: 'DÃ©rivÃ©es', text: 'Demi-glace = espagnole rÃ©duite de moitiÃ© (texture sirupeuse, intense). Bordelaise = demi-glace + Ã©chalotes + vin de Bordeaux + moelle (entrecÃ´te). Chasseur = demi-glace + champignons + tomates + estragon (volaille). PÃ©rigueux = demi-glace + truffe.' },
      { type: 'heading', text: '4. La sauce hollandaise' },
      { type: 'technique', title: 'Recette et technique', text: 'RÃ©duction de vinaigre blanc + poivre mignonette (2 c.) â†’ concentrÃ©e Ã  1 c. Fouetter 3 jaunes avec la rÃ©duction refroidie au bain-marie (60-65Â°C) jusqu\'au ruban. Monter en incorporant 200 g de beurre clarifiÃ© fondu en filet continu en fouettant. Assaisonner, jus de citron. TempÃ©rature critique : si dÃ©passe 68Â°C, les jaunes coagulent â€” bain-marie pas trop chaud.' },
      { type: 'technique', title: 'DÃ©rivÃ©es', text: 'BÃ©arnaise = rÃ©duction Ã©chalotes/estragon/vinaigre + estragon frais Ã  la fin (steak, poisson gras). Mousseline = hollandaise + crÃ¨me fouettÃ©e incorporÃ©e au dernier moment (texture aÃ©rienne, asperges). Maltaise = hollandaise + jus de sanguine (poisson, asperges).' },
      { type: 'heading', text: '5. La sauce tomate' },
      { type: 'technique', title: 'Recette et technique', text: 'Oignon + carotte (mirepoix) suÃ©s dans huile d\'olive. ConcentrÃ© de tomate caramÃ©lisÃ© 2 min. Tomates entiÃ¨res pelÃ©es concassÃ©es + bouquet garni + sel. Mijoter 30-45 min Ã  feu doux. Mixer ou passer au chinois selon texture souhaitÃ©e. L\'aciditÃ© se neutralise avec une pincÃ©e de sucre ou en allongeant la cuisson.' },
      { type: 'technique', title: 'DÃ©rivÃ©es', text: 'Arrabbiata = tomate + piment frais + ail (pÃ¢tes). Napolitaine = tomate + basilic + ail (pizza, pÃ¢tes simples). Sauce vierge = tomates crues concassÃ©es + basilic + huile d\'olive (poisson chaud, tartares).' },
      { type: 'warning', text: 'La hollandaise et la bÃ©arnaise sont des sauces instables Ã  tempÃ©rature : si elles refroidissent ou restent trop longtemps, elles se sÃ©parent. Les maintenir Ã  55-60Â°C au bain-marie chaud, servir dans les 2 heures.' },
      { type: 'tip', text: 'Un bon fond est irremplaÃ§able. La diffÃ©rence entre un plat amateur et un plat professionnel rÃ©side souvent lÃ  : un fond brun maison fait en 4h transforme une sauce en quelque chose d\'impossible Ã  reproduire avec des cubes.' },
      { type: 'recap', text: 'BÃ©chamel = roux blanc + lait. VeloutÃ© = roux blanc + fond. Espagnole = roux brun + fond brun. Hollandaise = jaunes montÃ©s au beurre clarifiÃ©. Tomate = mirepoix + tomates mijotÃ©es. Chaque sauce engendre une famille de dÃ©rivÃ©es infinies.' },
      { type: 'exercise', text: 'RÃ©alise une bÃ©chamel Ã©paisse (100 g beurre + 100 g farine + 1L lait). Ã€ mi-parcours, prÃ©lÃ¨ve une portion, ajoute du gruyÃ¨re rÃ¢pÃ© et un jaune d\'Å“uf : tu viens de faire une Mornay. Nappe un gratin et passe au four. C\'est ta premiÃ¨re dÃ©rivÃ©e de sauce mÃ¨re.' },
    ]),
  },
  {
    slug: 'emulsions-vinaigrettes',
    title: 'Ã‰mulsions & vinaigrettes',
    description: 'Vinaigrette, mayonnaise, beurre blanc : la science des sauces froides et Ã©mulsionnÃ©es.',
    category: 'seasoning', skill: 'seasoning', difficulty: 2, icon: 'blend', gemCost: 30, xpReward: 120, order: 10,
    content: JSON.stringify([
      { type: 'text', text: 'Une Ã©mulsion, c\'est un mÃ©lange stable de deux liquides qui normalement ne se mÃ©langent pas : huile et eau. La mayonnaise, la vinaigrette, le beurre blanc, la hollandaise sont toutes des Ã©mulsions. Comprendre leur chimie permet de les rÃ©ussir Ã  coup sÃ»r â€” et de les rattraper quand elles tournent.' },
      { type: 'heading', text: 'La chimie des Ã©mulsions' },
      { type: 'technique', title: 'Ã‰mulsifiant : le pont molÃ©culaire', text: 'Un Ã©mulsifiant possÃ¨de une tÃªte hydrophile (aime l\'eau) et une queue lipophile (aime l\'huile). Il s\'interpose entre les deux phases et crÃ©e une liaison stable. La lÃ©cithine du jaune d\'Å“uf est l\'Ã©mulsifiant naturel le plus efficace. La moutarde en contient Ã©galement (mucilage). La casÃ©ine du beurre crÃ©e les Ã©mulsions thermiques.' },
      { type: 'technique', title: 'Ã‰mulsion temporaire vs stable', text: 'Vinaigrette sans moutarde : Ã©mulsion temporaire (se sÃ©pare aprÃ¨s agitation). Avec moutarde : semi-stable (tient 30 min). Mayonnaise avec jaune : stable (tient des jours). Plus il y a d\'Ã©mulsifiant par rapport au volume d\'huile, plus l\'Ã©mulsion est stable.' },
      { type: 'heading', text: 'La vinaigrette parfaite' },
      { type: 'technique', title: 'Ratio et ordre', text: 'RÃ¨gle : 1 part vinaigre pour 3 parts huile. Commencer par le sel dans le vinaigre (il se dissout dans l\'eau, pas dans l\'huile). Moutarde + Ã©chalote ciselÃ©e. Fouetter en ajoutant l\'huile en filet. Poivre Ã  la fin. Le sel dissous dans le vinaigre est la base invisible de toute vinaigrette rÃ©ussie.' },
      { type: 'technique', title: 'Variations', text: 'Vinaigrette balsamique : vinaigre balsamique + huile d\'olive + miel (1 c.). Vinaigrette asiatique : citron vert + sauce soja + huile de sÃ©same + gingembre rÃ¢pÃ©. Vinaigrette crÃ©meuse : 1 yaourt + 1 c. moutarde + filet citron + huile d\'olive. Caesar : jaune cru + anchois mixÃ©s + citron + worcestershire + parmesan + moutarde + huile.' },
      { type: 'heading', text: 'La mayonnaise sans ratage' },
      { type: 'technique', title: 'Protocole infaillible', text: '1 jaune + 1 c. moutarde de Dijon + sel + poivre dans un bol (stabiliser le bol avec un torchon humide). MÃªme tempÃ©rature : jaune et huile Ã  tempÃ©rature ambiante. Commencer avec 5-6 gouttes d\'huile en fouettant vigoureusement â€” l\'Ã©mulsion doit se former avant d\'accÃ©lÃ©rer. Puis filet progressivement croissant. Finir avec quelques gouttes de vinaigre ou citron pour Ã©claircir.' },
      { type: 'technique', title: 'Rattraper une mayo tournÃ©e', text: 'Dans un bol propre : nouveau jaune d\'Å“uf + pincÃ©e sel. Fouetter. Ajouter la mayo tournÃ©e goutte Ã  goutte en fouettant vigoureusement. Le nouveau jaune "raccroche" l\'ancienne Ã©mulsion. Cette technique fonctionne Ã  100 % si la mayo n\'est pas rouillÃ©e (> 24h).' },
      { type: 'technique', title: 'Variantes de la mayo', text: 'AÃ¯oli : mayo + ail pilÃ© (1-4 gousses selon goÃ»t) + huile d\'olive (moitiÃ©). RÃ©moulade : mayo + cÃ¢pres + cornichons + persil + estragon + jus de citron. Tartare : rÃ©moulade + oignon cru trÃ¨s fin. Andalouse : mayo + concentrÃ© de tomate + poivron rouge grillÃ© Ã©mincÃ©.' },
      { type: 'heading', text: 'Le beurre blanc â€” Ã©mulsion thermique' },
      { type: 'technique', title: 'Technique', text: 'RÃ©duire 3 Ã©chalotes ciselÃ©es + 10 cl vin blanc + 5 cl vinaigre jusqu\'Ã  presque sec. Feu trÃ¨s doux. Incorporer 200 g beurre froid coupÃ© en dÃ©s, un Ã  la fois, en fouettant constamment. La casÃ©ine du beurre froid crÃ©e une Ã©mulsion en se fondant dans la rÃ©duction. Ne jamais bouillir aprÃ¨s l\'ajout du beurre â€” l\'Ã©mulsion se casse. Maintenir Ã  60-65Â°C.' },
      { type: 'warning', text: 'Le beurre blanc ne se rÃ©chauffe pas et ne se conserve pas. Il se prÃ©pare Ã  la minute et se sert immÃ©diatement. Si il se sÃ©pare (huile en surface), un cube de beurre froid et un fouet vigoureux peuvent parfois le rattraper si la rÃ©duction est encore intacte.' },
      { type: 'tip', text: 'Une vinaigrette Ã©mulsionnÃ©e tient mieux dans un bocal hermÃ©tique qu\'un bol. Secouer vigoureusement 30 secondes avant usage. Peut se conserver 1 semaine au rÃ©frigÃ©rateur (l\'ail ou l\'Ã©chalote fraÃ®che : 3 jours max).' },
      { type: 'recap', text: 'Ã‰mulsifiant = lÃ©cithine (jaune), mucilage (moutarde), casÃ©ine (beurre). Vinaigrette : sel dans vinaigre d\'abord, ratio 1:3. Mayo : mÃªme tempÃ©rature, huile goutte Ã  goutte au dÃ©but. Beurre blanc : rÃ©duction + beurre froid en dÃ©s, jamais bouillir aprÃ¨s.' },
      { type: 'exercise', text: 'Fais une mayo maison sans robot : jaune + moutarde + 20 cl huile. Si tu rÃ©ussis sans grumeaux ni ratage, passe au beurre blanc : rÃ©duction de vin + beurre froid en dÃ©s. C\'est le test ultime de la maÃ®trise des Ã©mulsions.' },
    ]),
  },
  {
    slug: 'bouillons-fonds',
    title: 'Bouillons & fonds',
    description: 'Fond blanc, fond brun, fumet : les bases liquides qui transforment chaque sauce.',
    category: 'fire', skill: 'fire', difficulty: 2, icon: 'pot', gemCost: 30, xpReward: 120, order: 11,
    content: JSON.stringify([
      { type: 'text', text: 'Un fond est un liquide de cuisson concentrÃ©, aromatique, rÃ©duit. C\'est la diffÃ©rence invisible entre la cuisine amateur et la cuisine de restaurant. Une sauce faite sur fond maison a une profondeur, une intensitÃ© et un corps impossibles Ã  obtenir avec de l\'eau ou des cubes industriels. Apprendre Ã  faire des fonds, c\'est apprendre Ã  cuisiner vraiment.' },
      { type: 'heading', text: 'Les types de fonds' },
      { type: 'technique', title: 'Fond blanc de volaille', text: 'Carcasses + ailettes de poulet (rincÃ©es). Eau froide Ã  hauteur. Porter Ã  frÃ©missement sans faire bouillir. Ã‰cumer soigneusement pendant 10 minutes (impuretÃ©s grises = albumen coagulÃ©). Ajouter mirepoix (carotte, cÃ©leri, oignon), bouquet garni, 10 grains de poivre. FrÃ©mir 2h Ã  feu doux, jamais bouillir (donne un fond trouble). Filtrer au chinois Ã©tamine.' },
      { type: 'technique', title: 'Fond brun de veau', text: 'Os de veau + parures coupÃ©s, rÃ´tis au four 200Â°C 30 min jusqu\'Ã  coloration brun profond. DÃ©graissage si nÃ©cessaire. LÃ©gumes (mirepoix + concentrÃ© de tomate) caramÃ©lisÃ©s dans la plaque. DÃ©glacer avec vin rouge. Couvrir d\'eau froide. FrÃ©mir 4-6h en Ã©cumant. Filtrer. RÃ©duire jusqu\'Ã  consistance nappante = demi-glace.' },
      { type: 'technique', title: 'Fumet de poisson', text: 'ArÃªtes + tÃªtes de poisson blanc (sole, turbot, merlan â€” pas saumon ni thon trop gras). Suer 5 min dans beurre avec Ã©chalotes + fenouil + champignons. Mouiller vin blanc + eau. Jamais plus de 20-25 min de cuisson : au-delÃ , le fumet devient amer. Filtrer immÃ©diatement.' },
      { type: 'technique', title: 'Bouillon de lÃ©gumes', text: 'Oignon brÃ»lÃ© (couper en 2, brÃ»ler cÃ´tÃ© plat dans poÃªle sÃ¨che â€” donne couleur et goÃ»t grillÃ©). Ajouter carotte, cÃ©leri branche, poireau, navet, ail, bouquet garni, poivre, tomate. Eau froide. Bouillir 45 min. Filtrer. Plus versatile que l\'eau, moins concentrÃ© qu\'un fond animal.' },
      { type: 'heading', text: 'Techniques de concentration' },
      { type: 'technique', title: 'La rÃ©duction', text: 'Faire bouillir le fond Ã  dÃ©couvert pour Ã©vaporer l\'eau. Le volume diminue mais les saveurs et la gÃ©latine se concentrent. Un fond rÃ©duit de moitiÃ© = deux fois plus intense. RÃ©duit jusqu\'Ã  texture sirupeuse et collante = glace de viande (un cube congelÃ© = base d\'une sauce entiÃ¨re).' },
      { type: 'technique', title: 'La clarification (consommÃ©)', text: 'Pour obtenir un fond parfaitement transparent : ajouter au fond froid un mÃ©lange de viande hachÃ©e + blanc d\'Å“uf + lÃ©gumes en brunoise (la "clarification"). Chauffer doucement en remuant jusqu\'Ã  formation d\'un "chapeau" de protÃ©ines coagulÃ©es. Laisser frÃ©mir 30 min sans toucher. Filtrer au torchon humide. RÃ©sultat : bouillon cristallin.' },
      { type: 'tip', text: 'Les fonds se congÃ¨lent parfaitement. RÃ©duire jusqu\'Ã  concentration intense, verser dans bacs Ã  glaÃ§ons. Un "cube de fond" sort du congÃ©lateur et suffit Ã  monter une sauce en 5 minutes. Garder toujours du fond congelÃ© : c\'est la ressource la plus prÃ©cieuse d\'une cuisine.' },
      { type: 'warning', text: 'Ne jamais faire bouillir Ã  gros bouillons un fond en cours d\'extraction : les protÃ©ines en suspension rendent le fond trouble. Un frÃ©missement doux (quelques bulles en surface) est la bonne tempÃ©rature. Patience.' },
      { type: 'technique', title: 'Utilisation des fonds', text: 'Fond blanc â†’ veloutÃ©, sauce crÃ¨me, risotto, pocher la volaille. Fond brun â†’ sauce bordelaise, chÃ¢teaubriand, braiser la viande, jus de rÃ´ti. Fumet â†’ sauce vin blanc, beurre blanc, sauce amÃ©ricaine. Bouillon lÃ©gumes â†’ risotto vÃ©gÃ©tarien, soupes, cuire les lÃ©gumes.' },
      { type: 'recap', text: 'Fond blanc : carcasses + eau froide + frÃ©missement 2h. Fond brun : os rÃ´tis + lÃ©gumes caramÃ©lisÃ©s + frÃ©missement 4-6h. Fumet : arÃªtes + vin blanc, 20 min max. Bouillon lÃ©gumes : oignon brÃ»lÃ© + lÃ©gumes 45 min. RÃ©duire = concentrer. Congeler les fonds en cubes.' },
      { type: 'exercise', text: 'La prochaine fois que tu achÃ¨tes un poulet entier, garde la carcasse aprÃ¨s dÃ©sossage. Fais un fond blanc : eau froide, carcasse, oignon brÃ»lÃ©, carotte, cÃ©leri, bouquet garni. 2h de frÃ©missement. Filtre et utilise ce fond pour cuire un risotto â€” la diffÃ©rence avec l\'eau est stupÃ©fiante.' },
    ]),
  },
  {
    slug: 'cuisson-poisson',
    title: 'MaÃ®triser la cuisson du poisson',
    description: 'Peau croustillante, chair nacrÃ©e : les 6 techniques pour ne plus jamais rater un poisson.',
    category: 'fire', skill: 'fire', difficulty: 2, icon: 'fish', gemCost: 30, xpReward: 120, order: 12,
    content: JSON.stringify([
      { type: 'text', text: 'Le poisson est l\'ingrÃ©dient le plus dÃ©licat Ã  cuire. Sa fenÃªtre de cuisson parfaite est de quelques degrÃ©s et quelques secondes. Trop cuit, les protÃ©ines se dÃ©sagrÃ¨gent et le poisson sÃ¨che. Mi-cuit ou juste nacrÃ©, c\'est une expÃ©rience de texture incomparable. MaÃ®triser le poisson, c\'est maÃ®triser la prÃ©cision.' },
      { type: 'heading', text: 'Comprendre le poisson' },
      { type: 'technique', title: 'Structure des protÃ©ines', text: 'Les fibres musculaires du poisson sont courtes et coagulent Ã  basse tempÃ©rature : blanc de poisson Ã  45-55Â°C (contre 65Â°C pour le poulet). ConsÃ©quence : quelques degrÃ©s de trop = protÃ©ines qui se dÃ©sagrÃ¨gent, texture cotonneuse. La prÃ©cision est donc plus critique que pour n\'importe quelle autre protÃ©ine.' },
      { type: 'technique', title: 'FraÃ®cheur : critÃ¨res absolus', text: 'Yeux brillants et bombÃ©s (jamais creux ou opaques). OuÃ¯es rouge vif (jamais marron gris). Chair ferme qui reprend sa forme quand on appuie. Odeur : mer fraÃ®che, iode â€” jamais ammoniac ou poisson fort. Un poisson frais ne sent pas le poisson.' },
      { type: 'heading', text: 'Les 6 techniques' },
      { type: 'technique', title: '1. PoÃªlÃ©e cÃ´tÃ© peau (technique principale)', text: 'Inciser lÃ©gÃ¨rement la peau (Ã©vite la rÃ©traction). SÃ©cher avec papier absorbant. Huile Ã  haute tempÃ©rature de fumÃ©e (arachide), poÃªle chaude. DÃ©poser cÃ´tÃ© peau, appuyer doucement 30 secondes avec spatule pour maintenir contact. Cuire 70-80 % du temps cÃ´tÃ© peau (peau dorÃ©e = croustillante). Retourner 60 secondes. Finir avec noix de beurre + thym.' },
      { type: 'technique', title: '2. Vapeur', text: 'Cuit sans matiÃ¨re grasse, prÃ©serve les arÃ´mes dÃ©licats. IdÃ©al pour poissons maigres (sole, cabillaud, bar). Temps : 5-8 min selon Ã©paisseur. Test : appuyer doucement â€” la chair doit se sÃ©parer en feuillets sans rÃ©sistance. Servir immÃ©diatement : la chair continue Ã  cuire aprÃ¨s sortie du panier.' },
      { type: 'technique', title: '3. Papillote', text: 'Papier cuisson ou alu. Poisson + garniture + liquide (vin blanc, fumet, citron). Fermer hermÃ©tiquement. Four 200Â°C, 10-15 min selon Ã©paisseur. La vapeur interne cuit et parfume. Ouvrir Ã  table : le nuage de vapeur fait partie de l\'expÃ©rience. Le poisson ne sÃ¨che jamais en papillote.' },
      { type: 'technique', title: '4. Four basse tempÃ©rature', text: 'Four 80Â°C. Poisson sur plaque lÃ©gÃ¨rement huilÃ©e. 15-25 min selon Ã©paisseur (calculer 10 min/cm). RÃ©sultat : chair d\'une onctuositÃ© exceptionnelle, jamais sÃ¨che, nacrÃ©e Ã  cÅ“ur. IdÃ©al pour les piÃ¨ces entiÃ¨res et les filets Ã©pais (saumon, cabillaud).' },
      { type: 'technique', title: '5. En croÃ»te de sel', text: 'Gros poisson entier (bar, daurade). Couvrir complÃ¨tement d\'un mÃ©lange sel gros + blanc d\'Å“uf + herbes. Four 200Â°C, 20-30 min. La croÃ»te de sel cuit Ã  la vapeur interne â€” le poisson ne sale pas mais reste incroyablement juteux. Casser la croÃ»te Ã  table. Technique spectaculaire, rÃ©sultat parfait.' },
      { type: 'technique', title: '6. Mi-cuit / gravlax', text: 'Saumon mi-cuit : four 55Â°C 25-30 min, chair nacrÃ©e translucide Ã  cÅ“ur. Gravlax : filet de saumon cru marinÃ© 24-48h sous sel + sucre + aneth + poivre concassÃ©. Le sel "cuit" le poisson par dÃ©shydratation osmotique. Trancher trÃ¨s fin, servir avec crÃ¨me citronnÃ©e.' },
      { type: 'heading', text: 'TempÃ©ratures et temps de cuisson' },
      { type: 'technique', title: 'RepÃ¨res pratiques', text: 'Filet de 2 cm : poÃªlÃ©e 3-4 min cÃ´tÃ© peau + 1 min cÃ´tÃ© chair. Filet de 3 cm : papillote 15 min ou four 80Â°C 20 min. Poisson entier 500g : four 200Â°C 15-20 min, ou croÃ»te de sel 25 min. Test universel : appuyer doucement avec le doigt â€” se sÃ©pare facilement en feuillets = cuit. RÃ©sistance = pas encore prÃªt.' },
      { type: 'warning', text: 'Ne jamais rincer un filet de poisson sous l\'eau â€” Ã§a dÃ©trempe la chair. SÃ©cher au papier absorbant. Ne jamais cuire un filet sorti du rÃ©frigÃ©rateur directement â€” 5-10 min Ã  tempÃ©rature ambiante d\'abord.' },
      { type: 'tip', text: 'Pour une peau parfaitement croustillante : poser le filet cÃ´tÃ© peau sur une planche 5 minutes Ã  l\'air libre avant cuisson. La surface sÃ¨che forme une "croÃ»te" qui croustille mieux.' },
      { type: 'recap', text: 'FraÃ®cheur = yeux brillants + odeur iodÃ©e. PoÃªlÃ©e cÃ´tÃ© peau = 70 % du temps cÃ´tÃ© peau. Vapeur = sans matiÃ¨re grasse, dÃ©licate. Papillote = jamais sec. Four 80Â°C = onctuositÃ© maximale. Mi-cuit = nacrÃ© Ã  cÅ“ur. Test universel : feuillets qui se sÃ©parent facilement.' },
      { type: 'exercise', text: 'Prends 2 filets de saumon identiques. Cuis le premier Ã  la poÃªle cÃ´tÃ© peau (3 min/1 min). Cuis le second au four Ã  80Â°C pendant 20 min. Compare la texture, la jutositÃ©, la couleur. C\'est la mÃªme matiÃ¨re premiÃ¨re â€” deux rÃ©sultats complÃ¨tement diffÃ©rents selon la technique.' },
    ]),
  },
  {
    slug: 'liaisons-epaississants',
    title: 'Liaisons & Ã©paississants',
    description: 'Roux, liaison Ã  l\'Å“uf, agar-agar, fÃ©cule : Ã©paissir avec prÃ©cision selon le rÃ©sultat voulu.',
    category: 'seasoning', skill: 'seasoning', difficulty: 3, icon: 'beaker', gemCost: 50, xpReward: 180, order: 13,
    content: JSON.stringify([
      { type: 'text', text: 'Ã‰paissir une sauce ou un liquide, c\'est transformer sa texture pour qu\'il nappe, colle, gÃ©lifie ou crÃ¨me. Chaque agent Ã©paississant a ses propriÃ©tÃ©s physico-chimiques propres : tempÃ©ratures d\'activation, rÃ©sistance Ã  l\'aciditÃ©, transparence, texture finale. Choisir le bon outil change tout.' },
      { type: 'heading', text: 'Les liaisons classiques Ã  la chaleur' },
      { type: 'technique', title: 'Le roux', text: 'Beurre fondu + farine (ratio 1:1 en poids). Cuire ensemble 2 min (roux blanc) Ã  10-15 min (roux brun) selon l\'utilisation. La chaleur inactive les enzymes de la farine qui donneraient un goÃ»t farineux. Verser le liquide chaud sur le roux chaud (ou froid sur froid) en fouettant. Ã‰paississement Ã  l\'Ã©bullition, stabilisÃ© Ã  95-100Â°C. 1 roux blanc = bÃ©chamel, veloutÃ©. 1 roux brun = gumbo, sauce Cajun.' },
      { type: 'technique', title: 'La fÃ©cule de maÃ¯s (MaÃ¯zena)', text: 'DÃ©layer dans de l\'eau froide (jamais directement dans le chaud â€” grumeaux immÃ©diats). Ratio : 1 c. Ã  s. fÃ©cule pour 200 ml liquide. Verser en fouettant dans le liquide chaud. Ã‰paissit Ã  80Â°C, devient transparent (diffÃ©rence avec roux qui reste opaque). Ne pas bouillir aprÃ¨s Ã©paississement â€” se liquÃ©fie en excÃ¨s de chaleur. IdÃ©ale pour sauces asiatiques, glaÃ§ages de tarte aux fruits.' },
      { type: 'technique', title: 'L\'arrow-root', text: 'Similaire Ã  la fÃ©cule mais Ã©paissit Ã  plus basse tempÃ©rature (70Â°C) et reste parfaitement transparent. Ne supporte pas l\'aciditÃ© ni la congÃ©lation. IdÃ©al pour les sauces dÃ©licates, les coulis de fruits, les sauces lÃ©gÃ¨res qui doivent rester brillantes.' },
      { type: 'heading', text: 'Les liaisons Ã  froid ou par Ã©mulsion' },
      { type: 'technique', title: 'La liaison Ã  l\'Å“uf (liaison Ã  blanc ou Ã  jaune)', text: 'Jaune d\'Å“uf fouettÃ© + crÃ¨me. TempÃ©rer : verser une louche de sauce chaude sur le mÃ©lange froid en fouettant (Ã©vite la coagulation), puis reverser dans la sauce. Chauffer Ã  82-84Â°C sans jamais bouillir. La sauce nappe la cuillÃ¨re, coat en velours. Technique : crÃ¨me anglaise, sauce Allemande, potages veloutÃ©s. Jamais bouillir = Å“ufs brouillÃ©s dans la sauce.' },
      { type: 'technique', title: 'Le beurre maniÃ©', text: 'Alternative rapide au roux. Beurre mou + farine (50/50) malaxÃ©s ensemble Ã  froid. Former des petites noix. Les incorporer dans une sauce bouillante en fouettant â€” ils fondent et Ã©paississent instantanÃ©ment. Ã‰paississement rapide de correction en fin de cuisson. Pas pour les grandes quantitÃ©s.' },
      { type: 'technique', title: 'La rÃ©duction (liaison naturelle)', text: 'Ã‰vaporer l\'eau par Ã©bullition. La concentration naturelle des sucres, protÃ©ines et collagÃ¨ne Ã©paissit le liquide. Aucun ingrÃ©dient ajoutÃ©. RÃ©duction de moitiÃ© = texture veloutÃ©e. RÃ©duction aux 3/4 = sirupeux. RÃ©sultat le plus pur : toute la saveur concentrÃ©e, aucun Ã©paississant dÃ©tectable.' },
      { type: 'heading', text: 'Les gÃ©lifiants modernes' },
      { type: 'technique', title: 'Agar-agar', text: 'GÃ©lifiant vÃ©gÃ©tal (algues rouges). 2 g pour 500 ml liquide = gel ferme. Dissoudre dans le liquide froid, puis porter Ã  Ã©bullition 2 min en fouettant. GÃ©lifie en refroidissant Ã  40Â°C, tient jusqu\'Ã  80Â°C (contrairement Ã  la gÃ©latine qui fond Ã  25Â°C). IdÃ©al pour terrines chaudes, gels de prÃ©sentation, sauce gÃ©lifiÃ©e.' },
      { type: 'technique', title: 'GÃ©latine (feuilles)', text: '1 feuille (2 g) pour 100 ml liquide = gel souple. Tremper dans eau froide 5 min, essorer, fondre dans liquide chaud (pas bouillant â€” dÃ©naturÃ©). GÃ©lifie sous 4Â°C. Fond Ã  25-30Â°C (fondant en bouche). IdÃ©al : panna cotta, bavarois, aspic, entremets. Pas pour les vÃ©gÃ©tariens (collagÃ¨ne porcin ou bovin).' },
      { type: 'technique', title: 'La xanthane (pour les curieux)', text: '0,2-0,4 g pour 100 ml = Ã©paississement sans cuisson. Donner du corps Ã  un jus, Ã©paissir une vinaigrette lÃ©gÃ¨re, stabiliser une Ã©mulsion. Disperser dans de l\'huile avant d\'ajouter dans le liquide (Ã©vite les grumeaux). Cuisine molÃ©culaire accessible â€” pas indispensable mais utile en technique avancÃ©e.' },
      { type: 'warning', text: 'La fÃ©cule ne supporte pas d\'Ãªtre rechauffÃ©e plusieurs fois â€” elle se liquÃ©fie. Pour les sauces Ã  rÃ©chauffer : prÃ©fÃ©rer un roux (plus stable). La gÃ©latine ne convient pas aux fruits acides frais (ananas, kiwi, papaye) qui contiennent des enzymes protÃ©olytiques qui dÃ©gradent la gÃ©latine â€” utiliser l\'agar-agar.' },
      { type: 'recap', text: 'Roux : stable, opaque, cuisson longue. FÃ©cule : transparent, rapide, dÃ©licat. Liaison jaune+crÃ¨me : velours, jamais bouillir. RÃ©duction : le plus pur, aucun ajout. Agar-agar : vÃ©gÃ©tal, tient Ã  chaud. GÃ©latine : fondant en bouche, fragile Ã  chaleur.' },
      { type: 'exercise', text: 'Fais un potage de lÃ©gumes simple. Divise en 3 portions. Ã‰paissir la 1Ã¨re avec un peu de roux (1 c. beurre + 1 c. farine fondue ensemble, incorporÃ©e). La 2Ã¨me avec fÃ©cule de maÃ¯s dÃ©layÃ©e. La 3Ã¨me par rÃ©duction de moitiÃ©. Compare les trois textures et les trois saveurs â€” les diffÃ©rences sont saisissantes.' },
    ]),
  },
  {
    slug: 'patisserie-feuilletee',
    title: 'La pÃ¢te feuilletÃ©e',
    description: 'DÃ©trempe, beurrage, tourage : la reine des pÃ¢tes dÃ©mystifiÃ©e couche par couche.',
    category: 'baking', skill: 'baking', difficulty: 3, icon: 'layers', gemCost: 50, xpReward: 180, order: 14,
    content: JSON.stringify([
      { type: 'text', text: 'La pÃ¢te feuilletÃ©e est un chef-d\'Å“uvre de physique culinaire : 729 couches de beurre et de pÃ¢te alternÃ©es, crÃ©Ã©es par 6 tours de pliage. Ã€ la cuisson, l\'eau contenue dans le beurre se vaporise instantanÃ©ment et soulÃ¨ve chaque couche. Le rÃ©sultat : un feuilletage d\'une lÃ©gÃ¨retÃ© et d\'un croustillant impossibles Ã  imiter.' },
      { type: 'heading', text: 'Le principe du tourage' },
      { type: 'technique', title: 'Pourquoi feuilleter', text: 'Alterner couches de pÃ¢te (dÃ©trempe) et couches de beurre par pliages successifs. Chaque "tour" double le nombre de couches. 6 tours simples = 2â¶ = 64 couches de beurre = 729 feuillets au total. Le froid maintient la sÃ©paration : si le beurre fond, il s\'incorpore Ã  la pÃ¢te et il n\'y a plus de feuilletage.' },
      { type: 'heading', text: 'La dÃ©trempe â€” Ã©tape 1' },
      { type: 'technique', title: 'Recette de base', text: '500 g farine T55 + 10 g sel + 250 ml eau froide + 50 g beurre fondu. MÃ©langer sans pÃ©trir (dÃ©velopper le gluten au minimum). Inciser en croix. Film, 30 min au rÃ©frigÃ©rateur. La dÃ©trempe doit Ãªtre souple mais pas Ã©lastique â€” trop de gluten rÃ©siste au tourage.' },
      { type: 'heading', text: 'Le beurrage â€” Ã©tape 2' },
      { type: 'technique', title: 'Le beurre de tourage', text: 'Beurre de tourage (84% MG, spÃ©cial tourage) ou beurre AOP de qualitÃ©. 250 g beurre froid battu entre 2 feuilles sulfurisÃ©e jusqu\'Ã  former un carrÃ© de 15Ã—15 cm, 1 cm d\'Ã©paisseur. TempÃ©rature idÃ©ale du beurre : 14-16Â°C â€” aussi froid que la dÃ©trempe.' },
      { type: 'technique', title: 'Emprisonnement du beurre', text: 'Ã‰taler la dÃ©trempe en carrÃ© de 25Ã—25 cm. Poser le beurre au centre en diagonale. Replier les 4 coins de la dÃ©trempe sur le beurre comme une enveloppe. Souder les bords en appuyant. Le beurre est emprisonnÃ©. Ã‰taler en rectangle 20Ã—60 cm.' },
      { type: 'heading', text: 'Les tours â€” Ã©tape 3' },
      { type: 'technique', title: 'Le tour simple (ou double)', text: 'Tour simple : plier en 3 (comme une lettre). Tourner d\'un quart de tour. Ã‰taler. RÃ©pÃ©ter. Faire 6 tours simples total avec 2 repos de 30 min au froid entre chaque sÃ©rie de 2 tours. Tour double : plier les 2 extrÃ©mitÃ©s vers le centre puis plier en 2 (4 Ã©paisseurs). 3 tours doubles = Ã©quivalent 6 simples.' },
      { type: 'technique', title: 'Les erreurs Ã  Ã©viter', text: '1. Beurre trop froid = casse les couches. 2. Beurre trop chaud = s\'incorpore Ã  la pÃ¢te. 3. Trop travailler la dÃ©trempe = trop de gluten = rÃ©traction. 4. Oublier les temps de repos au froid = le beurre fond. 5. Ã‰taler trop fort = les couches s\'Ã©crasent et fusionnent.' },
      { type: 'heading', text: 'Cuisson et utilisations' },
      { type: 'technique', title: 'Four trÃ¨s chaud', text: 'Four prÃ©chauffÃ© 200-220Â°C. La chaleur intense vaporise l\'eau du beurre instantanÃ©ment â†’ chaque couche se soulÃ¨ve. Ã€ 180Â°C ou moins, la vapeur se produit trop lentement et le feuilletage est compact. Toujours dorer Ã  l\'Å“uf (jamais sur les cÃ´tÃ©s â€” Ã§a colle les couches).' },
      { type: 'technique', title: 'Utilisations classiques', text: 'Millefeuille : 3 couches de pÃ¢te + crÃ¨me pÃ¢tissiÃ¨re. Vol-au-vent : pÃ¢te dÃ©coupÃ©e et creusÃ©e. Galette des rois : frangipane entre 2 disques. Tarte tatin : fond de tarte avec pÃ¢te dÃ©posÃ©e aprÃ¨s caramÃ©lisation. FeuilletÃ©s apÃ©ro : pÃ¢te dÃ©coupÃ©e, tordue, dorÃ©e.' },
      { type: 'tip', text: 'La pÃ¢te feuilletÃ©e maison se congÃ¨le parfaitement aprÃ¨s le tourage. Portionner, filmer, congeler. DÃ©congeler au rÃ©frigÃ©rateur 12h avant utilisation. En avoir toujours au congÃ©lateur change la donne pour les repas improvisÃ©s.' },
      { type: 'warning', text: 'Ne jamais Ã©taler la pÃ¢te feuilletÃ©e perpendiculairement Ã  la direction du feuilletage â€” les couches se dÃ©sorganisent. Toujours Ã©taler dans le mÃªme axe, en longueur, en tournant la pÃ¢te d\'un quart de tour entre chaque tour.' },
      { type: 'recap', text: 'DÃ©trempe : farine + eau + sel + peu de gluten. Beurrage : carrÃ© 14-16Â°C emprisonnÃ©. 6 tours simples avec repos au froid = 729 couches. Four trÃ¨s chaud. CongÃ¨le parfaitement aprÃ¨s tourage. La rÃ©gularitÃ© des couches dÃ©termine tout le feuilletage.' },
      { type: 'exercise', text: 'Commence par une "fausse pÃ¢te feuilletÃ©e" rapide (feuilletage express) : 250 g farine + 125 g beurre froid en dÃ©s + 125 ml eau froide. MÃ©langer rapidement, faire 3 tours rapides, cuire. Pas aussi parfait, mais le principe du feuilletage est identique et tu comprends la physique avant d\'attaquer la vraie version.' },
    ]),
  },
  {
    slug: 'dressage-presentation',
    title: 'Dressage & prÃ©sentation',
    description: 'Le plat se mange d\'abord avec les yeux : hauteur, couleurs, contraste, nettetÃ©.',
    category: 'prep', skill: 'prep', difficulty: 2, icon: 'palette', gemCost: 30, xpReward: 120, order: 15,
    content: JSON.stringify([
      { type: 'text', text: 'Le dressage est la derniÃ¨re Ã©tape, et souvent la plus nÃ©gligÃ©e. Pourtant, la prÃ©sentation d\'un plat conditionne directement la perception de son goÃ»t â€” des Ã©tudes montrent que le mÃªme plat est perÃ§u comme 10-20 % plus savoureux quand il est bien dressÃ©. C\'est de la psychologie appliquÃ©e Ã  l\'assiette.' },
      { type: 'heading', text: 'Les principes fondamentaux' },
      { type: 'technique', title: 'RÃ¨gle des 5 Ã©lÃ©ments', text: 'Un plat bien Ã©quilibrÃ© contient idÃ©alement : 1. Un Ã©lÃ©ment principal (protÃ©ine ou vÃ©gÃ©tal). 2. Un accompagnement texturÃ©. 3. Un Ã©lÃ©ment de couleur. 4. Une sauce ou jus. 5. Un Ã©lÃ©ment de finition (herbe fraÃ®che, zeste, fleur comestible). Pas besoin des 5 Ã  chaque fois, mais y penser structure le dressage.' },
      { type: 'technique', title: 'RÃ¨gle du nombre impair', text: 'Disposer 3 Ã©lÃ©ments identiques plutÃ´t que 4. PrÃ©senter 3 gnocchis en triangle plutÃ´t que 4 en carrÃ©. Le nombre impair crÃ©e un dynamisme visuel, le pair est statique et symÃ©trique (donc prÃ©visible). L\'asymÃ©trie contrÃ´lÃ©e est plus Ã©lÃ©gante que la symÃ©trie parfaite.' },
      { type: 'technique', title: 'Les points d\'ancrage', text: 'Commencer par l\'Ã©lÃ©ment principal et le placer lÃ©gÃ¨rement dÃ©centrÃ© (pas au milieu de l\'assiette). La sauce part de dessous (jamais noyÃ©e sur l\'Ã©lÃ©ment principal â€” Ã§a le fait "flotter"). Les garnitures se construisent autour sans combler tout l\'espace blanc.' },
      { type: 'heading', text: 'La couleur et le contraste' },
      { type: 'technique', title: 'Jouer avec les couleurs', text: 'Le vert fraÃ®che (herbes, huile verte) sur un fond crÃ¨me. La sauce orange sur assiette blanche. Les rÃ¨gles complÃ©mentaires de la roue des couleurs s\'appliquent : rouge + vert, orange + violet, jaune + bleu. Un plat monochrome (tout brun, tout blanc) manque d\'appÃ©tence â€” ajouter systÃ©matiquement un Ã©lÃ©ment de couleur vive.' },
      { type: 'technique', title: 'Contraste des textures visuelles', text: 'Associer brillant + mat. Lisse + granuleux. Dense + aÃ©rien. Une purÃ©e lisse sous une piÃ¨ce de viande saisie (brillante et croustillante en surface). Un crumble de pain sur un veloutÃ©. Des pousses fraÃ®ches sur une terrine. Le contraste visuel prÃ©pare le contraste en bouche.' },
      { type: 'heading', text: 'Techniques de dressage' },
      { type: 'technique', title: 'Les sauces : traits et points', text: '3 faÃ§ons de dresser une sauce : 1. Trait ou virgule (cuillÃ¨re Ã  soupe retournÃ©e, glissÃ©e sur l\'assiette). 2. Miroir (verser sur tout le fond de l\'assiette avant de poser les Ã©lÃ©ments). 3. Points (cuillÃ¨re ou pipette â€” 5 Ã  7 points de taille dÃ©croissante). Ã‰viter de noyer l\'Ã©lÃ©ment principal dans la sauce.' },
      { type: 'technique', title: 'Les hauteurs', text: 'Empiler plutÃ´t qu\'Ã©taler. Un millefeuille vertical, une quenelle de purÃ©e, des tranches en Ã©ventail. La hauteur donne de la structure et de la prÃ©sence. Attention : les tours trop hautes tombent et ne sont pas pratiques Ã  manger. La hauteur doit Ãªtre cohÃ©rente avec le plat.' },
      { type: 'technique', title: 'Les finitions', text: 'Herbes fraÃ®ches : ciseler au dernier moment, disposer Ã  la pince. Zestes : Ã  la microplane, directement sur l\'assiette (les huiles essentielles s\'Ã©vaporent). Huiles colorÃ©es (pistou, huile de piment, huile verte) : pipette ou cuillÃ¨re. Fleur de sel : petite quantitÃ© sur protÃ©ines juste avant service. Fleurs comestibles : capucine, bourrache, violette.' },
      { type: 'tip', text: 'Essuyer les bords et l\'intÃ©rieur de l\'assiette avant d\'envoyer : un coup de papier absorbant ou de torchon propre lÃ©gÃ¨rement humide suffit. Les traces de sauce ou d\'Ã©claboussures sur le bord donnent une impression de nÃ©gligence qui ruine la prÃ©sentation.' },
      { type: 'technique', title: 'Choisir l\'assiette', text: 'Assiette blanche : neutre, met en valeur toutes les couleurs. Assiette noire : dramatique, pour les prÃ©parations lÃ©gÃ¨res et colorÃ©es. Assiette avec rebord : permet la sauce en miroir. Assiette creuse : pour les bouillons, veloutÃ©s, carpaccios. Ardoise ou planche en bois : pour les planches de partage et les desserts. Toujours prÃ©chauffer les assiettes (four 80Â°C, 5 min) pour les plats chauds.' },
      { type: 'recap', text: '5 Ã©lÃ©ments : principal + texturÃ© + colorÃ© + sauce + finition. Nombre impair. Ã‰lÃ©ment principal dÃ©centrÃ©. Sauce dessous ou Ã  cÃ´tÃ©. Contraste couleur + texture. Hauteur modÃ©rÃ©e. Bords propres. Assiettes prÃ©chauffÃ©es pour le chaud.' },
      { type: 'exercise', text: 'Prends un plat que tu cuisines souvent. Fais-le exactement comme d\'habitude, puis dresse-le de 2 faÃ§ons : 1. Ta faÃ§on habituelle (tout sur l\'assiette directement). 2. Avec les principes ici : dÃ©centrer l\'Ã©lÃ©ment principal, sauce en trait, herbe fraÃ®che Ã  la pince, bords essuyÃ©s. Prends en photo les deux. La diffÃ©rence sera frappante.' },
    ]),
  },
  {
    slug: 'epices-monde',
    title: 'Les Ã©pices du monde',
    description: 'Curry, zaatar, ras el hanout, 5 Ã©pices : dÃ©coder les mÃ©langes qui font voyager.',
    category: 'seasoning', skill: 'seasoning', difficulty: 2, icon: 'globe', gemCost: 30, xpReward: 120, order: 16,
    content: JSON.stringify([
      { type: 'text', text: 'Les Ã©pices sont la mÃ©moire gÃ©ographique de la cuisine. Chaque grande cuisine du monde a ses mÃ©langes signature, construits sur des siÃ¨cles d\'Ã©changes commerciaux et de traditions. Les comprendre permet de voyager avec une assiette â€” et de crÃ©er des associations qui semblent nouvelles mais qui sont en fait des Ã©quilibres Ã©prouvÃ©s.' },
      { type: 'heading', text: 'Inde et Asie du Sud' },
      { type: 'technique', title: 'Le curry : pas une Ã©pice, un concept', text: 'Il n\'existe pas "une" Ã©pice curry : le mot dÃ©signe une sauce ou un ragoÃ»t Ã©picÃ©. La poudre de curry commerciale est un mÃ©lange standardisÃ© (curcuma + coriandre + cumin + poivre + gingembre + fenugrec). En Inde, chaque famille a son masala propre. Le garam masala (Ã©pices chaudes : cardamome + clou + cannelle + noix de muscade + poivre) se distingue par ses arÃ´mes chauds sans le curcuma.' },
      { type: 'technique', title: 'Le tarka / tadka', text: 'Technique indienne : faire sauter les Ã©pices entiÃ¨res dans de l\'huile chaude avant d\'ajouter les autres ingrÃ©dients. Les graines de moutarde, le cumin, les feuilles de curry libÃ¨rent leurs huiles essentielles dans le corps gras. Ce bloom d\'Ã©pices est 3 Ã  5 fois plus aromatique que les mÃªmes Ã©pices moulues ajoutÃ©es en cours de cuisson.' },
      { type: 'heading', text: 'Moyen-Orient et MÃ©diterranÃ©e' },
      { type: 'technique', title: 'Zaatar', text: 'MÃ©lange syro-libanais : thym sÃ©chÃ© + sumac (baies sÃ©chÃ©es acides) + sÃ©same torrÃ©fiÃ© + sel. Le sumac apporte une aciditÃ© fruitÃ©e sans citron. Zaatar + huile d\'olive = trempette. Zaatar sur labneh (yaourt Ã©gouttÃ©), sur fromage, sur poisson grillÃ©, sur du pain plat. Un des mÃ©langes les plus versatiles.' },
      { type: 'technique', title: 'Ras el hanout', text: 'LittÃ©ralement "tÃªte de boutique" â€” les meilleures Ã©pices du marchand. MÃ©lange marocain variable (jusqu\'Ã  30 Ã©pices) : cannelle + gingembre + curcuma + coriandre + cardamome + pÃ©tales de rose sÃ©chÃ©s + poivre. Profil : complexe, chaud, lÃ©gÃ¨rement floral. Pour couscous, tajine, cordons bleus Ã©picÃ©s.' },
      { type: 'technique', title: 'Sumac et Ã©pices levantines', text: 'Sumac : baies sÃ©chÃ©es moulues, aciditÃ© fruitÃ©e rouge sombre. Remplace le citron en sec. Sur hummus, fattoush, viandes grillÃ©es. Z\'atar (plante) distinct du zaatar (mÃ©lange). Baharat (mÃ©lange irakien/turc) : all-spice + poivre + cannelle + coriandre + clou. Pour viandes et riz.' },
      { type: 'heading', text: 'Asie de l\'Est' },
      { type: 'technique', title: 'Les 5 Ã©pices chinoises', text: 'Anis Ã©toilÃ© + poivre du Sichuan + clou de girofle + cannelle + fenouil. Profil : anisÃ©, chaud, lÃ©gÃ¨rement engourdi (poivre Sichuan). Incontournable pour porc rÃ´ti, canard laquÃ©, marinades. La poudre 5 Ã©pices est forte â€” utiliser avec parcimonie (1/4 c. Ã  c. suffit pour parfumer un plat pour 4).' },
      { type: 'technique', title: 'Shichimi togarashi', text: 'MÃ©lange japonais de 7 Ã©pices : piment + poivre Sichuan + zeste yuzu + sÃ©same noir + graines de chanvre + nori + gingembre. Condiment de finition (ramens, soba, yakitori). Jamais en cuisson â€” ajouter Ã  table. Chaque ingrÃ©dient se sent sÃ©parÃ©ment.' },
      { type: 'heading', text: 'Conseils universels sur les Ã©pices' },
      { type: 'technique', title: 'TorrÃ©fier pour rÃ©vÃ©ler', text: 'Ã‰pices entiÃ¨res 1-2 min Ã  sec dans poÃªle chaude jusqu\'Ã  ce qu\'elles fument lÃ©gÃ¨rement et embaument. Refroidir avant de moudre. La chaleur casse les liaisons chimiques et libÃ¨re les huiles essentielles. DiffÃ©rence de goÃ»t : spectaculaire. Cumin torrÃ©fiÃ© vs cumin non torrÃ©fiÃ© = deux Ã©pices diffÃ©rentes.' },
      { type: 'technique', title: 'Conservation et fraÃ®cheur', text: 'Les Ã©pices entiÃ¨res se conservent 2-3 ans. Les Ã©pices moulues : 6-12 mois maximum (les huiles essentielles s\'Ã©vaporent). Test de fraÃ®cheur : frotter entre les doigts et sentir. Si aucun arÃ´me = Ã©pice morte Ã  jeter. Stocker Ã  l\'abri de la lumiÃ¨re et de l\'humiditÃ© â€” jamais dans une armoire au-dessus des plaques.' },
      { type: 'tip', text: 'Construire ses propres mÃ©langes : commencer par les bases (cumin, coriandre, paprika doux) puis ajouter les notes chaudes (cannelle, cardamome, clou) et les notes piquantes (piment, poivre, gingembre). Garder les notes florales (lavande, rose, anis) pour les finales subtiles.' },
      { type: 'recap', text: 'Curry = concept + masala propre. Tarka = Ã©pices entiÃ¨res dans huile chaude. Zaatar = thym + sumac + sÃ©same. Ras el hanout = mÃ©lange marocain floral complexe. 5 Ã©pices = anis + Sichuan + clou + cannelle + fenouil. TorrÃ©fier avant moudre. FraÃ®cheur = odeur puissante au doigt.' },
      { type: 'exercise', text: 'Fais ton propre mÃ©lange : 2 c. cumin moulu + 1 c. coriandre + 1 c. paprika fumÃ© + 1/2 c. curcuma + 1/2 c. gingembre + 1/4 c. cannelle. Fais revenir oignon + tomates + pois chiches avec ce mÃ©lange. C\'est ton premier "masala" personnel â€” ajuste les proportions selon ton palais.' },
    ]),
  },
  {
    slug: 'confiserie-caramel',
    title: 'Confiserie & caramel',
    description: 'Caramel Ã  sec et Ã  l\'eau, nougat, pralin, toffee : la chimie sucrÃ©e sans peur.',
    category: 'baking', skill: 'baking', difficulty: 3, icon: 'candy', gemCost: 50, xpReward: 180, order: 17,
    content: JSON.stringify([
      { type: 'text', text: 'Le sucre est un ingrÃ©dient vivant qui change radicalement de propriÃ©tÃ©s selon sa tempÃ©rature. De 100Â°C Ã  170Â°C, en passant par le grand boulÃ© et le grand cassÃ©, chaque stade donne un rÃ©sultat diffÃ©rent. Comprendre la chimie du sucre, c\'est Ã©liminer toute la peur de la confiserie.' },
      { type: 'heading', text: 'Les stades du sucre' },
      { type: 'technique', title: 'Lire la tempÃ©rature', text: 'Indispensable : thermomÃ¨tre Ã  sucre ou thermomÃ¨tre sonde. Les tempÃ©ratures sont prÃ©cises et critiques â€” 5Â°C de plus ou de moins change complÃ¨tement le rÃ©sultat. Napper/filet : 103-105Â°C. Petit boulÃ© : 116-118Â°C (caramel mou, nougat tendre). Grand boulÃ© : 124-130Â°C (caramel dur). Petit cassÃ© : 135-140Â°C (sucre tirÃ©). Grand cassÃ© : 150-155Â°C (berlingots, sucettes). Caramel : 160-175Â°C (couleur ambre).' },
      { type: 'heading', text: 'Le caramel' },
      { type: 'technique', title: 'Caramel Ã  sec', text: 'Verser le sucre directement dans une casserole Ã  fond Ã©pais. Feu moyen. Ne jamais mÃ©langer au dÃ©but â€” attendre que les bords fondent et caramÃ©lisent. Incliner la casserole pour homogÃ©nÃ©iser. ArrÃªter Ã  la couleur ambre foncÃ© (175-180Â°C). Plus il est foncÃ© = plus il est amer et complexe. 185Â°C = brÃ»lÃ©, irrÃ©parable.' },
      { type: 'technique', title: 'Caramel Ã  l\'eau', text: 'Sucre + eau (25% du poids du sucre) + quelques gouttes de citron (Ã©vite la cristallisation). Chauffer sans mÃ©langer jusqu\'Ã  coloration. L\'eau contrÃ´le la montÃ©e en tempÃ©rature, plus facile pour les dÃ©butants. InconvÃ©nient : plus long, risque de cristallisation si projection de sucre sur les parois (pincer les bords avec pinceau humide).' },
      { type: 'technique', title: 'DÃ©cuire le caramel', text: 'Pour la sauce caramel : dÃ©cuire avec crÃ¨me chaude (jamais froide â€” projections et Ã©claboussures brÃ»lantes). Verser la crÃ¨me en filet sur le caramel trÃ¨s chaud en fouettant. Ajouter beurre froid en dÃ©s. Pour le caramel au sel : fleur de sel aprÃ¨s dÃ©cuisson, jamais pendant (se dissout et change le goÃ»t).' },
      { type: 'heading', text: 'Pralin et nougat' },
      { type: 'technique', title: 'Pralin et pralinÃ©', text: 'Pralin : caramel coulÃ© sur fruits secs torrÃ©fiÃ©s (amandes, noisettes). Refroidir sur silicone. Mixer jusqu\'Ã  poudre granuleuse = pralin en poudre. Continuer Ã  mixer jusqu\'Ã  pÃ¢te lisse = pralinÃ© (texture beurre de cacahuÃ¨te). Utilisation : intÃ©rieur de bonbons, insert d\'entremets, glaces, mousses.' },
      { type: 'technique', title: 'Nougat de MontÃ©limar', text: 'Cuire sucre + glucose + miel Ã  145Â°C (grand cassÃ©). En parallÃ¨le, monter blancs en neige ferme. Verser le sucre cuit en filet sur les blancs montÃ©s en fouettant (comme une meringue italienne). Ajouter amandes + pistaches entiÃ¨res torrÃ©fiÃ©es. Ã‰taler entre feuilles de pain azyme. Refroidir 12h. La technique du sucre cuit versÃ© sur blanc = meringue italienne.' },
      { type: 'warning', text: 'Le sucre Ã  haute tempÃ©rature (>150Â°C) est extrÃªmement dangereux : 5x plus brÃ»lant que l\'eau bouillante et colle Ã  la peau. Jamais sans tablier + gants. Avoir immÃ©diatement un grand saladier d\'eau glacÃ©e Ã  portÃ©e. En cas de brÃ»lure au sucre : eau froide courante 15 min minimum.' },
      { type: 'technique', title: 'Toffee et caramel anglais', text: 'Beurre + sucre brun cuits ensemble Ã  130Â°C (sans eau). Texture : craquant comme du verre une fois refroidi. Verser sur plaque, parsemer de chocolat fondu + fleur de sel, refroidir. Casser en morceaux irrÃ©guliers. La diffÃ©rence avec le caramel franÃ§ais : le beurre cuit avec le sucre dÃ¨s le dÃ©but (caramÃ©lisation des solides du lait).' },
      { type: 'tip', text: 'Ã‰viter la cristallisation : ne jamais mÃ©langer avec une cuillÃ¨re une fois le sucre fondu. Utiliser un pinceau humide pour badigeonner les parois de la casserole si du sucre y colle. Une seule cristallisation d\'un grain de sucre peut entraÃ®ner tout le caramel en cascade.' },
      { type: 'recap', text: 'TempÃ©ratures : petit boulÃ© 116Â°C, grand boulÃ© 130Â°C, petit cassÃ© 138Â°C, grand cassÃ© 152Â°C, caramel 165-175Â°C. Sec = direct, rapide, risquÃ©. Ã€ l\'eau = plus doux, risque cristallisation. DÃ©cuire avec crÃ¨me chaude. Pralin = caramel + fruits secs mixÃ©s. SÃ©curitÃ© : eau froide Ã  portÃ©e.' },
      { type: 'exercise', text: 'Fais une sauce caramel au beurre salÃ© : 100 g sucre Ã  sec, caramel ambrÃ©, dÃ©cuire avec 10 cl crÃ¨me chaude, 30 g beurre + fleur de sel. Verse sur une glace vanille. C\'est la base â€” simple, parfaite, aucun compromis possible sur la technique.' },
    ]),
  },
  {
    slug: 'levures-fermentation',
    title: 'Levures et fermentation',
    description: 'Levures, gluten, pointage, apprÃªt : comprendre la biologie du pain pour le maÃ®triser.',
    category: 'baking', skill: 'baking', difficulty: 3, icon: 'activity', gemCost: 50, xpReward: 180, order: 18,
    content: JSON.stringify([
      { type: 'text', text: 'Faire du pain, c\'est travailler avec du vivant. La levure est un champignon microscopique qui transforme les sucres en COâ‚‚ et en alcool. Ce gaz fait lever la pÃ¢te, l\'alcool s\'Ã©vapore Ã  la cuisson. Comprendre ce processus biologique te permet de contrÃ´ler le rÃ©sultat au lieu de subir la fermentation.' },
      { type: 'heading', text: 'Les types de levures' },
      { type: 'technique', title: 'Levure boulangÃ¨re fraÃ®che', text: 'Levure fraÃ®che (cube gris) : 20-25 g pour 500 g de farine. Plus active, arÃ´mes plus complexes. Conserver au rÃ©frigÃ©rateur, utiliser dans les 2 semaines. Ã‰mietter directement dans la farine â€” pas besoin de la diluer dans l\'eau, contrairement Ã  la croyance populaire.' },
      { type: 'technique', title: 'Levure sÃ¨che active et instantanÃ©e', text: 'Levure sÃ¨che active : rÃ©hydrater 10 min dans eau tiÃ¨de (35Â°C) avec pincÃ©e de sucre avant utilisation. Levure instantanÃ©e (la plus courante) : mÃ©langer directement Ã  la farine sÃ¨che. Dosage : 7 g (un sachet) pour 500 g de farine. Conservation : 1 an Ã  l\'abri de l\'humiditÃ©.' },
      { type: 'technique', title: 'Le levain naturel', text: 'Farine + eau + bactÃ©ries lactiques naturelles. Fermentation lente (12-24h), arÃ´mes complexes (lÃ©gÃ¨rement acide), meilleure conservation du pain. Entretien quotidien : nourrir avec farine + eau. Le levain actif double de volume en 4-6h aprÃ¨s alimentation. Un levain bien entretenu dure des annÃ©es.' },
      { type: 'warning', text: 'Ne jamais mettre la levure en contact direct avec le sel â€” le sel est un bactÃ©ricide et tue la levure instantanÃ©ment. Ajouter le sel d\'un cÃ´tÃ© de la cuve, la levure de l\'autre, mÃ©langer aprÃ¨s.' },
      { type: 'heading', text: 'Le gluten et le pÃ©trissage' },
      { type: 'technique', title: 'Comprendre le gluten', text: 'Le gluten est un rÃ©seau de protÃ©ines (gliadine + glutÃ©nine) qui se forment quand la farine est hydratÃ©e et travaillÃ©e. Ce rÃ©seau Ã©lastique piÃ¨ge le COâ‚‚ produit par la levure â€” sans gluten, les bulles s\'Ã©chappent et le pain reste plat. Plus on pÃ©trit, plus le rÃ©seau est fort.' },
      { type: 'technique', title: 'Le pÃ©trissage classique', text: 'Pousser la pÃ¢te avec la paume de la main, replier vers soi, tourner d\'un quart de tour, recommencer. 10-15 minutes Ã  la main. La pÃ¢te est prÃªte quand elle est lisse, Ã©lastique et ne colle plus aux doigts. Test du voile : Ã©tirer un morceau de pÃ¢te entre les doigts â€” elle doit former un voile transparent sans se dÃ©chirer.' },
      { type: 'technique', title: 'L\'autolyse', text: 'Technique moderne : mÃ©langer farine + eau uniquement (sans sel ni levure), laisser reposer 20-60 min. La farine s\'hydrate naturellement et le gluten commence Ã  se former sans effort. RÃ©sultat : pÃ¢te plus extensible, moins de pÃ©trissage nÃ©cessaire, meilleure texture finale.' },
      { type: 'heading', text: 'Les deux fermentations' },
      { type: 'technique', title: 'Le pointage â€” premiÃ¨re pousse', text: 'AprÃ¨s le pÃ©trissage, la pÃ¢te repose Ã  couvert dans un rÃ©cipient lÃ©gÃ¨rement huilÃ©. Elle doit doubler de volume. TempÃ©rature ambiante (22-24Â°C) : 1h30 Ã  2h. RÃ©frigÃ©rateur (4Â°C) : 8-12h (pousse lente, arÃ´mes plus complexes). Le froid ralentit la levure mais ne la tue pas.' },
      { type: 'technique', title: 'Le faÃ§onnage et l\'apprÃªt', text: 'AprÃ¨s le pointage : dÃ©gazer dÃ©licatement (appuyer pour chasser le COâ‚‚), faÃ§onner (boule, baguette, miche), placer sur papier cuisson ou banneton farinÃ©. Laisser lever une 2e fois (l\'apprÃªt) : 45 min Ã  1h30 Ã  tempÃ©rature ambiante. La pÃ¢te doit avoir lÃ©gÃ¨rement gonflÃ© et rebondir mollement au toucher.' },
      { type: 'tip', text: 'Test de la fermentation : appuyer un doigt farinÃ© sur la pÃ¢te. Si l\'empreinte remonte lentement â†’ parfait. Si elle remonte immÃ©diatement â†’ pas assez fermentÃ©. Si elle ne remonte pas â†’ sur-fermentÃ© (la pÃ¢te sera dense et acide).' },
      { type: 'heading', text: 'La cuisson' },
      { type: 'technique', title: 'La buÃ©e et la croÃ»te', text: 'Four le plus chaud possible (240-260Â°C, prÃ©chauffÃ© 30 min). CrÃ©er de la buÃ©e les 10 premiÃ¨res minutes : jeter 100 ml d\'eau dans la lÃ¨chefrite, ou cuire dans une cocotte fermÃ©e. La buÃ©e retarde la formation de la croÃ»te et permet au pain de prendre son volume. Ensuite : ouvrir le four, Ã©vacuer la buÃ©e, finir la cuisson Ã  sec pour la croÃ»te dorÃ©e.' },
      { type: 'technique', title: 'La scarification (grigne)', text: 'Inciser le pain avec une lame de rasoir (grigne) juste avant d\'enfourner. Profondeur : 5 mm, angle : 45Â°. La scarification dirige l\'expansion du pain, Ã©vite qu\'il Ã©clate alÃ©atoirement et crÃ©e le motif distinctif du pain artisanal.' },
      { type: 'warning', text: 'Un four domestique ne dÃ©passe gÃ©nÃ©ralement pas 250Â°C contre 300-350Â°C pour un four de boulangerie professionnel. Compense avec une plus longue prÃ©chauffage, une pierre Ã  pizza ou une cocotte en fonte pour stocker la chaleur.' },
      { type: 'recap', text: 'Levure + sucres â†’ COâ‚‚ qui fait lever. Sel â‰  levure (jamais en contact direct). Gluten = rÃ©seau Ã©lastique qui piÃ¨ge les bulles. Pointage â†’ 1e pousse, apprÃªt â†’ 2e pousse. BuÃ©e au four â†’ volume et croÃ»te craquante. Test du doigt pour vÃ©rifier la fermentation.' },
      { type: 'exercise', text: 'Fais un pain basique : 500 g farine T65 + 7 g levure instantanÃ©e + 10 g sel + 320 ml eau tiÃ¨de. PÃ©tris 10 min, laisse pousser 1h30, faÃ§onne en boule, appret 1h, scarifie, four 240Â°C avec buÃ©e. Le rÃ©sultat sera meilleur que tu ne l\'imagines â€” et tu comprendras chaque Ã©tape en faisant.' },
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
  console.log(`ðŸŽ“ ${LESSON_SEED.length} leÃ§ons mises Ã  jour`);
}

// Comptes Pro permanents : liste de usernames sÃ©parÃ©s par virgule dans PRO_USERNAMES
async function grantProToFixedAccounts() {
  const raw = (process.env.PRO_USERNAMES || '').trim();
  if (!raw) return;
  const usernames = raw.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (!usernames.length) return;
  const { count } = await prisma.user.updateMany({ where: { username: { in: usernames }, isPro: false }, data: { isPro: true } });
  if (count) console.log(`â­ ${count} compte(s) Pro activÃ©(s) : ${usernames.join(', ')}`);
}

app.listen(PORT, () => {
  const dbHost = (process.env.DATABASE_URL || 'sqlite').replace(/\/\/[^@]+@/, '//***@').split('/')[2] || 'local';
  console.log(`ðŸ”¥ CulinaRPG en ligne sur http://localhost:${PORT} â€” DB: ${dbHost}`);

  // PrÃ©-chauffe la connexion Neon + crÃ©e les tables manquantes
  (async () => {
    for (let i = 1; i <= 5; i++) {
      try {
        await _baseClient.$queryRaw`SELECT 1`;
        console.log('âœ… Base de donnÃ©es connectÃ©e.');
        break;
      } catch (err) {
        console.log(`â³ DB tentative ${i}/5 (${err.code || err.message?.slice(0, 40)}) â€” attente ${i * 4}s...`);
        if (i < 5) await new Promise((r) => setTimeout(r, i * 4000));
        else { console.error('âŒ DB inaccessible aprÃ¨s 5 tentatives.'); return; }
      }
    }
    // S'assure que la table Friendship existe (crÃ©Ã©e aprÃ¨s le dÃ©ploiement initial)
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
      console.log('âœ… Table Friendship prÃªte.');
    } catch (err) {
      console.log('âš ï¸ Friendship table check:', err.message?.slice(0, 80));
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

