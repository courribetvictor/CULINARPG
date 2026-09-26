#!/bin/sh
# Si la DB existe déjà (avant l'introduction des migrations), on la baseline
# pour éviter que migrate deploy essaie de recréer des tables déjà présentes.
# Sur une DB vierge, cette commande échouera silencieusement et migrate deploy
# créera tout depuis zéro.
npx prisma migrate resolve --applied "20260926000000_init" 2>/dev/null || true

# Applique uniquement les migrations non encore appliquées (jamais destructif)
npx prisma migrate deploy

exec node server.js
