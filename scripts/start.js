'use strict';
require('dotenv').config();
const { execSync } = require('child_process');

// Fix Neon cold-start : connect_timeout doit être dans l'URL avant tout appel Prisma CLI
const url = process.env.DATABASE_URL || '';
if (url && !url.includes('connect_timeout')) {
  process.env.DATABASE_URL = url + (url.includes('?') ? '&' : '?') + 'connect_timeout=30';
}

// Neon utilise deux endpoints :
//   Pooler (app) : ep-xxx-pooler.region.aws.neon.tech  → DATABASE_URL
//   Direct (DDL)  : ep-xxx.region.aws.neon.tech         → DIRECT_URL
// prisma migrate deploy DOIT passer par le direct, sinon P1001.
// On dérive DIRECT_URL automatiquement en retirant "-pooler." du hostname.
const directUrl = process.env.DATABASE_URL.replace('-pooler.', '.');
process.env.DIRECT_URL = directUrl;
if (directUrl !== process.env.DATABASE_URL) {
  console.log('Neon pooler détecté — migrations via connexion directe.');
}

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });

// Baseline : marque la migration initiale comme déjà appliquée si la DB
// existait avant l'introduction des migrations. Échoue silencieusement si déjà fait.
try { run('npx prisma migrate resolve --applied "20260926000000_init"'); } catch (_) {}

// Applique les migrations non encore appliquées.
// Si ça échoue malgré tout (réseau, schéma déjà à jour…), on logge et on continue :
// mieux vaut un serveur qui tourne qu'aucun serveur.
try {
  run('npx prisma migrate deploy');
  console.log('✅ Migrations à jour.');
} catch (err) {
  console.error('⚠️  Migration échouée — le schéma est peut-être déjà à jour :', err.message?.slice(0, 300));
}

require('../server.js');
