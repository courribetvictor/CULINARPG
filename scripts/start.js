'use strict';
require('dotenv').config();
const { execSync } = require('child_process');

const origUrl = process.env.DATABASE_URL || '';

// 1. Ajoute connect_timeout=30 pour le cold-start Neon (une seule fois)
if (origUrl && !origUrl.includes('connect_timeout')) {
  process.env.DATABASE_URL = origUrl + (origUrl.includes('?') ? '&' : '?') + 'connect_timeout=30';
}
const appUrl = process.env.DATABASE_URL;

// 2. Neon fournit deux endpoints :
//      Pooler  (app)   : ep-xxx-pooler.region.aws.neon.tech  ← DATABASE_URL habituel
//      Direct  (DDL)   : ep-xxx.region.aws.neon.tech
//    prisma migrate deploy NE fonctionne PAS via le pooler PgBouncer (erreur P1001).
//    Si DIRECT_URL est défini manuellement dans les env vars Render, on l'utilise.
//    Sinon on le dérive automatiquement en retirant "-pooler." du hostname.
const migrationUrl = process.env.DIRECT_URL
  || appUrl.replace('-pooler.', '.');

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });

// 3. Migrations : utiliser l'URL directe
process.env.DATABASE_URL = migrationUrl;

// Baseline : marque la migration initiale comme déjà appliquée pour les DB
// existantes (celles créées avant l'introduction des migrations).
// Échoue silencieusement si déjà fait ou si la table n'existe pas encore.
try { run('npx prisma migrate resolve --applied "20260926000000_init"'); } catch (_) {}

// Applique les migrations non encore appliquées.
// NON FATAL : si ça échoue (réseau, schéma déjà à jour, timeout), on logge
// et on démarre quand même — mieux vaut un serveur qui tourne.
try {
  run('npx prisma migrate deploy');
  console.log('✅ Migrations à jour.');
} catch (err) {
  console.error('⚠️  Migration non fatale (schema probablement déjà correct) :', err.message?.slice(0, 200));
}

// 4. Restaurer l'URL pooler pour les requêtes applicatives (meilleures perfs)
process.env.DATABASE_URL = appUrl;

// 5. Démarrer le serveur
require('../server.js');
