// Normalisation pour la recherche : minuscules, sans accents, ligatures dépliées
const normalizeText = (s) => String(s || '')
  .toLowerCase()
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

module.exports = { normalizeText };
