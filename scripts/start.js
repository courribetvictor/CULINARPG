'use strict';
require('dotenv').config();
const { execSync } = require('child_process');

// Même fix que server.js : ajoute connect_timeout pour Neon cold-start,
// mais ICI avant que les commandes Prisma CLI soient lancées.
const url = process.env.DATABASE_URL || '';
if (url && !url.includes('connect_timeout')) {
  process.env.DATABASE_URL = url + (url.includes('?') ? '&' : '?') + 'connect_timeout=30';
}

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });

// Baseline : marque la migration initiale comme déjà appliquée si la DB
// existait avant l'introduction des migrations (Neon déjà peuplé).
// Échoue silencieusement si déjà fait.
try { run('npx prisma migrate resolve --applied "20260926000000_init"'); } catch (_) {}

// Applique uniquement les migrations non encore appliquées — jamais destructif.
run('npx prisma migrate deploy');

// Démarre le serveur dans le même processus.
require('../server.js');
