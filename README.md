# ðŸ³ CulinaRPG â€” le Â« Solo Leveling Â» de la cuisine

Application **mobile-first** (PWA installable) de cuisine gamifiÃ©e : chaque recette cuisinÃ©e et chaque daily complÃ©tÃ©e rapportent de l'XP dans 5 compÃ©tences culinaires. CrÃ©e ton chef, choisis ta classe, monte en niveau, entretiens ta sÃ©rie ðŸ”¥ et dÃ©bloque badges et titres.

**Stack :** Node.js Â· Express Â· Prisma (PostgreSQL â€” Neon) Â· SPA HTML5 + Tailwind CDN + Lucide + canvas-confetti.

## DÃ©marrage en local

```bash
cp .env.example .env    # puis colle ta chaÃ®ne de connexion PostgreSQL (Neon) dans DATABASE_URL
npm install
npx prisma db push
node prisma/seed.js     # 500 recettes + photos + dailies
npm start               # http://localhost:3000  (PORT=3100 npm start pour changer de port)
```

> Astuce : crÃ©e une branche `dev` dans Neon (bouton *Branches*) pour avoir une base locale sÃ©parÃ©e de la production.

## Mise en ligne (Render + Neon, gratuit)

1. **Neon** â€” crÃ©e un compte sur [neon.tech](https://neon.tech), un projet (rÃ©gion *Europe â€” Frankfurt*), puis copie la **chaÃ®ne de connexion** (*Connection string*, version non Â« pooled Â») : `postgresql://â€¦/neondb?sslmode=require`.
2. **GitHub** â€” pousse le code : `git push origin main`.
3. **Render** â€” sur [render.com](https://render.com) : *New â†’ Blueprint*, connecte ton compte GitHub et choisis le dÃ©pÃ´t **CULINARPG**. Render lit `render.yaml` et ne demande qu'une valeur : colle l'URL Neon dans `DATABASE_URL`, puis *Apply*.
4. Le premier dÃ©ploiement prend 2 Ã  4 minutes (installation, crÃ©ation des tables, 500 recettes). L'app est ensuite en ligne sur `https://culinarpg.onrender.com` (ou `culinarpg-xxxx.onrender.com` si le nom est pris).

Render demande aussi `SIGNUP_CODE` (code d'invitation : personne ne peut s'inscrire sans lui â€” laisse vide pour ouvrir les inscriptions) et `CONTACT_EMAIL` (affichÃ© sur `/privacy`).

Chaque `git push` sur la branche redÃ©ploie automatiquement. Offre gratuite : l'app s'endort aprÃ¨s 15 min sans visite et met ~50 s Ã  se rÃ©veiller ; les donnÃ©es, elles, sont conservÃ©es chez Neon.

Sur mobile : ouvre l'adresse du serveur dans Safari/Chrome puis **Â« Ajouter Ã  l'Ã©cran d'accueil Â»** â€” l'app s'ouvre en plein Ã©cran comme une app native.

## Application Android (Play Store)

L'app web est emballÃ©e en **TWA** (Trusted Web Activity) : une vraie app Android qui affiche le site en plein Ã©cran, sans barre d'adresse. PrÃ©requis : l'app est en ligne sur Render (HTTPS).

1. Sur [pwabuilder.com](https://www.pwabuilder.com), colle l'URL Render â†’ *Package for stores* â†’ **Android**. Choisis un identifiant de paquet (ex. `app.culinarpg.twa`) et garde la **clÃ© de signature** gÃ©nÃ©rÃ©e (sans elle, impossible de publier les mises Ã  jour).
2. Le zip contient `assetlinks.json` : recopie `package_name` et l'empreinte `sha256_cert_fingerprints` dans les variables Render **`TWA_PACKAGE_NAME`** et **`TWA_SHA256_FINGERPRINTS`** (plusieurs empreintes sÃ©parÃ©es par des virgules). Le serveur les publie sur `/.well-known/assetlinks.json`.
3. **Test privÃ©** : installe l'`.apk` du zip sur ton tÃ©lÃ©phone (autoriser les sources inconnues).
4. **Play Store** : compte [Google Play Console](https://play.google.com/console) (25 $ une fois), crÃ©e l'app, envoie le `.aab`. Ajoute l'empreinte de la clÃ© *Play App Signing* (Console â†’ IntÃ©gritÃ© de l'app) dans `TWA_SHA256_FINGERPRINTS`. Publie d'abord en **test interne** (toi + jusqu'Ã  100 testeurs), puis en production. Politique de confidentialitÃ© Ã  renseigner : `https://<ton-app>.onrender.com/privacy`.

Google exige qu'un compte puisse Ãªtre supprimÃ© depuis l'app : c'est le cas (*Mon compte â†’ Zone de danger*).

## FonctionnalitÃ©s

- **Comptes** : inscription (pseudo, e-mail, mot de passe), connexion par e-mail ou pseudo, dÃ©connexion, changement de mot de passe (dÃ©connecte les autres appareils), suppression du compte.
- **Onboarding en 3 Ã©tapes** : avatar (20 emojis Ã— 6 couleurs, ou photo recadrÃ©e et compressÃ©e cÃ´tÃ© client), nom affichÃ©, **classe** (+10 % d'XP sur une compÃ©tence).
- **Personnalisation** : avatar, nom, pseudo, bio, titre affichÃ© (dÃ©bloquÃ© par niveau global ou niveau 5 dans une compÃ©tence), classe.
- **500 recettes de base** en franÃ§ais (14 catÃ©gories), avec ingrÃ©dients, Ã©tapes, temps, rang de difficultÃ© D â†’ S et rÃ©compenses XP calculÃ©es.
- **Photos rÃ©alistes** : 499/500 recettes illustrÃ©es via WikipÃ©dia / Wikimedia Commons (images libres, lien de crÃ©dit sur chaque fiche).
- **Interface mobile** : barre d'onglets en bas, bottom sheets (dÃ©tail recette, filtres) fermables d'un glissement, grille 2 colonnes, retour haptique, zones de sÃ©curitÃ© iPhone, service worker (shell hors ligne).

## Photos des recettes

`lib/images.js` interroge l'API WikipÃ©dia (titre exact fr â†’ titre `en:` â†’ recherche filtrÃ©e par pertinence) et met le rÃ©sultat en cache dans `prisma/data/images.json` (versionnÃ© : pas de requÃªte rÃ©seau au seed). Les titres corrigÃ©s Ã  la main sont dans `prisma/data/image-titles.js`.

```bash
npm run images            # complÃ¨te les photos manquantes
npm run images -- --retry # retente les recettes restÃ©es sans photo
```

Le serveur complÃ¨te aussi les photos manquantes en tÃ¢che de fond au dÃ©marrage.

## Game design

| CompÃ©tence | Classe (+10 %) | Couleur |
|---|---|---|
| ðŸ”ª `knife` â€” Couteau | Lame | Ã©meraude â†’ teal |
| ðŸ”¥ `fire` â€” Feu | Pyromancien | ambre â†’ orange |
| ðŸ§‚ `seasoning` â€” Assaisonnement | Alchimiste | violet â†’ fuchsia |
| â±ï¸ `prep` â€” PrÃ©paration | StratÃ¨ge | cyan â†’ bleu |
| ðŸ¥ `baking` â€” PÃ¢tisserie | Artisan | rose â†’ rose vif |

- **Niveau compÃ©tence** = `floor(sqrt(XP_skill) / 5) + 1` Â· **Niveau global** = `floor(sqrt(XP_total) / 10) + 1`
- **Streak** : +1 par jour consÃ©cutif avec au moins une activitÃ©, remise Ã  1 aprÃ¨s un jour manquÃ©.
- **Rendements dÃ©croissants** : recuisiner une recette rapporte âˆ’20 % par rÃ©pÃ©tition (minimum 40 %).
- **RÃ©compenses** : `lib/game.js#computeRewards` analyse les Ã©tapes (racines de mots FR/EN), la catÃ©gorie, le nombre d'ingrÃ©dients et le temps actif (plafonnÃ© Ã  2 h) â†’ difficultÃ© + rÃ©partition d'XP. La compÃ©tence la plus rÃ©compensÃ©e sert au filtre.

## API

Toutes les routes sauf `/api/health`, `/api/meta` et `/api/auth/*` exigent une session (cookie `httpOnly` ou `Authorization: Bearer`).

| MÃ©thode | Route | Description |
|---|---|---|
| POST | `/api/auth/signup` | `{ username, email, password }` |
| POST | `/api/auth/login` | `{ identifier, password }` (e-mail ou pseudo) |
| POST | `/api/auth/logout` | Ferme la session |
| GET | `/api/auth/me` | Joueur connectÃ© |
| GET | `/api/meta` | Classes, couleurs d'avatar |
| GET / PATCH | `/api/user/profile` | Profil complet / modification (nom, pseudo, bio, avatar, classe, titre) |
| POST | `/api/user/password` | `{ currentPassword, newPassword }` |
| DELETE | `/api/user` | `{ password }` â€” supprime le compte |
| GET | `/api/dailies` | Dailies du jour |
| POST | `/api/dailies/:id/complete` | Valide une daily (1Ã— / jour, sÃ»r en cas de double clic) |
| GET | `/api/recipes?page&limit&search&category&skill&sort` | `sort` : `featured`, `quick`, `xp`, `easy`, `hard`, `name` |
| GET | `/api/recipes/categories` | CatÃ©gories + compteurs |
| GET | `/api/recipes/:id` | DÃ©tail |
| POST | `/api/recipes/:id/cook` | Cuisine â†’ XP, bonus de classe, level-ups, streak |

## SÃ©curitÃ©

Mots de passe hachÃ©s avec **scrypt** (sel alÃ©atoire), sessions opaques de 30 jours stockÃ©es **hachÃ©es** (SHA-256), cookie `HttpOnly; SameSite=Lax` (`Secure` en HTTPS / `COOKIE_SECURE=true`), limitation des tentatives sur les routes sensibles, temps de rÃ©ponse constant sur identifiant inconnu, validation stricte des champs (photo d'avatar : data URL JPEG/PNG/WebP â‰¤ 300 Ko).

## Options (`.env`)

`SEED_DEMO_USER=true` (compte `demo@culinarpg.app` / `demo1234`), `MEALDB_IMPORT=true` (ajoute les recettes anglaises de TheMealDB), `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGINS`, `RESOLVE_IMAGES_ON_START=false`.

## Structure

```
lib/game.js                 niveaux, classes, titres, calcul des rÃ©compenses
lib/auth.js                 hachage, sessions, rate limit, validation
lib/images.js               rÃ©solution des photos WikipÃ©dia (+ CLI)
lib/text.js                 normalisation pour la recherche
render.yaml                 dÃ©ploiement Render (Blueprint)
prisma/schema.prisma        User, Session, UserSkill, DailyTask, UserDailyCompletion, Recipe, UserRecipeCompletion
prisma/seed.js              catalogue + photos + dailies
prisma/data/recipes/*.js    les 500 recettes (14 catÃ©gories)
prisma/data/images.json     cache des photos
server.js                   API Express + SPA
public/                     index.html, app.js, manifest, service worker, icÃ´nes
```
