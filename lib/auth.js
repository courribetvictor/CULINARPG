// Authentification : hachage scrypt, sessions opaques (jeton haché en base), cookie httpOnly + Bearer.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

const SESSION_COOKIE = 'crpg_session';
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltB64, keyB64] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(key, expected);
}

// Hash factice : garde un temps de réponse constant quand l'utilisateur n'existe pas
let dummyHash;
async function verifyAgainstDummy(password) {
  dummyHash ||= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  }
  return out;
}

function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function sessionCookie(req, token, maxAgeSec) {
  const secure = req.secure || process.env.COOKIE_SECURE === 'true';
  return [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${token ? maxAgeSec : 0}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

async function createSession(prisma, req, res, userId) {
  const token = newToken();
  const maxAge = SESSION_DAYS * 24 * 3600;
  await prisma.session.create({
    data: {
      id: hashToken(token),
      userId,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      expiresAt: new Date(Date.now() + maxAge * 1000),
    },
  });
  res.setHeader('Set-Cookie', sessionCookie(req, token, maxAge));
  return token;
}

async function destroySession(prisma, req, res) {
  const token = readToken(req);
  if (token) await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  res.setHeader('Set-Cookie', sessionCookie(req, null, 0));
}

// Middleware : charge req.user si la session est valide, sinon 401
function requireAuth(prisma) {
  return async (req, res, next) => {
    try {
      const token = readToken(req);
      if (!token) return res.status(401).json({ error: 'Connexion requise', code: 'UNAUTHENTICATED' });
      const session = await prisma.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
      if (!session || session.expiresAt < new Date()) {
        if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
        res.setHeader('Set-Cookie', sessionCookie(req, null, 0));
        return res.status(401).json({ error: 'Session expirée, reconnecte-toi', code: 'UNAUTHENTICATED' });
      }
      req.user = session.user;
      req.sessionId = session.id;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Limiteur en mémoire (par IP + route) pour freiner le brute-force
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (entry.reset < now) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    hits.set(key, entry);
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'Trop de tentatives, réessaie dans quelques minutes.' });
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const AVATAR_IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const AVATAR_IMAGE_MAX = 300 * 1024;
const AVATAR_COLORS = ['violet', 'emerald', 'amber', 'cyan', 'pink', 'slate'];

const normUsername = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();
const normEmail = (s) => String(s || '').trim().toLowerCase();

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.';
  if (pw.length > 128) return 'Mot de passe trop long (128 caractères max).';
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  createSession,
  destroySession,
  requireAuth,
  rateLimit,
  hashToken,
  readToken,
  validatePassword,
  normUsername,
  normEmail,
  USERNAME_RE,
  EMAIL_RE,
  AVATAR_IMAGE_RE,
  AVATAR_IMAGE_MAX,
  AVATAR_COLORS,
};
