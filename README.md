# 🍳 CulinaRPG — le « Solo Leveling » de la cuisine

Application **mobile-first** (PWA installable) de cuisine gamifiée : chaque recette cuisinée et chaque daily complétée rapportent de l'XP dans 5 compétences culinaires. Crée ton chef, choisis ta classe, monte en niveau, entretiens ta série 🔥 et débloque badges et titres.

**Stack :** Node.js · Express · Prisma (PostgreSQL — Neon) · SPA HTML5 + Tailwind CDN + Lucide + canvas-confetti.

## Démarrage en local

```bash
cp .env.example .env    # puis colle ta chaîne de connexion PostgreSQL (Neon) dans DATABASE_URL
npm install
npx prisma db push
node prisma/seed.js     # 500 recettes + photos + dailies
npm start               # http://localhost:3000  (PORT=3100 npm start pour changer de port)
```

> Astuce : crée une branche `dev` dans Neon (bouton *Branches*) pour avoir une base locale séparée de la production.

## Mise en ligne (Render + Neon, gratuit)

1. **Neon** — crée un compte sur [neon.tech](https://neon.tech), un projet (région *Europe — Frankfurt*), puis copie la **chaîne de connexion** (*Connection string*, version non « pooled ») : `postgresql://…/neondb?sslmode=require`.
2. **GitHub** — pousse le code : `git push -u origin claude/cuisine-rpg-mvp-deyfv0`.
3. **Render** — sur [render.com](https://render.com) : *New → Blueprint*, connecte ton compte GitHub et choisis le dépôt **CULINARPG**. Render lit `render.yaml` et ne demande qu'une valeur : colle l'URL Neon dans `DATABASE_URL`, puis *Apply*.
4. Le premier déploiement prend 2 à 4 minutes (installation, création des tables, 500 recettes). L'app est ensuite en ligne sur `https://culinarpg.onrender.com` (ou `culinarpg-xxxx.onrender.com` si le nom est pris).

Chaque `git push` sur la branche redéploie automatiquement. Offre gratuite : l'app s'endort après 15 min sans visite et met ~50 s à se réveiller ; les données, elles, sont conservées chez Neon.

Sur mobile : ouvre l'adresse du serveur dans Safari/Chrome puis **« Ajouter à l'écran d'accueil »** — l'app s'ouvre en plein écran comme une app native.

## Fonctionnalités

- **Comptes** : inscription (pseudo, e-mail, mot de passe), connexion par e-mail ou pseudo, déconnexion, changement de mot de passe (déconnecte les autres appareils), suppression du compte.
- **Onboarding en 3 étapes** : avatar (20 emojis × 6 couleurs, ou photo recadrée et compressée côté client), nom affiché, **classe** (+10 % d'XP sur une compétence).
- **Personnalisation** : avatar, nom, pseudo, bio, titre affiché (débloqué par niveau global ou niveau 5 dans une compétence), classe.
- **500 recettes de base** en français (14 catégories), avec ingrédients, étapes, temps, rang de difficulté D → S et récompenses XP calculées.
- **Photos réalistes** : 499/500 recettes illustrées via Wikipédia / Wikimedia Commons (images libres, lien de crédit sur chaque fiche).
- **Interface mobile** : barre d'onglets en bas, bottom sheets (détail recette, filtres) fermables d'un glissement, grille 2 colonnes, retour haptique, zones de sécurité iPhone, service worker (shell hors ligne).

## Photos des recettes

`lib/images.js` interroge l'API Wikipédia (titre exact fr → titre `en:` → recherche filtrée par pertinence) et met le résultat en cache dans `prisma/data/images.json` (versionné : pas de requête réseau au seed). Les titres corrigés à la main sont dans `prisma/data/image-titles.js`.

```bash
npm run images            # complète les photos manquantes
npm run images -- --retry # retente les recettes restées sans photo
```

Le serveur complète aussi les photos manquantes en tâche de fond au démarrage.

## Game design

| Compétence | Classe (+10 %) | Couleur |
|---|---|---|
| 🔪 `knife` — Couteau | Lame | émeraude → teal |
| 🔥 `fire` — Feu | Pyromancien | ambre → orange |
| 🧂 `seasoning` — Assaisonnement | Alchimiste | violet → fuchsia |
| ⏱️ `prep` — Préparation | Stratège | cyan → bleu |
| 🥐 `baking` — Pâtisserie | Artisan | rose → rose vif |

- **Niveau compétence** = `floor(sqrt(XP_skill) / 5) + 1` · **Niveau global** = `floor(sqrt(XP_total) / 10) + 1`
- **Streak** : +1 par jour consécutif avec au moins une activité, remise à 1 après un jour manqué.
- **Rendements décroissants** : recuisiner une recette rapporte −20 % par répétition (minimum 40 %).
- **Récompenses** : `lib/game.js#computeRewards` analyse les étapes (racines de mots FR/EN), la catégorie, le nombre d'ingrédients et le temps actif (plafonné à 2 h) → difficulté + répartition d'XP. La compétence la plus récompensée sert au filtre.

## API

Toutes les routes sauf `/api/health`, `/api/meta` et `/api/auth/*` exigent une session (cookie `httpOnly` ou `Authorization: Bearer`).

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/signup` | `{ username, email, password }` |
| POST | `/api/auth/login` | `{ identifier, password }` (e-mail ou pseudo) |
| POST | `/api/auth/logout` | Ferme la session |
| GET | `/api/auth/me` | Joueur connecté |
| GET | `/api/meta` | Classes, couleurs d'avatar |
| GET / PATCH | `/api/user/profile` | Profil complet / modification (nom, pseudo, bio, avatar, classe, titre) |
| POST | `/api/user/password` | `{ currentPassword, newPassword }` |
| DELETE | `/api/user` | `{ password }` — supprime le compte |
| GET | `/api/dailies` | Dailies du jour |
| POST | `/api/dailies/:id/complete` | Valide une daily (1× / jour, sûr en cas de double clic) |
| GET | `/api/recipes?page&limit&search&category&skill&sort` | `sort` : `featured`, `quick`, `xp`, `easy`, `hard`, `name` |
| GET | `/api/recipes/categories` | Catégories + compteurs |
| GET | `/api/recipes/:id` | Détail |
| POST | `/api/recipes/:id/cook` | Cuisine → XP, bonus de classe, level-ups, streak |

## Sécurité

Mots de passe hachés avec **scrypt** (sel aléatoire), sessions opaques de 30 jours stockées **hachées** (SHA-256), cookie `HttpOnly; SameSite=Lax` (`Secure` en HTTPS / `COOKIE_SECURE=true`), limitation des tentatives sur les routes sensibles, temps de réponse constant sur identifiant inconnu, validation stricte des champs (photo d'avatar : data URL JPEG/PNG/WebP ≤ 300 Ko).

## Options (`.env`)

`SEED_DEMO_USER=true` (compte `demo@culinarpg.app` / `demo1234`), `MEALDB_IMPORT=true` (ajoute les recettes anglaises de TheMealDB), `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGINS`, `RESOLVE_IMAGES_ON_START=false`.

## Structure

```
lib/game.js                 niveaux, classes, titres, calcul des récompenses
lib/auth.js                 hachage, sessions, rate limit, validation
lib/images.js               résolution des photos Wikipédia (+ CLI)
lib/text.js                 normalisation pour la recherche
render.yaml                 déploiement Render (Blueprint)
prisma/schema.prisma        User, Session, UserSkill, DailyTask, UserDailyCompletion, Recipe, UserRecipeCompletion
prisma/seed.js              catalogue + photos + dailies
prisma/data/recipes/*.js    les 500 recettes (14 catégories)
prisma/data/images.json     cache des photos
server.js                   API Express + SPA
public/                     index.html, app.js, manifest, service worker, icônes
```
