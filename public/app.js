/* CulinaRPG — SPA mobile-first (vanilla ES6) */
(() => {
  'use strict';

  // ===========================================================================
  // Métadonnées
  // ===========================================================================
  const SKILL_META = {
    knife: { name: 'Couteau', emoji: '🔪', icon: 'slice', grad: 'from-emerald-400 to-teal-500', text: 'text-emerald-700', glow: 'rgba(52,211,153,.5)', hex: '#10b981' },
    fire: { name: 'Feu', emoji: '🔥', icon: 'flame', grad: 'from-amber-400 to-orange-500', text: 'text-orange-600', glow: 'rgba(251,146,60,.5)', hex: '#f97316' },
    seasoning: { name: 'Assaisonnement', emoji: '🧂', icon: 'sparkles', grad: 'from-violet-400 to-fuchsia-500', text: 'text-violet-600', glow: 'rgba(139,92,246,.5)', hex: '#8b5cf6' },
    prep: { name: 'Préparation', emoji: '⏱️', icon: 'timer', grad: 'from-cyan-400 to-blue-500', text: 'text-cyan-700', glow: 'rgba(6,182,212,.5)', hex: '#06b6d4' },
    baking: { name: 'Pâtisserie', emoji: '🥐', icon: 'croissant', grad: 'from-pink-400 to-rose-500', text: 'text-pink-600', glow: 'rgba(244,114,182,.5)', hex: '#ec4899' },
  };
  const SKILLS = Object.keys(SKILL_META);

  const RANKS = {
    1: { label: 'D', cls: 'from-slate-300 to-slate-500 text-slate-950' },
    2: { label: 'C', cls: 'from-emerald-300 to-teal-500 text-emerald-950' },
    3: { label: 'B', cls: 'from-cyan-300 to-blue-500 text-cyan-950' },
    4: { label: 'A', cls: 'from-violet-300 to-fuchsia-500 text-violet-950' },
    5: { label: 'S', cls: 'from-amber-200 to-orange-500 text-amber-950' },
  };

  const AVATAR_COLORS = {
    violet: 'from-violet-500 to-fuchsia-500',
    emerald: 'from-emerald-400 to-teal-600',
    amber: 'from-amber-400 to-orange-600',
    cyan: 'from-cyan-400 to-blue-600',
    pink: 'from-pink-400 to-rose-600',
    slate: 'from-slate-500 to-slate-800',
  };
  const AVATAR_EMOJIS = ['🧑‍🍳', '👩‍🍳', '👨‍🍳', '🦊', '🐱', '🐼', '🐸', '🦁', '🐙', '🦄', '🐲', '🤖', '👾', '🥷', '🧙', '🧛', '🍕', '🍩', '🌮', '🍣'];

  const CATEGORY_ICON = {
    'Petit-déjeuner': '🥐', Entrées: '🥗', Soupes: '🥣', Œufs: '🍳', 'Pâtes & Riz': '🍝', Viandes: '🥩', Volailles: '🍗',
    Poissons: '🐟', Végétarien: '🥦', Accompagnements: '🥔', Sauces: '🫙', Boulangerie: '🥖', Desserts: '🍰', 'Street food': '🍔',
  };

  const SORTS = [['featured', 'À la une'], ['quick', 'Plus rapides'], ['xp', 'Plus d\'XP'], ['easy', 'Plus faciles'], ['hard', 'Plus difficiles'], ['name', 'A → Z']];

  const LEAGUES = [
    { id: 'bronze',  name: 'Bronze',       emoji: '🥉', hex: '#cd7f32', minXp: 0     },
    { id: 'argent',  name: 'Argent',       emoji: '🥈', hex: '#94a3b8', minXp: 1000  },
    { id: 'or',      name: 'Or',           emoji: '🥇', hex: '#f59e0b', minXp: 4000  },
    { id: 'platine', name: 'Platine',      emoji: '💎', hex: '#67e8f9', minXp: 10000 },
    { id: 'diamant', name: 'Diamant',      emoji: '💠', hex: '#818cf8', minXp: 20000 },
    { id: 'master',  name: 'Master',       emoji: '👑', hex: '#f97316', minXp: 40000 },
    { id: 'liftoff', name: 'Maître Queux',  emoji: '⭐', hex: '#f97316', minXp: 80000 },
  ];

  const state = {
    tab: 'profile',
    user: null,
    profile: null,
    dailies: null,
    meta: null,
    categories: [],
    recipes: { items: [], page: 0, totalPages: 1, total: 0, search: '', category: 'all', skill: '', sort: 'featured', loading: false, reqId: 0 },
    quests: null,
    lessons: null,
    ranked: null,
    myRecipes: null,
    recipesSubTab: 'catalog',
  };

  // ===========================================================================
  // Utilitaires
  // ===========================================================================
  const leagueForXp = (xp) => { let l = LEAGUES[0]; for (const league of LEAGUES) { if (xp >= league.minXp) l = league; } return l; };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');
  const screen = $('#screen');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('fr-FR');
  const icons = () => window.lucide && window.lucide.createIcons();
  const haptic = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } };
  // Vignette Wikimedia plus légère pour les grilles
  const thumb = (url, w = 500) => (url && url.includes('/thumb/') ? url.replace(/\/\d+px-/, `/${w}px-`) : url);

  class ApiError extends Error {
    constructor(message, status, field) { super(message); this.status = status; this.field = field; }
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      state.user = null;
      showAuth('login', 'Ta session a expiré, reconnecte-toi.');
    }
    if (!res.ok) throw new ApiError(data.error || `Erreur ${res.status}`, res.status, data.field);
    return data;
  }

  // ===========================================================================
  // Effets
  // ===========================================================================
  const fx = {
    burst(origin = { y: 0.6 }) {
      if (!window.confetti) return;
      confetti({ particleCount: 80, spread: 75, startVelocity: 40, origin, colors: ['#34d399', '#fbbf24', '#e879f9', '#22d3ee', '#fb7185'], zIndex: 120, disableForReducedMotion: true });
    },
    fireworks(duration = 2600) {
      if (!window.confetti) return;
      const end = Date.now() + duration;
      const colors = ['#a78bfa', '#f0abfc', '#fbbf24', '#34d399', '#22d3ee', '#fb7185'];
      (function frame() {
        confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors, zIndex: 120, disableForReducedMotion: true });
        confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors, zIndex: 120, disableForReducedMotion: true });
        if (Date.now() < end) requestAnimationFrame(frame);
      }());
      [250, 900, 1600].forEach((t) => setTimeout(() => confetti({
        particleCount: 110, spread: 360, startVelocity: 30, gravity: 0.7, ticks: 220,
        origin: { x: 0.2 + Math.random() * 0.6, y: 0.2 + Math.random() * 0.25 }, colors, zIndex: 120, disableForReducedMotion: true,
      }), t));
    },
  };

  function toast(message, { icon = 'sparkles', tone = 'orange' } = {}) {
    const tones = {
      orange: 'bg-white border-orange-200 text-stone-800 shadow-[0_4px_20px_rgba(249,115,22,.15)]',
      emerald: 'bg-white border-emerald-200 text-stone-800 shadow-[0_4px_20px_rgba(52,211,153,.15)]',
      amber: 'bg-white border-amber-200 text-stone-800 shadow-[0_4px_20px_rgba(251,191,36,.15)]',
      rose: 'bg-white border-rose-200 text-stone-800 shadow-[0_4px_20px_rgba(244,63,94,.15)]',
      violet: 'bg-white border-violet-200 text-stone-800 shadow-[0_4px_20px_rgba(139,92,246,.15)]',
    };
    const el = document.createElement('div');
    el.className = `glass-strong pointer-events-auto rise flex items-center gap-2.5 rounded-2xl border bg-gradient-to-r ${tones[tone]} px-4 py-3 text-sm font-semibold shadow-2xl max-w-sm`;
    el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 shrink-0"></i><span>${esc(message)}</span>`;
    $('#toast-root').appendChild(el);
    icons();
    setTimeout(() => { el.style.transition = 'all .4s'; el.style.opacity = '0'; el.style.transform = 'translateY(-8px)'; }, 2800);
    setTimeout(() => el.remove(), 3300);
  }

  function floatXp(anchor, text, color = '#c4b5fd') {
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'xp-float text-lg';
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = `${r.top - 6}px`;
    el.style.color = color;
    el.style.textShadow = `0 0 14px ${color}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  function countUp(el, to, duration = 1100) {
    if (!el) return;
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function animateBars(root = document) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('[data-w]', root).forEach((b) => { b.style.width = `${b.dataset.w}%`; });
    }));
  }

  // ===========================================================================
  // Composants partagés
  // ===========================================================================
  function avatarHtml(u, { text = 'text-2xl', ring = '' } = {}) {
    const grad = AVATAR_COLORS[u?.avatarColor] || AVATAR_COLORS.violet;
    if (u?.avatarImage) {
      return `<img src="${esc(u.avatarImage)}" alt="" class="w-full h-full object-cover rounded-full ${ring}">`;
    }
    return `<div class="w-full h-full rounded-full grid place-items-center bg-gradient-to-br ${grad} ${text} ${ring}">${esc(u?.avatar || '🧑‍🍳')}</div>`;
  }

  function skillPill(skill, xp, size = 'sm') {
    const m = SKILL_META[skill];
    const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs';
    return `<span class="inline-flex items-center gap-1 rounded-full ${pad} font-bold bg-gradient-to-r ${m.grad} text-slate-950"
      style="box-shadow:0 0 10px ${m.glow.replace('.75', '.4')}">${m.emoji} +${xp}</span>`;
  }

  function glowBar(percent, grad, glow, h = 'h-2.5') {
    return `<div class="relative ${h} rounded-full bg-stone-100 overflow-hidden">
      <div class="bar-fill h-full rounded-full bg-gradient-to-r ${grad}" data-w="${percent}" style="width:0%"></div>
    </div>`;
  }

  const sectionTitle = (icon, title, sub = '', right = '') => `
    <div class="flex items-end justify-between gap-4 mb-3">
      <div class="min-w-0">
        <h2 class="flex items-center gap-2 text-lg sm:text-2xl font-bold tracking-tight text-stone-800">
          <i data-lucide="${icon}" class="w-5 h-5 text-orange-500"></i>${title}
        </h2>
        ${sub ? `<p class="text-sm text-stone-400 mt-0.5">${sub}</p>` : ''}
      </div>${right}
    </div>`;

  function recipeVisual(r, { cls = 'aspect-square', emojiSize = 'text-6xl', w = 500 } = {}) {
    const top = Object.entries(r.skillRewards || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'prep';
    const m = SKILL_META[top];
    const fallback = `<div class="absolute inset-0 grid place-items-center bg-gradient-to-br ${m.grad}">
        <div class="absolute inset-0 opacity-30" style="background-image:radial-gradient(circle at 20% 20%,rgba(255,255,255,.5) 0 2px,transparent 3px),radial-gradient(circle at 70% 60%,rgba(255,255,255,.35) 0 1.5px,transparent 2.5px);background-size:38px 38px,26px 26px"></div>
        <span class="img-zoom ${emojiSize} drop-shadow-[0_10px_20px_rgba(0,0,0,.45)]">${r.emoji}</span>
      </div>`;
    const img = r.imageUrl
      ? `<img src="${esc(thumb(r.imageUrl, w))}" alt="${esc(r.name)}" loading="lazy" decoding="async" class="img-zoom absolute inset-0 w-full h-full object-cover bg-stone-200" onerror="this.remove()">`
      : '';
    return `<div class="relative ${cls} overflow-hidden">${fallback}${img}
      <div class="absolute inset-0 bg-gradient-to-t from-stone-900/70 via-stone-900/10 to-transparent"></div></div>`;
  }

  function emptyState(icon, title, text, action = '') {
    return `<div class="glass rounded-3xl p-8 text-center">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-stone-100 grid place-items-center text-stone-400"><i data-lucide="${icon}" class="w-6 h-6"></i></div>
      <h3 class="mt-3 font-bold tracking-tight text-lg text-stone-800">${title}</h3>
      <p class="text-sm text-stone-400 mt-1">${text}</p>${action}
    </div>`;
  }

  const skeleton = () => `<div class="grid gap-4"><div class="h-48 rounded-3xl skeleton"></div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${'<div class="h-40 rounded-2xl skeleton"></div>'.repeat(6)}</div></div>`;

  const inputCls = 'w-full rounded-2xl bg-white border border-stone-200 px-4 py-3.5 text-base text-stone-800 placeholder:text-stone-400 outline-none transition-all duration-300 focus:border-orange-400 focus:shadow-[0_0_0_4px_rgba(249,115,22,.1)]';
  const primaryBtn = 'press w-full inline-flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-extrabold text-white bg-gradient-to-r from-orange-500 to-orange-600 shadow-[0_4px_20px_rgba(249,115,22,.35)] disabled:opacity-60';

  function field({ name, label, type = 'text', value = '', placeholder = '', autocomplete = '', extra = '' }) {
    return `<label class="block">
      <span class="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5">${label}</span>
      <input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${extra} class="${inputCls}">
      <span data-error="${name}" class="hidden block text-xs font-semibold text-rose-500 mt-1.5"></span>
    </label>`;
  }

  function showFieldError(form, err) {
    $$('[data-error]', form).forEach((e) => e.classList.add('hidden'));
    const target = err.field && $(`[data-error="${err.field}"]`, form);
    if (target) { target.textContent = err.message; target.classList.remove('hidden'); } else toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
  }

  // ===========================================================================
  // Écran d'authentification
  // ===========================================================================
  function showShell(visible) {
    $('#shell').classList.toggle('hidden', !visible);
    screen.classList.toggle('hidden', visible);
  }

  function showAuth(mode = 'login', notice = '') {
    closeAll();
    showShell(false);
    const isLogin = mode === 'login';
    screen.innerHTML = `
      <div class="min-h-[100dvh] flex flex-col px-5 pt-safe pb-safe max-w-md mx-auto bg-stone-50">
        <div class="flex-1 flex flex-col justify-center py-8">
          <div class="text-center rise">
            <div class="relative mx-auto w-24 h-24 float-y">
              <div class="relative w-24 h-24 rounded-[28px] bg-gradient-to-br from-orange-400 to-orange-600 grid place-items-center text-5xl shadow-[0_8px_32px_rgba(249,115,22,.35)]">🍳</div>
            </div>
            <h1 class="mt-6 text-4xl font-black tracking-tight font-display text-stone-900">Culina<span class="text-orange-500">RPG</span></h1>
            <p class="mt-2 text-stone-400 text-sm">Monte en niveau en cuisinant. 1500 quêtes t'attendent.</p>
            <div class="mt-4 flex justify-center gap-1.5">${SKILLS.map((s) => `<span class="w-9 h-9 rounded-xl grid place-items-center bg-gradient-to-br ${SKILL_META[s].grad} text-white text-lg shadow-sm">${SKILL_META[s].emoji}</span>`).join('')}</div>
          </div>

          <div class="bg-white border border-stone-200 shadow-sm rise rounded-3xl p-5 mt-8" style="animation-delay:.08s">
            <div class="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-stone-100 border border-stone-200">
              <button data-auth-mode="login" class="press rounded-xl py-2.5 text-sm font-bold transition-all ${isLogin ? 'bg-white text-orange-600 shadow-sm border border-stone-200' : 'text-stone-400'}">Connexion</button>
              <button data-auth-mode="signup" class="press rounded-xl py-2.5 text-sm font-bold transition-all ${!isLogin ? 'bg-white text-orange-600 shadow-sm border border-stone-200' : 'text-stone-400'}">Inscription</button>
            </div>
            ${notice ? `<p class="mt-4 text-sm font-semibold text-orange-700 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2">${esc(notice)}</p>` : ''}
            <form id="auth-form" class="mt-5 space-y-4" novalidate>
              ${isLogin ? `
                ${field({ name: 'identifier', label: 'E-mail ou pseudo', placeholder: 'chef@exemple.fr', autocomplete: 'username', extra: 'autocapitalize="none" required' })}
                ${field({ name: 'password', label: 'Mot de passe', type: 'password', placeholder: '••••••••', autocomplete: 'current-password', extra: 'required' })}
              ` : `
                ${field({ name: 'username', label: 'Pseudo', placeholder: 'chef_victor', autocomplete: 'username', extra: 'autocapitalize="none" maxlength="20" required' })}
                ${field({ name: 'email', label: 'E-mail', type: 'email', placeholder: 'chef@exemple.fr', autocomplete: 'email', extra: 'autocapitalize="none" required' })}
                ${field({ name: 'password', label: 'Mot de passe (8 caractères min.)', type: 'password', placeholder: '••••••••', autocomplete: 'new-password', extra: 'minlength="8" required' })}
                ${state.meta?.inviteRequired ? field({ name: 'inviteCode', label: 'Code d\'invitation', placeholder: 'Code reçu', autocomplete: 'off', extra: 'autocapitalize="none" required' }) : ''}
              `}
              <button type="submit" class="${primaryBtn}">
                <i data-lucide="${isLogin ? 'log-in' : 'sparkles'}" class="w-5 h-5"></i>${isLogin ? 'Entrer dans la cuisine' : 'Créer mon personnage'}
              </button>
            </form>
          </div>
        </div>
        <p class="text-center text-xs text-stone-400 pb-2">Photos : Wikipédia / Wikimedia Commons · <a href="/privacy" class="underline hover:text-orange-500">Confidentialité</a></p>
      </div>`;
    icons();

    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = $('button[type=submit]', form);
      const body = Object.fromEntries(new FormData(form));
      btn.disabled = true;
      try {
        const { user } = await api(`/api/auth/${isLogin ? 'login' : 'signup'}`, { method: 'POST', body });
        state.user = user;
        haptic(15);
        if (!user.onboarded) showOnboarding(); else enterApp();
      } catch (err) {
        showFieldError(form, err);
        btn.disabled = false;
      }
    });
  }

  // ===========================================================================
  // Éditeur d'avatar (onboarding + réglages)
  // ===========================================================================
  function avatarEditorHtml(d) {
    return `
      <div class="flex flex-col items-center">
        <div class="relative w-28 h-28">
          <div id="av-preview" class="w-28 h-28 rounded-full p-[3px] bg-gradient-to-br from-orange-400 to-amber-300 shadow-[0_4px_20px_rgba(249,115,22,.3)]">
            <div class="w-full h-full rounded-full overflow-hidden bg-stone-100">${avatarHtml(d, { text: 'text-5xl' })}</div>
          </div>
          <label class="press absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-white border border-stone-200 grid place-items-center cursor-pointer shadow-md" aria-label="Choisir une photo">
            <i data-lucide="camera" class="w-5 h-5 text-stone-500"></i>
            <input id="av-file" type="file" accept="image/*" class="hidden">
          </label>
        </div>
        ${d.avatarImage ? '<button type="button" data-av-remove class="mt-3 text-xs font-bold text-rose-500 press">Retirer la photo</button>' : '<p class="mt-3 text-xs text-stone-400">Choisis un emoji ou ajoute une photo</p>'}
      </div>
      <div class="mt-4 grid grid-cols-6 sm:grid-cols-10 gap-2">
        ${AVATAR_EMOJIS.map((e) => `<button type="button" data-av-emoji="${e}" class="press aspect-square rounded-2xl grid place-items-center text-2xl border transition-all ${!d.avatarImage && d.avatar === e ? 'border-orange-400 bg-orange-50 shadow-[0_0_10px_rgba(249,115,22,.2)]' : 'border-stone-200 bg-stone-50'}">${e}</button>`).join('')}
      </div>
      <div class="mt-4 flex justify-center gap-3">
        ${Object.entries(AVATAR_COLORS).map(([k, g]) => `<button type="button" data-av-color="${k}" aria-label="Couleur ${k}" class="press w-9 h-9 rounded-full bg-gradient-to-br ${g} transition-all ${d.avatarColor === k ? 'ring-2 ring-white ring-offset-2 ring-offset-stone-100 scale-110' : 'opacity-70'}"></button>`).join('')}
      </div>`;
  }

  // Redimensionne et recadre la photo en carré 256 px (JPEG ~20-40 Ko)
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Ce fichier n\'est pas une image.'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const size = 256;
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
      img.src = url;
    });
  }

  // Branche les interactions de l'éditeur ; rerender() est appelé après chaque changement
  function bindAvatarEditor(root, draft, rerender) {
    root.addEventListener('click', (e) => {
      const emo = e.target.closest('[data-av-emoji]');
      const col = e.target.closest('[data-av-color]');
      if (emo) { draft.avatar = emo.dataset.avEmoji; draft.avatarImage = null; haptic(); rerender(); }
      if (col) { draft.avatarColor = col.dataset.avColor; haptic(); rerender(); }
      if (e.target.closest('[data-av-remove]')) { draft.avatarImage = null; rerender(); }
    });
    root.addEventListener('change', async (e) => {
      if (e.target.id !== 'av-file' || !e.target.files[0]) return;
      try {
        draft.avatarImage = await resizeImage(e.target.files[0]);
        rerender();
      } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
    });
  }

  // ===========================================================================
  // Onboarding (après inscription)
  // ===========================================================================
  function showOnboarding() {
    showShell(false);
    const u = state.user;
    const draft = { step: 1, displayName: u.displayName, avatar: u.avatar, avatarColor: u.avatarColor, avatarImage: u.avatarImage, chefClass: u.chefClass || null };
    const classes = state.meta?.classes || SKILLS.map((s) => ({ skill: s, name: SKILL_META[s].name, description: '' }));

    const render = () => {
      const dots = [1, 2, 3].map((i) => `<span class="h-1.5 rounded-full transition-all duration-500 ${i === draft.step ? 'w-8 bg-orange-500' : i < draft.step ? 'w-4 bg-orange-300' : 'w-4 bg-stone-200'}"></span>`).join('');
      let body = '';
      if (draft.step === 1) {
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-orange-500 font-semibold">Étape 1 · Identité</p>
          <h1 class="text-3xl font-black tracking-tight mt-1 text-stone-900">Crée ton chef</h1>
          <p class="text-stone-400 text-sm mt-1">Choisis ton apparence et ton nom de héros.</p>
          <div class="glass rounded-3xl p-5 mt-5" id="ob-avatar">${avatarEditorHtml(draft)}</div>
          <div class="mt-4">${field({ name: 'displayName', label: 'Nom affiché', value: draft.displayName, placeholder: 'Chef Victor', extra: 'maxlength="30" id="ob-name"' })}</div>`;
      } else if (draft.step === 2) {
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-orange-500 font-semibold">Étape 2 · Classe</p>
          <h1 class="text-3xl font-black tracking-tight mt-1 text-stone-900">Choisis ta voie</h1>
          <p class="text-stone-400 text-sm mt-1">Ta classe te donne <b class="text-orange-600">+10 % d'XP</b> dans sa compétence. Modifiable plus tard.</p>
          <div class="mt-5 grid gap-3">
            ${classes.map((c) => {
              const m = SKILL_META[c.skill]; const on = draft.chefClass === c.skill;
              return `<button type="button" data-class="${c.skill}" class="press text-left glass rounded-2xl p-4 flex items-center gap-4 transition-all duration-300 ${on ? 'ring-2 ring-orange-400 shadow-[0_0_20px_rgba(249,115,22,.2)]' : ''}">
                <span class="w-14 h-14 shrink-0 rounded-2xl grid place-items-center text-2xl bg-gradient-to-br ${m.grad}">${m.emoji}</span>
                <span class="flex-1 min-w-0"><span class="block text-lg font-extrabold tracking-tight text-stone-800">${esc(c.name)}</span>
                  <span class="block text-sm text-stone-400">${esc(c.description || `+10 % d'XP ${m.name}`)}</span></span>
                <span class="w-6 h-6 rounded-full border-2 grid place-items-center ${on ? 'border-transparent bg-orange-500' : 'border-stone-300'}">${on ? '<i data-lucide="check" class="w-4 h-4 text-white"></i>' : ''}</span>
              </button>`;
            }).join('')}
          </div>`;
      } else {
        const m = SKILL_META[draft.chefClass] || SKILL_META.prep;
        const c = classes.find((x) => x.skill === draft.chefClass);
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-orange-500 font-semibold">Étape 3 · Prêt</p>
          <h1 class="text-3xl font-black tracking-tight mt-1 text-stone-900">Ton aventure commence</h1>
          <div class="mt-6 glass-strong rounded-[28px]">
            <div class="rounded-[28px] p-6 text-center">
              <div class="mx-auto w-28 h-28 rounded-full p-[3px] bg-gradient-to-br ${m.grad} pop shadow-[0_4px_20px_rgba(249,115,22,.3)]"><div class="w-full h-full rounded-full overflow-hidden bg-stone-100">${avatarHtml(draft, { text: 'text-5xl' })}</div></div>
              <h2 class="mt-4 text-2xl font-black tracking-tight text-stone-900">${esc(draft.displayName)}</h2>
              <p class="text-orange-500 font-semibold text-sm">Commis de Cuisine · Niv. 1</p>
              <div class="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gradient-to-r ${m.grad} text-white font-extrabold text-sm shadow-sm">${m.emoji} Classe ${esc(c?.name || '')}</div>
              <div class="mt-5 grid grid-cols-3 gap-2 text-center">
                <div class="rounded-2xl bg-stone-50 border border-stone-200 p-3"><div class="text-xl font-black text-stone-800">500</div><div class="text-[10px] uppercase tracking-wider text-stone-400 font-bold">Quêtes</div></div>
                <div class="rounded-2xl bg-stone-50 border border-stone-200 p-3"><div class="text-xl font-black text-stone-800">5</div><div class="text-[9px] uppercase tracking-normal text-stone-400 font-bold">Compétences</div></div>
                <div class="rounded-2xl bg-stone-50 border border-stone-200 p-3"><div class="text-xl font-black text-stone-800">7</div><div class="text-[10px] uppercase tracking-wider text-stone-400 font-bold">Dailies</div></div>
              </div>
            </div>
          </div>`;
      }

      screen.innerHTML = `
        <div class="min-h-[100dvh] bg-stone-50 flex flex-col px-5 pt-safe max-w-lg mx-auto">
          <div class="flex items-center justify-between py-4">
            ${draft.step > 1 ? '<button data-ob-back class="press w-10 h-10 rounded-full glass grid place-items-center" aria-label="Retour"><i data-lucide="chevron-left" class="w-5 h-5 text-stone-600"></i></button>' : '<span class="w-10"></span>'}
            <div class="flex gap-1.5">${dots}</div><span class="w-10"></span>
          </div>
          <div class="flex-1 rise" key="${draft.step}">${body}</div>
          <div class="sticky bottom-0 py-4 pb-safe bg-gradient-to-t from-stone-50 via-stone-50/95 to-transparent">
            <button data-ob-next class="${primaryBtn}" ${draft.step === 2 && !draft.chefClass ? 'disabled' : ''}>
              ${draft.step === 3 ? '<i data-lucide="swords" class="w-5 h-5"></i>Commencer l\'aventure' : 'Continuer<i data-lucide="chevron-right" class="w-5 h-5"></i>'}
            </button>
          </div>
        </div>`;
      icons();
      const nameInput = $('#ob-name');
      if (nameInput) nameInput.addEventListener('input', (e) => { draft.displayName = e.target.value; });
    };

    // Délégation (screen est réutilisé → on remplace les écouteurs via un handler unique)
    screen.onclick = async (e) => {
      if (e.target.closest('[data-ob-back]')) { draft.step--; render(); return; }
      const cls = e.target.closest('[data-class]');
      if (cls) { draft.chefClass = cls.dataset.class; haptic(); render(); return; }
      if (!e.target.closest('[data-ob-next]')) return;
      if (draft.step === 1) {
        draft.displayName = ($('#ob-name')?.value || '').trim();
        if (!draft.displayName) { toast('Choisis un nom affiché.', { icon: 'alert-triangle', tone: 'rose' }); return; }
        draft.step = 2; render();
      } else if (draft.step === 2) {
        draft.step = 3; render();
        setTimeout(() => fx.burst({ y: 0.4 }), 300);
      } else {
        const btn = e.target.closest('[data-ob-next]');
        btn.disabled = true;
        try {
          const { user } = await api('/api/user/profile', {
            method: 'PATCH',
            body: { displayName: draft.displayName, avatar: draft.avatar, avatarColor: draft.avatarColor, avatarImage: draft.avatarImage || null, chefClass: draft.chefClass, onboarded: true },
          });
          state.user = user;
          screen.onclick = null; screen.onchange = null;
          fx.fireworks(1600);
          enterApp();
        } catch (err) {
          toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
          btn.disabled = false;
        }
      }
    };
    // Éditeur d'avatar de l'étape 1 (écouteurs posés une seule fois sur screen)
    const avatarRoot = { addEventListener: (type, fn) => screen.addEventListener(type, (e) => { if (draft.step === 1 && e.target.closest('#ob-avatar')) fn(e); }) };
    bindAvatarEditor(avatarRoot, draft, () => { const box = $('#ob-avatar'); if (box) { box.innerHTML = avatarEditorHtml(draft); icons(); } });
    render();
  }

  // ===========================================================================
  // Application principale
  // ===========================================================================
  async function enterApp() {
    closeAll();
    showShell(true);
    screen.innerHTML = '';
    app.innerHTML = skeleton();
    try {
      await loadProfile();
      api('/api/dailies').then((d) => { state.dailies = d; updateDailyDot(); }).catch(() => {});
    } catch { return; }
    const initial = location.hash.slice(1);
    setTab(['profile', 'dailies', 'recipes', 'lessons', 'ranked'].includes(initial) ? initial : state.tab, { push: false });
    if (document.fonts?.ready) document.fonts.ready.then(moveIndicator);

    // Retour depuis Stripe Checkout
    const params = new URLSearchParams(location.search);
    if (params.get('payment') === 'success') {
      const type = params.get('type');
      const earned = parseInt(params.get('earned') || '0', 10);
      history.replaceState(null, '', location.hash || '#profile');
      setTimeout(() => {
        if (type === 'gems') { haptic(30); toast(`+${fmt(earned)} 💎 gemmes ajoutées !`, { icon: 'gem', tone: 'emerald' }); }
        if (type === 'pro') { haptic([20, 30, 20]); fx.fireworks(2000); toast('Bienvenue dans le club Pro ⭐ !', { icon: 'star', tone: 'emerald' }); }
        if (type === 'lesson') { haptic(20); toast('Leçon débloquée ! 🎓', { icon: 'graduation-cap', tone: 'emerald' }); state.lessons = null; }
      }, 600);
      // Le webhook Stripe crédite en quelques secondes — on recharge le profil pour afficher le vrai solde
      setTimeout(async () => {
        await loadProfile();
        renderHeader();
        if (state.tab === 'lessons') renderLessons();
      }, 2500);
    }
  }

  function renderHeader() {
    const p = state.profile;
    if (!p) return;
    $('#hdr-avatar-inner').innerHTML = avatarHtml(p, { text: 'text-xl' });
    $('#hdr-name').textContent = p.displayName;
    $('#hdr-title').textContent = p.title;
    $('#hdr-level-badge').textContent = p.level;
    $('#hdr-xp-bar').style.width = `${p.global.percent}%`;
    $('#hdr-xp-text').textContent = `${fmt(p.global.currentLevelXp)}/${fmt(p.global.nextLevelXp)}`;
    $('#hdr-ring').style.background = `conic-gradient(#f97316 ${p.global.percent}%, #e7e5e4 ${p.global.percent}%)`;
    $('#hdr-streak-count').textContent = p.streak;
    $('#hdr-flame').classList.toggle('flame-off', p.streak === 0);
    $('#hdr-streak').title = p.activeToday ? `Série de ${p.streak} jour(s) — actif aujourd'hui` : 'Cuisine ou complète une daily pour entretenir ta série !';
    const gemsEl = $('#hdr-gems-count');
    if (gemsEl) gemsEl.textContent = fmt(p.gems || 0);
  }

  async function loadProfile() {
    state.profile = await api('/api/user/profile');
    state.user = { ...state.user, ...state.profile };
    renderHeader();
    return state.profile;
  }

  function updateDailyDot() {
    const d = state.dailies;
    if (d) $('#nav-dailies-dot').classList.toggle('hidden', d.completedCount >= d.totalCount);
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  function moveIndicator() {
    const btn = $(`.nav-btn[data-tab="${state.tab}"]`);
    const ind = $('#nav-indicator');
    if (btn && ind) { ind.style.left = `${btn.offsetLeft}px`; ind.style.width = `${btn.offsetWidth}px`; }
    $$('.nav-btn').forEach((b) => {
      const active = b.dataset.tab === state.tab;
      b.classList.toggle('text-white', active);
      b.classList.toggle('sm:text-white', active);
      b.classList.toggle('text-orange-500', active);
      b.classList.toggle('text-stone-400', !active);
      const ico = $('.nav-ico', b);
      ico.classList.toggle('bg-orange-100', active);
      ico.classList.toggle('text-orange-500', active);
      ico.classList.toggle('sm:bg-transparent', active);
      ico.classList.toggle('sm:text-white', active);
    });
  }

  function setTab(tab, { push = true } = {}) {
    if (!['profile', 'dailies', 'recipes', 'lessons', 'ranked', 'pro'].includes(tab)) tab = 'profile';
    const changed = state.tab !== tab;
    state.tab = tab;
    if (push) history.replaceState(null, '', `#${tab}`);
    moveIndicator();
    if (changed) window.scrollTo({ top: 0 });
    ({ profile: renderProfile, dailies: renderDailies, recipes: renderRecipes, lessons: renderLessons, ranked: renderRanked, pro: renderPro })[tab]();
  }

  // ===========================================================================
  // Onglet PROFIL
  // ===========================================================================
  function radarChart(skills) {
    const size = 260; const c = size / 2; const R = 88;
    const maxLvl = Math.max(5, ...skills.map((s) => s.level));
    const angle = (i) => (-Math.PI / 2) + (i * 2 * Math.PI) / skills.length;
    const pt = (i, r) => [c + r * Math.cos(angle(i)), c + r * Math.sin(angle(i))];
    const rings = [0.25, 0.5, 0.75, 1].map((f) => `<polygon points="${skills.map((_, i) => pt(i, R * f).join(',')).join(' ')}" fill="none" stroke="rgba(148,163,184,.14)" />`).join('');
    const axes = skills.map((_, i) => `<line x1="${c}" y1="${c}" x2="${pt(i, R)[0]}" y2="${pt(i, R)[1]}" stroke="rgba(148,163,184,.12)" />`).join('');
    const value = (s) => Math.max(0.08, (s.level - 1 + s.percent / 100) / maxLvl);
    const poly = skills.map((s, i) => pt(i, R * value(s)).join(',')).join(' ');
    const dots = skills.map((s, i) => { const [x, y] = pt(i, R * value(s)); return `<circle cx="${x}" cy="${y}" r="4.5" fill="${SKILL_META[s.skill].hex}" style="filter:drop-shadow(0 0 6px ${SKILL_META[s.skill].hex})"/>`; }).join('');
    const labels = skills.map((s, i) => { const [x, y] = pt(i, R + 24); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="18">${SKILL_META[s.skill].emoji}</text>`; }).join('');
    return `<svg viewBox="0 0 ${size} ${size}" class="w-full max-w-[240px] mx-auto" role="img" aria-label="Profil de compétences">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f97316" stop-opacity=".45"/><stop offset="1" stop-color="#fb923c" stop-opacity=".25"/></linearGradient></defs>
      ${rings}${axes}
      <polygon points="${poly}" fill="url(#rg)" stroke="#f97316" stroke-width="2" style="filter:drop-shadow(0 0 8px rgba(249,115,22,.4))"/>
      ${dots}${labels}
    </svg>`;
  }

  function renderProfile() {
    const p = state.profile;
    if (!p) { app.innerHTML = skeleton(); return; }
    const unlocked = p.badges.filter((b) => b.unlocked).length;
    const cls = p.chefClass && SKILL_META[p.chefClass];
    const clsName = p.chefClass && (state.meta?.classes.find((c) => c.skill === p.chefClass)?.name);

    app.innerHTML = `
      <section class="grid lg:grid-cols-3 gap-4">
        <div class="glass rise rounded-3xl p-5 sm:p-7 lg:col-span-2 relative overflow-hidden">
          <button data-open="account" class="press absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-stone-100 border border-stone-200 grid place-items-center hover:bg-stone-200 transition-colors" aria-label="Réglages du compte"><i data-lucide="settings-2" class="w-5 h-5 text-stone-500"></i></button>
          <div class="relative flex flex-col sm:flex-row items-center gap-5 sm:gap-7">
            <div class="relative shrink-0">
              <div class="w-32 h-32 rounded-full p-[4px] shadow-[0_4px_20px_rgba(249,115,22,.25)]" style="background:conic-gradient(#f97316 ${p.global.percent}%, #e7e5e4 ${p.global.percent}%)">
                <div class="w-full h-full rounded-full overflow-hidden bg-stone-100">${avatarHtml(p, { text: 'text-6xl' })}</div>
              </div>
              <div class="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-extrabold tracking-wider bg-orange-500 text-white shadow-[0_2px_8px_rgba(249,115,22,.4)] border-2 border-white whitespace-nowrap">NIV. ${p.level}</div>
            </div>
            <div class="flex-1 min-w-0 w-full text-center sm:text-left">
              <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-stone-900 truncate font-display">${esc(p.displayName)}</h1>
              <p class="text-sm text-stone-400 font-semibold">@${esc(p.username)}</p>
              <div class="mt-2 flex flex-wrap justify-center sm:justify-start gap-2">
                <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-orange-50 border border-orange-200 text-orange-700"><i data-lucide="crown" class="w-3.5 h-3.5"></i>${esc(p.title)}</span>
                ${cls ? `<span class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-extrabold bg-gradient-to-r ${cls.grad} text-white shadow-sm">${cls.emoji} ${esc(clsName || cls.name)}</span>` : ''}
                <span class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold bg-cyan-50 border border-cyan-200 text-cyan-700">💎 ${fmt(p.gems || 0)} gemmes</span>
                <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold" style="background:${leagueForXp(p.totalXp).hex}18;border:1px solid ${leagueForXp(p.totalXp).hex}55;color:${leagueForXp(p.totalXp).hex}">${leagueForXp(p.totalXp).emoji} ${leagueForXp(p.totalXp).name}</span>
              </div>
              ${p.bio ? `<p class="mt-3 text-sm text-stone-600 leading-relaxed">${esc(p.bio)}</p>` : ''}
              <div class="mt-4">
                <div class="flex justify-between text-xs font-semibold text-stone-400 mb-1.5">
                  <span>XP global · ${fmt(p.totalXp)}</span><span class="tabular-nums">${fmt(p.global.currentLevelXp)} / ${fmt(p.global.nextLevelXp)}</span>
                </div>
                ${glowBar(p.global.percent, 'from-orange-400 to-orange-500', 'rgba(249,115,22,.5)', 'h-3')}
              </div>
            </div>
          </div>
          <div class="relative grid grid-cols-3 gap-2 sm:gap-3 mt-6">
            ${[
              ['utensils', 'Recettes', p.stats.recipesCooked, 'text-emerald-500'],
              ['calendar-check', 'Dailies', p.stats.dailiesDone, 'text-cyan-500'],
              ['flame', 'Record', `${p.bestStreak} j`, 'text-orange-500'],
            ].map(([ic, label, val, c]) => `
              <div class="rounded-2xl bg-stone-50 border border-stone-200 p-3 text-center">
                <i data-lucide="${ic}" class="w-4 h-4 mx-auto ${c}"></i>
                <div class="text-xl sm:text-2xl font-extrabold mt-1 tabular-nums text-stone-800">${val}</div>
                <div class="text-[10px] uppercase tracking-wider text-stone-400 font-bold">${label}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="glass rise rounded-3xl p-5 flex flex-col" style="animation-delay:.08s">
          <h3 class="font-bold tracking-tight flex items-center gap-2 text-stone-700"><i data-lucide="radar" class="w-4 h-4 text-orange-500"></i>Profil de compétences</h3>
          <div class="flex-1 grid place-items-center py-2">${radarChart(p.skills)}</div>
        </div>
      </section>

      <section class="mt-7">
        ${sectionTitle('swords', 'Compétences', 'Chaque recette et daily fait progresser tes stats.')}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          ${p.skills.map((s, i) => {
            const m = SKILL_META[s.skill]; const isClass = p.chefClass === s.skill;
            return `
            <div class="glass rise rounded-2xl p-3.5 lg:p-4 flex lg:block items-center gap-3 relative overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-md" style="animation-delay:${0.04 * i + 0.1}s">
              <div class="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br ${m.grad} grid place-items-center text-white shadow-sm">
                <i data-lucide="${m.icon}" class="w-5 h-5"></i>
              </div>
              <div class="flex-1 min-w-0 lg:mt-3">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold tracking-tight truncate text-stone-700">${m.name}${isClass ? ' <span class="text-[10px] align-middle font-black text-orange-500">+10%</span>' : ''}</span>
                  <span class="text-sm font-black ${m.text} shrink-0">Niv. ${s.level}</span>
                </div>
                <div class="mt-2">${glowBar(s.percent, m.grad, m.glow, 'h-2')}</div>
                <div class="mt-1 flex justify-between text-[11px] font-semibold text-stone-400 tabular-nums">
                  <span>${fmt(s.currentLevelXp)} / ${fmt(s.nextLevelXp)}</span><span>${fmt(s.xp)} XP</span>
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="mt-7">
        ${sectionTitle('award', 'Badges', `${unlocked} / ${p.badges.length} débloqués`)}
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
          ${p.badges.map((b, i) => `
            <div class="rise rounded-2xl p-3 text-center transition-all duration-300 ${b.unlocked
              ? 'glass border-amber-200 hover:-translate-y-1 hover:shadow-md'
              : 'bg-stone-50 border border-dashed border-stone-300 opacity-60'}" style="animation-delay:${0.03 * i}s" title="${esc(b.description)}">
              <div class="w-11 h-11 mx-auto rounded-2xl grid place-items-center ${b.unlocked
                ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-white shadow-sm'
                : 'bg-stone-200 text-stone-400'}"><i data-lucide="${b.unlocked ? b.icon : 'lock'}" class="w-5 h-5"></i></div>
              <div class="mt-2 text-xs font-bold tracking-tight leading-tight text-stone-700">${esc(b.name)}</div>
              <div class="text-[10px] text-stone-400 mt-0.5 leading-snug">${esc(b.description)}</div>
            </div>`).join('')}
        </div>
      </section>

      <section class="mt-7">
        ${sectionTitle('scroll-text', 'Journal de quêtes', 'Tes dernières recettes accomplies.')}
        ${p.recent.length ? `<div class="glass rounded-2xl divide-y divide-stone-100 overflow-hidden">
          ${p.recent.map((c) => `
            <button data-recipe="${c.recipe.id}" class="press w-full flex items-center gap-3 p-3 text-left hover:bg-stone-50 transition-colors">
              <span class="w-12 h-12 rounded-xl overflow-hidden bg-stone-100 grid place-items-center text-xl shrink-0">${c.recipe.imageUrl ? `<img src="${esc(thumb(c.recipe.imageUrl, 330))}" class="w-full h-full object-cover" loading="lazy" alt="">` : c.recipe.emoji}</span>
              <span class="flex-1 min-w-0"><span class="block font-semibold truncate text-stone-800">${esc(c.recipe.name)}</span>
                <span class="text-xs text-stone-400">${new Date(c.cookedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}</span></span>
              <span class="text-sm font-extrabold text-orange-500 tabular-nums">+${fmt(c.xpGained)}</span>
            </button>`).join('')}
        </div>` : emptyState('chef-hat', 'Aucune recette cuisinée', 'Ouvre le tableau des quêtes et lance ta première recette !',
          '<button data-nav="recipes" class="press mt-4 rounded-xl px-5 py-3 text-sm font-bold bg-orange-500 text-white shadow-[0_4px_16px_rgba(249,115,22,.35)] hover:bg-orange-600 transition-colors">Voir les quêtes</button>')}
      </section>`;

    icons();
    animateBars(app);
  }

  // ===========================================================================
  // Réglages du compte (page plein écran)
  // ===========================================================================
  function openAccount() {
    const p = state.profile;
    if (!p) return;
    const draft = { avatar: p.avatar, avatarColor: p.avatarColor, avatarImage: p.avatarImage };
    const classes = state.meta?.classes || [];
    const root = $('#page-root');
    root.innerHTML = `
      <div class="page fixed inset-0 z-[70] bg-stone-50 overflow-y-auto page-in">
        <div class="sticky top-0 z-10 bg-white border-b border-stone-200 shadow-sm pt-safe">
          <div class="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3">
            <button data-close-page class="press w-10 h-10 rounded-full bg-stone-100 border border-stone-200 grid place-items-center hover:bg-stone-200 transition-colors" aria-label="Retour"><i data-lucide="chevron-left" class="w-5 h-5 text-stone-600"></i></button>
            <h1 class="text-lg font-bold tracking-tight flex-1 text-stone-800">Mon compte</h1>
          </div>
        </div>
        <div class="max-w-2xl mx-auto px-4 py-5 space-y-5 pb-safe">
          <form id="acc-profile" class="glass rounded-3xl p-5 space-y-4" novalidate>
            <h2 class="font-bold tracking-tight flex items-center gap-2 text-stone-800"><i data-lucide="user-round-pen" class="w-4 h-4 text-orange-500"></i>Profil</h2>
            <div id="acc-avatar">${avatarEditorHtml(draft)}</div>
            ${field({ name: 'displayName', label: 'Nom affiché', value: p.displayName, extra: 'maxlength="30"' })}
            ${field({ name: 'username', label: 'Pseudo', value: p.username, extra: 'maxlength="20" autocapitalize="none"' })}
            <label class="block">
              <span class="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5">Bio</span>
              <textarea name="bio" rows="3" maxlength="160" placeholder="Passionné de cuisine au feu de bois…" class="${inputCls} resize-none">${esc(p.bio)}</textarea>
              <span data-error="bio" class="hidden block text-xs font-semibold text-rose-500 mt-1.5"></span>
            </label>
            <button type="submit" class="${primaryBtn}"><i data-lucide="save" class="w-5 h-5"></i>Enregistrer</button>
          </form>

          <section class="glass rounded-3xl p-5">
            <h2 class="font-bold tracking-tight flex items-center gap-2 text-stone-800"><i data-lucide="crown" class="w-4 h-4 text-amber-500"></i>Titre affiché</h2>
            <p class="text-xs text-stone-400 mt-1">Débloque de nouveaux titres en montant de niveau.</p>
            <div class="mt-3 grid gap-2">
              <button data-title="" class="press flex items-center justify-between rounded-2xl px-4 py-3 border text-left ${!p.selectedTitle ? 'border-orange-400 bg-orange-50' : 'border-stone-200 bg-stone-50'}">
                <span><span class="block font-semibold text-sm text-stone-800">Automatique</span><span class="text-xs text-stone-400">Selon ton niveau global</span></span>
                ${!p.selectedTitle ? '<i data-lucide="check" class="w-5 h-5 text-orange-500"></i>' : ''}
              </button>
              ${p.titles.map((t) => `
                <button data-title="${esc(t.name)}" ${t.unlocked ? '' : 'disabled'} class="press flex items-center justify-between rounded-2xl px-4 py-3 border text-left ${p.selectedTitle === t.name ? 'border-orange-400 bg-orange-50' : 'border-stone-200 bg-stone-50'} ${t.unlocked ? '' : 'opacity-45'}">
                  <span><span class="block font-semibold text-sm text-stone-800">${t.skill ? SKILL_META[t.skill].emoji + ' ' : ''}${esc(t.name)}</span><span class="text-xs text-stone-400">${esc(t.requirement)}</span></span>
                  <i data-lucide="${t.unlocked ? (p.selectedTitle === t.name ? 'check' : 'circle') : 'lock'}" class="w-5 h-5 ${p.selectedTitle === t.name ? 'text-orange-500' : 'text-stone-300'}"></i>
                </button>`).join('')}
            </div>
          </section>

          <section class="glass rounded-3xl p-5">
            <h2 class="font-bold tracking-tight flex items-center gap-2 text-stone-800"><i data-lucide="swords" class="w-4 h-4 text-orange-500"></i>Classe</h2>
            <p class="text-xs text-stone-400 mt-1">+10 % d'XP sur la compétence de ta classe.</p>
            <div class="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              ${classes.map((c) => { const m = SKILL_META[c.skill]; const on = p.chefClass === c.skill; return `
                <button data-set-class="${c.skill}" class="press rounded-2xl p-3 border text-left transition-all ${on ? 'border-transparent bg-gradient-to-br ' + m.grad + ' text-white' : 'border-stone-200 bg-stone-50'}">
                  <span class="text-2xl">${m.emoji}</span><span class="block font-extrabold text-sm mt-1 ${on ? 'text-white' : 'text-stone-800'}">${esc(c.name)}</span><span class="block text-[11px] ${on ? 'text-white/80' : 'text-stone-400'}">${m.name}</span>
                </button>`; }).join('')}
            </div>
          </section>

          <form id="acc-password" class="glass rounded-3xl p-5 space-y-4" novalidate>
            <h2 class="font-bold tracking-tight flex items-center gap-2 text-stone-800"><i data-lucide="key-round" class="w-4 h-4 text-cyan-600"></i>Sécurité</h2>
            <p class="text-xs text-stone-400 -mt-2">Connecté avec <b class="text-stone-600">${esc(p.email)}</b>. Changer le mot de passe déconnecte tes autres appareils.</p>
            ${field({ name: 'currentPassword', label: 'Mot de passe actuel', type: 'password', autocomplete: 'current-password' })}
            ${field({ name: 'newPassword', label: 'Nouveau mot de passe', type: 'password', autocomplete: 'new-password', extra: 'minlength="8"' })}
            <button type="submit" class="press w-full rounded-2xl py-3.5 font-bold bg-stone-100 border border-stone-200 text-stone-700 hover:bg-stone-200 transition-colors">Changer le mot de passe</button>
          </form>

          <button data-logout class="press w-full glass rounded-2xl py-4 font-bold flex items-center justify-center gap-2 text-stone-700"><i data-lucide="log-out" class="w-5 h-5 text-stone-500"></i>Se déconnecter</button>

          <form id="acc-delete" class="rounded-3xl p-5 border border-rose-200 bg-rose-50 space-y-3" novalidate>
            <h2 class="font-bold tracking-tight text-rose-700 flex items-center gap-2"><i data-lucide="triangle-alert" class="w-4 h-4"></i>Zone de danger</h2>
            <p class="text-xs text-rose-600/80">Supprime définitivement ton compte, ta progression et ton historique. <a href="/privacy" class="underline">Politique de confidentialité</a></p>
            ${field({ name: 'password', label: 'Confirme avec ton mot de passe', type: 'password', autocomplete: 'current-password' })}
            <button type="submit" class="press w-full rounded-2xl py-3.5 font-bold text-rose-100 bg-rose-600/80">Supprimer mon compte</button>
          </form>
        </div>
      </div>`;
    document.body.style.overflow = 'hidden';
    icons();

    const page = $('.page', root);
    bindAvatarEditor($('#acc-avatar'), draft, () => { $('#acc-avatar').innerHTML = avatarEditorHtml(draft); icons(); });

    const saveProfile = async (body, okMsg) => {
      const { user } = await api('/api/user/profile', { method: 'PATCH', body });
      state.user = user;
      await loadProfile();
      if (okMsg) toast(okMsg, { icon: 'check', tone: 'emerald' });
      return user;
    };

    $('#acc-profile').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget; const btn = $('button[type=submit]', form);
      const fd = Object.fromEntries(new FormData(form));
      btn.disabled = true;
      try {
        await saveProfile({ ...fd, avatar: draft.avatar, avatarColor: draft.avatarColor, avatarImage: draft.avatarImage || null }, 'Profil mis à jour');
        $$('[data-error]', form).forEach((x) => x.classList.add('hidden'));
      } catch (err) { showFieldError(form, err); } finally { btn.disabled = false; }
    });

    page.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close-page]')) { closePage(); return; }
      const t = e.target.closest('[data-title]');
      if (t && !t.disabled) {
        try { await saveProfile({ selectedTitle: t.dataset.title || null }, 'Titre mis à jour'); openAccount(); } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
        return;
      }
      const c = e.target.closest('[data-set-class]');
      if (c) {
        try { await saveProfile({ chefClass: c.dataset.setClass }, 'Classe changée'); haptic(); openAccount(); } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
        return;
      }
      if (e.target.closest('[data-logout]')) {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        state.user = null; state.profile = null;
        showAuth('login');
      }
    });

    $('#acc-password').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        await api('/api/user/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
        form.reset(); $$('[data-error]', form).forEach((x) => x.classList.add('hidden'));
        toast('Mot de passe modifié', { icon: 'shield-check', tone: 'emerald' });
      } catch (err) { showFieldError(form, err); }
    });

    $('#acc-delete').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (!window.confirm('Supprimer définitivement ton compte ? Cette action est irréversible.')) return;
      try {
        await api('/api/user', { method: 'DELETE', body: Object.fromEntries(new FormData(form)) });
        state.user = null; state.profile = null;
        showAuth('signup', 'Ton compte a été supprimé. À bientôt en cuisine !');
      } catch (err) { showFieldError(form, err); }
    });
  }

  function closePage() {
    const page = $('#page-root .page');
    if (!page) return;
    page.style.transition = 'transform .28s ease'; page.style.transform = 'translateX(100%)';
    setTimeout(() => { $('#page-root').innerHTML = ''; unlockScroll(); if (state.tab === 'profile' && state.profile) renderProfile(); }, 260);
  }

  // ===========================================================================
  // Onglet DAILIES
  // ===========================================================================
  function resetCountdown() {
    const now = new Date();
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    const mins = Math.floor((midnight - now) / 60000);
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }

  async function renderDailies() {
    if (!state.dailies) app.innerHTML = skeleton();
    try { state.dailies = await api('/api/dailies'); } catch { return; }
    if (state.tab !== 'dailies') return;
    const d = state.dailies;
    const C = 2 * Math.PI * 42;
    const pct = d.totalCount ? d.completedCount / d.totalCount : 0;

    app.innerHTML = `
      <section class="glass rise rounded-3xl p-5 sm:p-7 relative overflow-hidden">
        <div class="relative flex items-center gap-5">
          <div class="relative w-28 h-28 shrink-0">
            <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
              <defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs>
              <circle cx="50" cy="50" r="42" fill="none" stroke="#e7e5e4" stroke-width="9"/>
              <circle id="daily-ring" cx="50" cy="50" r="42" fill="none" stroke="url(#dg)" stroke-width="9" stroke-linecap="round"
                stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)"/>
            </svg>
            <div class="absolute inset-0 grid place-items-center text-center">
              <div><div id="daily-count" class="text-2xl font-extrabold tabular-nums text-stone-800">${d.completedCount}<span class="text-stone-400 text-base">/${d.totalCount}</span></div>
              <div class="text-[9px] uppercase tracking-widest text-stone-400 font-bold">faites</div></div>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[11px] uppercase tracking-[.2em] text-orange-500 font-semibold">Quêtes du jour</p>
            <h1 class="text-2xl font-extrabold tracking-tight mt-0.5 text-stone-900 font-display">Entraînement</h1>
            <p class="text-stone-400 text-sm mt-1 leading-snug">Garde ta série 🔥 en vie : chaque action compte.</p>
            <div class="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-orange-50 border border-orange-200 px-2.5 py-1 text-[11px] font-semibold text-orange-700">
              <i data-lucide="hourglass" class="w-3.5 h-3.5 text-orange-500"></i>Reset dans <span id="daily-reset" class="tabular-nums">${resetCountdown()}</span>
            </div>
          </div>
        </div>
      </section>
      <section class="mt-4 grid gap-2.5">${d.tasks.map((t, i) => dailyCard(t, i)).join('')}</section>`;

    icons();
    requestAnimationFrame(() => requestAnimationFrame(() => { const ring = $('#daily-ring'); if (ring) ring.style.strokeDashoffset = C * (1 - pct); }));
    updateDailyDot();
  }

  function dailyCard(t, i) {
    const m = SKILL_META[t.skill];
    return `
      <button data-daily="${t.id}" ${t.completed ? 'disabled' : ''}
        class="daily rise press w-full text-left glass rounded-2xl p-3.5 flex items-center gap-3 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md ${t.completed ? 'done opacity-60' : ''}" style="animation-delay:${0.04 * i}s">
        <div class="check shrink-0 w-10 h-10 rounded-full grid place-items-center border-2 transition-all duration-300 ${t.completed
          ? 'bg-gradient-to-br from-emerald-400 to-teal-500 border-transparent shadow-sm' : 'border-stone-300'}">
          <svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="${t.completed ? 'white' : '#a8a29e'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="check-path" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="title font-bold tracking-tight text-[15px] leading-tight text-stone-800 ${t.completed ? 'line-through decoration-2 decoration-emerald-400/70' : ''}">${esc(t.title)}</div>
          <div class="text-[13px] text-stone-400 leading-snug mt-0.5">${esc(t.description)}</div>
        </div>
        <div class="shrink-0 flex flex-col items-end gap-1">
          <span class="w-8 h-8 rounded-lg bg-gradient-to-br ${m.grad} grid place-items-center text-white shadow-sm"><i data-lucide="${esc(t.icon)}" class="w-4 h-4"></i></span>
          <span class="text-xs font-extrabold ${m.text} tabular-nums">+${t.xpReward}</span>
        </div>
      </button>`;
  }

  async function completeDaily(btn) {
    btn.disabled = true;
    haptic(15);
    const check = $('.check', btn);
    btn.classList.add('done');
    check.className = 'check shrink-0 w-10 h-10 rounded-full grid place-items-center border-2 border-transparent bg-gradient-to-br from-emerald-400 to-teal-500 shadow-[0_0_16px_rgba(52,211,153,.6)] burst transition-all duration-300';
    $('svg', check).setAttribute('stroke', '#022c22');
    $('.title', btn).classList.add('line-through', 'decoration-2', 'decoration-emerald-400/70');
    try {
      const result = await api(`/api/dailies/${btn.dataset.daily}/complete`, { method: 'POST' });
      const skill = Object.keys(result.rewards)[0];
      floatXp(check, `+${result.xpGained} XP`, SKILL_META[skill].hex);
      const r = btn.getBoundingClientRect();
      fx.burst({ x: (r.left + 30) / innerWidth, y: (r.top + r.height / 2) / innerHeight });
      setTimeout(() => btn.classList.add('opacity-60'), 500);
      await loadProfile();
      if (result.globalLevelUp || result.skillLevelUps.length) showRewardModal(result, 'daily');
      else if (result.streakIncreased) toast(`Série prolongée : ${result.streak} jour(s) 🔥`, { icon: 'flame', tone: 'amber' });
      await refreshDailiesSummary();
    } catch (err) {
      toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
      renderDailies();
    }
  }

  async function refreshDailiesSummary() {
    const d = await api('/api/dailies');
    state.dailies = d;
    const C = 2 * Math.PI * 42;
    const ring = $('#daily-ring');
    if (ring) ring.style.strokeDashoffset = C * (1 - d.completedCount / d.totalCount);
    const cnt = $('#daily-count');
    if (cnt) cnt.innerHTML = `${d.completedCount}<span class="text-stone-400 text-base">/${d.totalCount}</span>`;
    updateDailyDot();
    if (d.completedCount === d.totalCount) {
      setTimeout(() => { fx.fireworks(1500); toast('Toutes les dailies sont complétées ! Légendaire.', { icon: 'trophy', tone: 'emerald' }); }, 400);
    }
  }

  // ===========================================================================
  // Onglet RECETTES / QUÊTES
  // ===========================================================================
  const activeFilterCount = () => (state.recipes.skill ? 1 : 0) + (state.recipes.sort !== 'featured' ? 1 : 0);

  function catChips() {
    const s = state.recipes;
    const chip = (active, cat, label, count) => `<button data-cat="${esc(cat)}"
      class="press shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-semibold border transition-all duration-300 ${active
        ? 'bg-orange-500 border-transparent text-white shadow-[0_2px_8px_rgba(249,115,22,.3)]'
        : 'bg-white border-stone-200 text-stone-600 hover:border-orange-300 hover:text-orange-600'}">${label}${count !== undefined ? ` <span class="opacity-60 text-xs">${count}</span>` : ''}</button>`;
    return chip(s.category === 'all', 'all', '✨ Toutes')
      + state.categories.map((c) => chip(s.category === c.name, c.name, `${CATEGORY_ICON[c.name] || '🍽️'} ${esc(c.name)}`, c.count)).join('');
  }

  function renderRecipes() {
    if (state.recipesSubTab === 'quests') { renderRecipesCatalogHeader(); renderQuestsSub(); return; }
    if (state.recipesSubTab === 'myrecipes') { renderMyRecipesHeader(); renderMyRecipesSub(); return; }
    const s = state.recipes;
    const n = activeFilterCount();
    app.innerHTML = `
      <section class="rise">
        <p class="text-[11px] uppercase tracking-[.2em] text-orange-500 font-semibold">Catalogue de recettes</p>
        <div class="flex items-end justify-between gap-3 mt-0.5">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900 font-display">Que cuisines-tu ?</h1>
          <span id="recipe-total" class="text-xs text-stone-400 font-semibold whitespace-nowrap pb-1"></span>
        </div>
        ${recipesSubTabHtml()}
      </section>

      <div class="sticky z-30 -mx-4 px-4 sm:mx-0 sm:px-0 pt-3 pb-2 bg-gradient-to-b from-stone-50 via-stone-50/95 to-stone-50/0" style="top: calc(max(.75rem, env(safe-area-inset-top)) + 4.5rem)">
        <div class="flex gap-2">
          <div class="relative flex-1 min-w-0">
            <i data-lucide="search" class="pointer-events-none absolute z-10 left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-400"></i>
            <input id="recipe-search" type="search" enterkeyhint="search" autocomplete="off" placeholder="Recette, ingrédient…" value="${esc(s.search)}"
              class="w-full bg-white border border-stone-200 rounded-2xl pl-12 pr-4 py-3.5 text-base text-stone-800 placeholder:text-stone-400 outline-none transition-all duration-300 focus:border-orange-400 focus:shadow-[0_0_0_4px_rgba(249,115,22,.1)] shadow-sm">
          </div>
          <button data-open="filters" class="press relative shrink-0 w-[52px] rounded-2xl bg-white border border-stone-200 shadow-sm grid place-items-center text-stone-500 hover:bg-stone-50 transition-colors" aria-label="Filtres">
            <i data-lucide="sliders-horizontal" class="w-5 h-5"></i>
            ${n ? `<span class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-orange-500 text-white text-[11px] font-black grid place-items-center">${n}</span>` : ''}
          </button>
        </div>
        <div class="flex gap-2 overflow-x-auto no-scrollbar mt-2.5 -mx-4 px-4 sm:mx-0 sm:px-0" id="cat-chips">${catChips()}</div>
      </div>

      <section id="recipe-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 mt-2"></section>
      <div id="recipe-sentinel" class="h-10"></div>
      <div id="recipe-more" class="flex justify-center mt-1"></div>`;

    icons();
    if (!state.categories.length) {
      api('/api/recipes/categories').then((c) => { state.categories = c; const chips = $('#cat-chips'); if (chips) chips.innerHTML = catChips(); }).catch(() => {});
    }
    if (s.items.length) {
      $('#recipe-grid').innerHTML = s.items.map((r) => recipeCard(r)).join('');
      updateRecipeFooter(); icons();
    } else {
      loadRecipes(true);
    }
    observeSentinel();
    const input = $('#recipe-search');
    input.addEventListener('input', (e) => onSearch(e.target.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  }

  function renderMyRecipesHeader() {
    app.innerHTML = `
      <section class="rise">
        <p class="text-[11px] uppercase tracking-[.2em] text-orange-500 font-semibold">Mes recettes personnelles</p>
        <div class="flex items-end justify-between gap-3 mt-0.5 mb-1">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900 font-display">Mes Recettes</h1>
        </div>
        ${recipesSubTabHtml()}
      </section>
      <div id="myrecipes-sub" class="mt-2"></div>`;
    icons();
  }

  function renderRecipesCatalogHeader() {
    const n = activeFilterCount();
    const s = state.recipes;
    app.innerHTML = `
      <section class="rise">
        <p class="text-[11px] uppercase tracking-[.2em] text-orange-500 font-semibold">Mes quêtes personnalisées</p>
        <div class="flex items-end justify-between gap-3 mt-0.5 mb-1">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-stone-900 font-display">Mes Quêtes</h1>
        </div>
        ${recipesSubTabHtml()}
      </section>
      <div id="quests-sub" class="mt-2"></div>`;
    icons();
  }

  function recipeCard(r, i = 0) {
    const rank = RANKS[r.difficulty] || RANKS[3];
    const skills = Object.entries(r.skillRewards).sort((a, b) => b[1] - a[1]);
    return `
      <article class="recipe-card rise group glass rounded-3xl overflow-hidden flex flex-col press cursor-pointer" data-recipe="${r.id}" style="animation-delay:${Math.min(i, 8) * 0.035}s">
        <div class="relative">
          ${recipeVisual(r)}
          <span class="absolute top-2 right-2 w-8 h-8 rounded-xl bg-gradient-to-br ${rank.cls} grid place-items-center text-sm font-black shadow-md" title="Rang de difficulté">${rank.label}</span>
          ${r.cookedCount ? `<span class="absolute top-2 left-2 inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold bg-white/90 backdrop-blur-sm text-emerald-700 border border-emerald-200"><i data-lucide="check" class="w-3 h-3"></i>${r.cookedCount}</span>` : ''}
          <span class="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold bg-white/90 backdrop-blur-sm text-stone-700"><i data-lucide="clock" class="w-3 h-3 text-orange-500"></i>${r.timeMinutes >= 90 ? `${Math.floor(r.timeMinutes / 60)}h${String(r.timeMinutes % 60).padStart(2, '0')}` : `${r.timeMinutes} min`}</span>
        </div>
        <div class="p-3 pt-2.5 flex flex-col gap-2 flex-1">
          <h3 class="text-[14px] sm:text-[15px] font-bold tracking-tight leading-snug line-clamp-2 text-stone-800">${esc(r.name)}</h3>
          <div class="mt-auto flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex -space-x-1">${skills.slice(0, 4).map(([k]) => `<span class="w-5 h-5 rounded-full bg-gradient-to-br ${SKILL_META[k].grad} ring-2 ring-white grid place-items-center text-[10px]">${SKILL_META[k].emoji}</span>`).join('')}</div>
              <div class="text-xs mt-1"><span class="font-extrabold text-orange-500 tabular-nums">${fmt(r.totalXp)}</span> <span class="text-stone-400 font-semibold">XP</span></div>
            </div>
            <button data-cook="${r.id}" class="cook-btn press shrink-0 w-11 h-11 rounded-2xl grid place-items-center text-white bg-orange-500 shadow-[0_2px_12px_rgba(249,115,22,.4)] hover:bg-orange-600 transition-colors disabled:opacity-60" aria-label="Cuisiner ${esc(r.name)}">
              <i data-lucide="chef-hat" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
      </article>`;
  }

  async function loadRecipes(reset = false) {
    const s = state.recipes;
    if (s.loading && !reset) return;
    if (!reset && s.page >= s.totalPages) return;
    const reqId = ++s.reqId;
    s.loading = true;
    if (reset) {
      s.page = 0; s.items = [];
      const grid = $('#recipe-grid');
      if (grid) grid.innerHTML = Array.from({ length: 6 }, () => '<div class="rounded-3xl aspect-[3/4] skeleton"></div>').join('');
    }
    const params = new URLSearchParams({ page: s.page + 1, limit: 24, search: s.search });
    if (s.category !== 'all') params.set('category', s.category);
    if (s.skill) params.set('skill', s.skill);
    if (s.sort !== 'featured') params.set('sort', s.sort);
    updateRecipeFooter(true);
    try {
      const data = await api(`/api/recipes?${params}`);
      if (reqId !== s.reqId) return;
      s.page = data.page; s.totalPages = data.totalPages; s.total = data.total;
      s.items.push(...data.items);
      const g = $('#recipe-grid');
      if (!g) return;
      if (reset) g.innerHTML = '';
      g.insertAdjacentHTML('beforeend', data.items.map((r, i) => recipeCard(r, i)).join(''));
      if (!s.items.length) g.innerHTML = `<div class="col-span-full">${emptyState('search-x', 'Aucune quête trouvée', 'Essaie un autre mot-clé ou retire un filtre.')}</div>`;
      icons();
    } catch (err) {
      if (reqId === s.reqId) toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
    } finally {
      if (reqId === s.reqId) { s.loading = false; updateRecipeFooter(); }
    }
  }

  function updateRecipeFooter(loading = false) {
    const s = state.recipes;
    const total = $('#recipe-total');
    if (total) total.textContent = `${fmt(s.total)} quêtes`;
    const more = $('#recipe-more');
    if (!more) return;
    if (loading && s.items.length) more.innerHTML = '<div class="flex items-center gap-2 text-stone-400 text-sm font-semibold"><i data-lucide="loader-circle" class="w-4 h-4 animate-spin text-orange-400"></i>Chargement…</div>';
    else if (s.page < s.totalPages && s.items.length) more.innerHTML = '<button id="load-more" class="press glass rounded-xl px-5 py-3 text-sm font-bold text-stone-700 hover:bg-stone-100 transition-colors">Charger plus de quêtes</button>';
    else if (s.items.length) more.innerHTML = '<p class="text-[11px] text-stone-400 font-bold uppercase tracking-widest">— Fin du tableau —</p>';
    else more.innerHTML = '';
    icons();
  }

  let sentinelObserver;
  function observeSentinel() {
    if (sentinelObserver) sentinelObserver.disconnect();
    const el = $('#recipe-sentinel');
    if (!el || !('IntersectionObserver' in window)) return;
    sentinelObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.recipes.items.length) loadRecipes();
    }, { rootMargin: '800px' });
    sentinelObserver.observe(el);
  }

  let searchTimer;
  function onSearch(value) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.recipes.search = value.trim(); loadRecipes(true); }, 250);
  }

  function resetRecipesAndRender() {
    state.recipes.search = $('#recipe-search')?.value.trim() || state.recipes.search;
    state.recipes.items = [];
    renderRecipes();
  }

  // Filtres (bottom sheet)
  function openFilters() {
    const s = state.recipes;
    const draft = { skill: s.skill, sort: s.sort };
    const render = () => `
      <div class="px-5 pb-5">
        <h2 class="text-xl font-extrabold tracking-tight text-stone-800">Filtres</h2>
        <h3 class="mt-4 text-xs font-bold uppercase tracking-widest text-stone-400">Compétence principale</h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
          ${SKILLS.map((k) => { const m = SKILL_META[k]; const on = draft.skill === k; return `
            <button data-f-skill="${k}" class="press flex items-center gap-2 rounded-2xl px-3 py-3 border font-bold text-sm ${on ? `border-transparent bg-gradient-to-r ${m.grad} text-white` : 'border-stone-200 bg-stone-50 text-stone-700'}">${m.emoji} ${m.name}</button>`; }).join('')}
        </div>
        <h3 class="mt-5 text-xs font-bold uppercase tracking-widest text-stone-400">Trier par</h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
          ${SORTS.map(([v, l]) => `<button data-f-sort="${v}" class="press rounded-2xl px-3 py-3 border font-bold text-sm ${draft.sort === v ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-stone-200 bg-stone-50 text-stone-700'}">${l}</button>`).join('')}
        </div>
        <div class="mt-6 grid grid-cols-3 gap-2">
          <button data-f-reset class="press rounded-2xl py-4 font-bold bg-stone-100 border border-stone-200 text-stone-700">Réinitialiser</button>
          <button data-f-apply class="${primaryBtn} col-span-2">Appliquer</button>
        </div>
      </div>`;
    const sheet = openSheet(render());
    sheet.addEventListener('click', (e) => {
      const sk = e.target.closest('[data-f-skill]');
      const so = e.target.closest('[data-f-sort]');
      if (sk) { draft.skill = draft.skill === sk.dataset.fSkill ? '' : sk.dataset.fSkill; haptic(); }
      if (so) { draft.sort = so.dataset.fSort; haptic(); }
      if (e.target.closest('[data-f-reset]')) { draft.skill = ''; draft.sort = 'featured'; }
      if (sk || so || e.target.closest('[data-f-reset]')) { $('.sheet-body', sheet).innerHTML = render(); return; }
      if (e.target.closest('[data-f-apply]')) {
        s.skill = draft.skill; s.sort = draft.sort;
        closeSheet(); resetRecipesAndRender();
      }
    });
  }

  // Détail d'une recette (bottom sheet)
  async function openRecipe(id) {
    let r;
    try { r = await api(`/api/recipes/${id}`); } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); return; }
    const rank = RANKS[r.difficulty] || RANKS[3];
    const steps = r.instructions.split(/\r?\n/).map((l) => l.replace(/^\s*(step\s*)?\d+[.):]?\s*/i, '').trim()).filter(Boolean);
    const sheet = openSheet(`
      <div class="relative -mt-8">
        ${recipeVisual(r, { cls: 'h-64 sm:h-72', emojiSize: 'text-8xl', w: 960 })}
        <div class="absolute bottom-4 left-5 right-5">
          <div class="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/90">
            <span class="w-6 h-6 rounded-lg bg-gradient-to-br ${rank.cls} grid place-items-center text-[11px] font-black">${rank.label}</span>
            ${esc(r.category)} · ${r.timeMinutes} min
          </div>
          <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1.5 drop-shadow">${esc(r.name)}</h2>
        </div>
      </div>
      <div class="p-5 space-y-6">
        <div>
          <p class="text-stone-500 text-sm">${esc(r.description)}</p>
          ${r.imageSource ? `<a href="${esc(r.imageSource)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-stone-400 underline decoration-dotted"><i data-lucide="camera" class="w-3 h-3"></i>Photo : Wikipédia / Wikimedia Commons</a>` : ''}
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-stone-400 mb-2">Récompenses</h3>
          <div class="flex flex-wrap gap-2">${Object.entries(r.skillRewards).map(([k, v]) => skillPill(k, v, 'md')).join('')}</div>
          ${r.cookedCount ? `<p class="text-xs text-amber-600 mt-2 font-semibold">Déjà cuisinée ${r.cookedCount}× — XP réduite à ${Math.round(Math.max(0.4, 1 - r.cookedCount * 0.2) * 100)} %.</p>` : ''}
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-stone-400 mb-2">Ingrédients · ${r.ingredients.length}</h3>
          <ul class="rounded-2xl bg-stone-50 border border-stone-200 divide-y divide-stone-200">${r.ingredients.map((g) => `
            <li class="flex justify-between gap-3 px-4 py-2.5 text-sm"><span class="text-stone-800">${esc(g.name)}</span><span class="text-stone-400 text-right font-semibold">${esc(g.measure)}</span></li>`).join('')}</ul>
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-stone-400 mb-2">Étapes</h3>
          <ol class="space-y-3">${steps.map((st, i) => `
            <li class="flex gap-3"><span class="shrink-0 w-7 h-7 rounded-lg bg-orange-100 text-orange-600 text-xs font-extrabold grid place-items-center">${i + 1}</span><span class="text-[15px] text-stone-700 leading-relaxed pt-0.5">${esc(st)}</span></li>`).join('')}</ol>
        </div>
      </div>
      <div class="sticky bottom-0 p-4 pb-safe bg-gradient-to-t from-white via-white/95 to-transparent">
        <button data-cook="${r.id}" class="cook-btn ${primaryBtn}"><i data-lucide="chef-hat" class="w-5 h-5"></i>J'ai cuisiné cette recette !</button>
      </div>`, { flush: true });
    sheet.addEventListener('click', (e) => { const c = e.target.closest('[data-cook]'); if (c) { closeSheet(); startCookingSession(c.dataset.cook); } });
  }

  async function cookRecipe(btn) {
    const id = btn.dataset.cook;
    btn.disabled = true;
    haptic(20);
    const original = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-5 h-5 animate-spin"></i>';
    icons();
    try {
      const result = await api(`/api/recipes/${id}/cook`, { method: 'POST' });
      floatXp(btn, `+${result.xpGained} XP`);
      if (result.gems !== undefined && state.profile) { state.profile.gems = result.gems; const g = $('#hdr-gems-count'); if (g) g.textContent = fmt(result.gems); }
      await loadProfile();
      const item = state.recipes.items.find((r) => String(r.id) === String(id));
      if (item) {
        item.cookedCount += 1;
        const card = $(`.recipe-card[data-recipe="${id}"]`);
        if (card) { card.outerHTML = recipeCard(item); icons(); }
      }
      closeSheet();
      showRewardModal(result, 'recipe');
    } catch (err) {
      toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = original; icons(); }
    }
  }

  // ===========================================================================
  // Bottom sheet (glisser vers le bas pour fermer) & modale
  // ===========================================================================
  function lockScroll() { document.body.style.overflow = 'hidden'; }
  function unlockScroll() { if (!$('#page-root').innerHTML && !$('#sheet-root').innerHTML && !$('#modal-root').innerHTML) document.body.style.overflow = ''; }

  function openSheet(html, { flush = false } = {}) {
    closeSheet(true);
    const root = $('#sheet-root');
    root.innerHTML = `
      <div class="sheet-overlay fixed inset-0 z-[80] bg-stone-900/40 backdrop-blur-sm fade-in"></div>
      <div class="sheet fixed z-[81] inset-x-0 bottom-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[640px] max-h-[92dvh] sm:max-h-[86vh] flex flex-col glass-strong rounded-t-[28px] sm:rounded-[28px] shadow-2xl sheet-up overflow-hidden">
        <div class="sheet-handle relative z-20 shrink-0 flex justify-center pt-3 pb-2 cursor-grab ${flush ? '' : ''}"><span class="w-11 h-1.5 rounded-full bg-stone-300"></span></div>
        <button data-close-sheet class="press absolute z-20 top-3 right-3 w-9 h-9 rounded-full bg-stone-100 border border-stone-200 grid place-items-center hover:bg-stone-200 transition-colors" aria-label="Fermer"><i data-lucide="x" class="w-4 h-4 text-stone-500"></i></button>
        <div class="sheet-body overflow-y-auto overscroll-contain">${html}</div>
      </div>`;
    lockScroll();
    icons();
    const sheet = $('.sheet', root);
    const body = $('.sheet-body', sheet);
    $('.sheet-overlay', root).addEventListener('click', () => closeSheet());
    sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close-sheet]')) closeSheet(); });

    // Glisser pour fermer (mobile)
    let startY = null; let dy = 0;
    sheet.addEventListener('touchstart', (e) => {
      if (window.innerWidth >= 640) return;
      if (body.scrollTop > 0 && !e.target.closest('.sheet-handle')) return;
      startY = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      if (startY === null) return;
      startY = null;
      sheet.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)';
      if (dy > 110) closeSheet(); else sheet.style.transform = '';
    });
    return sheet;
  }

  function closeSheet(instant = false) {
    const root = $('#sheet-root');
    const sheet = $('.sheet', root);
    if (!sheet) return;
    if (instant) { root.innerHTML = ''; unlockScroll(); return; }
    sheet.style.transition = 'transform .28s ease, opacity .28s ease';
    sheet.style.transform = window.innerWidth >= 640 ? 'translate(-50%, -45%)' : 'translateY(100%)';
    sheet.style.opacity = window.innerWidth >= 640 ? '0' : '1';
    $('.sheet-overlay', root).style.opacity = '0';
    setTimeout(() => { root.innerHTML = ''; unlockScroll(); }, 260);
  }

  function openModal(html, { onClose } = {}) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal fixed inset-0 z-[90] overflow-y-auto bg-stone-900/50 backdrop-blur-sm fade-in"><div class="flex min-h-full items-center justify-center p-4 py-8">${html}</div></div>`;
    const overlay = $('.modal', root);
    overlay._onClose = onClose;
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) closeModal(); });
    lockScroll();
    icons();
  }

  function closeModal() {
    const overlay = $('#modal-root .modal');
    if (!overlay) return;
    const cb = overlay._onClose;
    $('#modal-root').innerHTML = '';
    unlockScroll();
    if (cb) cb();
  }

  function closeAll() {
    $('#page-root').innerHTML = ''; $('#sheet-root').innerHTML = ''; $('#modal-root').innerHTML = '';
    document.body.style.overflow = '';
  }

  // ===========================================================================
  // Modale de récompense
  // ===========================================================================
  function showRewardModal(result, kind) {
    const p = state.profile;
    const lvlUp = result.globalLevelUp;
    const skillUps = Object.fromEntries(result.skillLevelUps.map((u) => [u.skill, u]));
    const isEpic = !!lvlUp || result.skillLevelUps.length > 0;
    const heading = lvlUp ? 'LEVEL UP !' : result.skillLevelUps.length ? 'COMPÉTENCE UP !' : (kind === 'recipe' ? 'QUÊTE ACCOMPLIE !' : 'DAILY VALIDÉE !');
    const hero = result.recipe?.imageUrl
      ? `<img src="${esc(thumb(result.recipe.imageUrl, 330))}" class="w-full h-full object-cover" alt="" onerror="this.remove()">`
      : (result.recipe?.emoji || '⚡');

    openModal(`
      <div class="modal-in w-full max-w-md rounded-[28px] my-auto">
        <div class="glass-strong rounded-[28px] p-6 text-center relative overflow-hidden">
          <div class="absolute inset-x-0 -top-24 h-56 bg-gradient-to-b ${lvlUp ? 'from-amber-300/20' : 'from-orange-400/15'} to-transparent blur-2xl pointer-events-none"></div>
          <div class="relative">
            <div class="pop mx-auto w-24 h-24 rounded-3xl overflow-hidden grid place-items-center text-5xl bg-gradient-to-br ${lvlUp ? 'from-amber-300 to-orange-500' : 'from-orange-400 to-orange-600'} shadow-[0_4px_24px_rgba(249,115,22,.4)] ring-4 ring-white">${hero}</div>
            <p class="mt-5 text-[11px] font-bold uppercase tracking-[.25em] ${lvlUp ? 'text-amber-600' : 'text-orange-500'} line-clamp-1">${esc(kind === 'recipe' ? result.recipe?.name : result.task?.title)}</p>
            <h2 class="pop mt-1 ${heading.length > 12 ? 'text-[30px]' : 'text-4xl'} sm:text-5xl whitespace-nowrap font-black tracking-tight bg-gradient-to-r ${lvlUp ? 'from-amber-500 via-yellow-500 to-orange-500' : 'from-orange-500 via-orange-400 to-amber-500'} bg-clip-text text-transparent" style="animation-delay:.1s">${heading}</h2>
            ${lvlUp ? `
              <div class="pop mt-3 flex items-center justify-center gap-3" style="animation-delay:.25s">
                <span class="text-2xl font-extrabold text-stone-400">${lvlUp.from}</span><i data-lucide="chevrons-right" class="w-6 h-6 text-amber-500"></i>
                <span class="text-5xl font-black text-amber-500">${lvlUp.to}</span>
              </div>
              ${lvlUp.newTitle ? `<p class="mt-1 text-sm font-semibold text-amber-600">Nouveau titre débloqué : ${esc(lvlUp.newTitle)}</p>` : ''}` : ''}
            <div class="mt-4 text-5xl font-black tabular-nums text-stone-800">+<span id="xp-count">0</span> <span class="text-2xl text-orange-500">XP</span></div>
            ${result.gemsEarned ? `<div class="mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 bg-cyan-50 border border-cyan-200"><span class="text-base">💎</span><span class="text-sm font-extrabold text-cyan-700">+${result.gemsEarned} gemmes</span></div>` : ''}
            ${result.classBonus ? `<p class="text-xs text-amber-600 mt-1 font-bold">Bonus de classe ${SKILL_META[result.classBonus.skill].emoji} +${result.classBonus.xp} XP</p>` : ''}
            ${result.multiplier && result.multiplier < 1 ? `<p class="text-xs text-stone-400 mt-1 font-semibold">Recette déjà maîtrisée · XP ×${result.multiplier.toFixed(1)}</p>` : ''}
            <div class="mt-5 space-y-2.5 text-left">
              ${Object.entries(result.rewards).map(([k, v], i) => {
                const m = SKILL_META[k]; const sp = p.skills.find((s) => s.skill === k); const up = skillUps[k];
                return `<div class="rise rounded-2xl bg-stone-50 border ${up ? 'border-amber-300' : 'border-stone-200'} p-3" style="animation-delay:${0.3 + i * 0.08}s">
                  <div class="flex items-center gap-2.5 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-gradient-to-br ${m.grad} grid place-items-center text-white"><i data-lucide="${m.icon}" class="w-4 h-4"></i></span>
                    <span class="flex-1 min-w-0 font-bold text-sm truncate text-stone-800">${m.name} <span class="text-stone-400 font-semibold">· ${sp.level}</span></span>
                    ${up ? '<span class="rounded-full px-2 py-0.5 text-[10px] font-black bg-gradient-to-r from-amber-300 to-orange-500 text-white shadow-sm">UP !</span>' : ''}
                    <span class="text-sm font-extrabold ${m.text} tabular-nums">+${v}</span>
                  </div>
                  ${glowBar(sp.percent, m.grad, m.glow, 'h-2')}
                </div>`;
              }).join('')}
            </div>
            ${result.streakIncreased ? `<div class="rise mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-orange-50 border border-orange-200 text-sm font-bold text-orange-700" style="animation-delay:.6s"><span class="flame">🔥</span>Série : ${result.streak} jour${result.streak > 1 ? 's' : ''} !</div>` : ''}
            <button data-close class="press mt-6 w-full rounded-2xl py-4 font-extrabold text-white bg-gradient-to-r ${lvlUp ? 'from-amber-400 to-orange-500 shadow-[0_4px_20px_rgba(251,146,60,.4)]' : 'from-orange-500 to-orange-600 shadow-[0_4px_20px_rgba(249,115,22,.35)]'}">Continuer l'aventure</button>
          </div>
        </div>
      </div>`, { onClose: () => { if (state.tab === 'profile') renderProfile(); } });

    countUp($('#xp-count'), result.xpGained);
    animateBars($('#modal-root'));
    haptic(isEpic ? [30, 40, 30] : 20);
    if (isEpic) fx.fireworks(lvlUp ? 3000 : 1800); else fx.burst();
  }

  // ===========================================================================
  // Mode Cuisiner (session interactive pas-à-pas)
  // ===========================================================================
  async function startCookingSession(recipeId) {
    let r;
    try { r = await api(`/api/recipes/${recipeId}`); }
    catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); return; }

    const steps = r.instructions.split(/\r?\n/).map((l) => l.replace(/^\s*(step\s*)?\d+[.):]?\s*/i, '').trim()).filter(Boolean);
    const state_ = { phase: 'ingredients', step: 0, startMs: null, elapsed: 0, timerHandle: null };

    const fmtTime = (ms) => {
      const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
      return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };

    const renderBody = () => {
      const rank = RANKS[r.difficulty] || RANKS[3];
      if (state_.phase === 'ingredients') {
        return `
          <div class="p-5 pb-2">
            <p class="text-xs uppercase tracking-widest font-bold text-orange-500 mb-1">Mode Cuisiner</p>
            <h2 class="text-2xl font-extrabold tracking-tight text-stone-800 mb-1">${esc(r.name)}</h2>
            <div class="flex items-center gap-2 text-xs text-stone-400 font-semibold mb-5">
              <span class="w-5 h-5 rounded bg-gradient-to-br ${rank.cls} grid place-items-center text-[10px] font-black">${rank.label}</span>
              ${esc(r.category)} · ${r.timeMinutes} min · ${steps.length} étapes
            </div>
            <h3 class="text-xs uppercase tracking-widest font-bold text-stone-400 mb-3">Ingrédients · ${r.ingredients.length}</h3>
            <ul class="rounded-2xl bg-stone-50 border border-stone-200 divide-y divide-stone-200 mb-6">
              ${r.ingredients.map((g) => `<li class="flex justify-between gap-3 px-4 py-2.5 text-sm"><span class="text-stone-800">${esc(g.name)}</span><span class="text-stone-400 font-semibold">${esc(g.measure)}</span></li>`).join('')}
            </ul>
          </div>
          <div class="sticky bottom-0 p-4 pb-safe bg-gradient-to-t from-white via-white/95 to-transparent">
            <button id="cs-start" class="${primaryBtn}"><i data-lucide="play" class="w-5 h-5"></i>Commencer les étapes</button>
          </div>`;
      }
      const isLast = state_.step >= steps.length - 1;
      return `
        <div class="p-5 pb-2">
          <div class="flex items-center justify-between mb-5">
            <span class="text-xs uppercase tracking-widest font-bold text-orange-500">Étape ${state_.step + 1} / ${steps.length}</span>
            <div id="cs-timer" class="tabular-nums font-extrabold text-stone-800 text-lg">${fmtTime(state_.elapsed)}</div>
          </div>
          <div class="w-full bg-stone-100 rounded-full h-1.5 mb-6 overflow-hidden">
            <div class="h-full bg-orange-500 rounded-full transition-all duration-500" style="width:${Math.round(((state_.step) / steps.length) * 100)}%"></div>
          </div>
          <div class="glass rounded-2xl p-5 mb-4 min-h-[120px] flex items-center">
            <p class="text-[17px] text-stone-800 leading-relaxed font-medium">${esc(steps[state_.step])}</p>
          </div>
          ${state_.step > 0 ? `<p class="text-xs text-stone-400 font-semibold line-clamp-1 mb-4 pl-1">← ${esc(steps[state_.step - 1])}</p>` : ''}
        </div>
        <div class="sticky bottom-0 p-4 pb-safe bg-gradient-to-t from-white via-white/95 to-transparent">
          ${isLast
            ? `<button id="cs-finish" class="${primaryBtn}"><i data-lucide="check-circle" class="w-5 h-5"></i>Valider la session !</button>`
            : `<button id="cs-next" class="${primaryBtn}">Étape suivante<i data-lucide="chevron-right" class="w-5 h-5"></i></button>`}
        </div>`;
    };

    const sheet = openSheet(renderBody(), { flush: false });
    const refresh = () => { $('.sheet-body', sheet).innerHTML = renderBody(); icons(); };

    sheet.addEventListener('click', async (e) => {
      if (e.target.closest('#cs-start')) {
        state_.phase = 'steps'; state_.step = 0;
        state_.startMs = Date.now() - state_.elapsed;
        state_.timerHandle = setInterval(() => {
          state_.elapsed = Date.now() - state_.startMs;
          const t = $('#cs-timer');
          if (t) t.textContent = fmtTime(state_.elapsed);
        }, 1000);
        haptic(); refresh(); return;
      }
      if (e.target.closest('#cs-next')) {
        state_.step++; haptic(); refresh(); return;
      }
      if (e.target.closest('#cs-finish')) {
        clearInterval(state_.timerHandle);
        closeSheet();
        const btn = document.createElement('button');
        btn.dataset.cook = recipeId;
        await cookRecipe(btn);
      }
    });

    sheet.addEventListener('close-sheet-custom', () => clearInterval(state_.timerHandle));
  }

  // ===========================================================================
  // Onglet CLASSEMENT RANKED
  // ===========================================================================
  async function renderRanked() {
    app.innerHTML = skeleton();
    try {
      const data = state.ranked = await api('/api/ranked');
      const me = data.me;
      const myL = data.myLeague;
      const nextL = LEAGUES[myL.idx + 1] || null;

      app.innerHTML = `
        <section class="rise">
          ${sectionTitle('trophy', 'Classement Ranked', `Saison ${data.season.number} · ${data.season.name}`)}

          <div class="glass-strong rounded-3xl p-5 sm:p-7 mb-5 relative overflow-hidden">
            <div class="absolute inset-x-0 -top-20 h-40 blur-3xl opacity-20 pointer-events-none" style="background:radial-gradient(circle,${myL.hex},transparent 70%)"></div>
            <div class="relative flex flex-col sm:flex-row items-center gap-5">
              <div class="text-6xl sm:text-7xl">${myL.emoji}</div>
              <div class="flex-1 text-center sm:text-left">
                <p class="text-xs uppercase tracking-widest font-bold text-stone-400">Ta ligue</p>
                <h2 class="text-3xl font-black tracking-tight" style="color:${myL.hex}">${myL.name}</h2>
                <p class="text-sm text-stone-500 font-semibold">${fmt(me.totalXp)} XP · Rang #${me.rank}</p>
                ${nextL ? `<div class="mt-3">
                  <div class="flex justify-between text-xs font-semibold text-stone-400 mb-1">
                    <span>${myL.name}</span><span>${nextL.emoji} ${nextL.name} dans ${fmt(myL.xpToNext)} XP</span>
                  </div>
                  ${glowBar(myL.progress, 'from-orange-400 to-amber-400', 'rgba(249,115,22,.4)', 'h-2.5')}
                </div>` : `<p class="mt-2 text-sm font-bold text-orange-500">Ligue maximale atteinte 🚀</p>`}
              </div>
            </div>
          </div>

          <div class="glass rounded-3xl overflow-hidden">
            <div class="p-4 border-b border-stone-100 flex items-center justify-between">
              <span class="font-bold text-stone-800">Top joueurs</span>
              <span class="text-xs text-stone-400 font-semibold">${data.leaderboard.length} joueurs</span>
            </div>
            <div class="divide-y divide-stone-100">
              ${data.leaderboard.slice(0, 20).map((p) => {
                const l = p.league;
                const isMe = p.id === me.id;
                return `<div class="flex items-center gap-3 px-4 py-3 ${isMe ? 'bg-orange-50' : 'hover:bg-stone-50'} transition-colors">
                  <div class="w-7 text-center font-extrabold text-${p.rank <= 3 ? 'amber-500' : 'stone-400'} tabular-nums text-sm">${p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : `#${p.rank}`}</div>
                  <div class="w-9 h-9 rounded-full overflow-hidden bg-gradient-to-br ${p.avatarColor === 'violet' ? 'from-violet-500 to-fuchsia-500' : p.avatarColor === 'emerald' ? 'from-emerald-400 to-teal-600' : p.avatarColor === 'amber' ? 'from-amber-400 to-orange-600' : p.avatarColor === 'cyan' ? 'from-cyan-400 to-blue-600' : p.avatarColor === 'pink' ? 'from-pink-400 to-rose-600' : 'from-slate-500 to-slate-800'} grid place-items-center text-sm shrink-0">
                    ${p.avatarImage ? `<img src="${esc(p.avatarImage)}" class="w-full h-full object-cover">` : esc(p.avatar || '🧑‍🍳')}
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm truncate ${isMe ? 'text-orange-700' : 'text-stone-800'}">${esc(p.displayName)}${isMe ? ' (moi)' : ''}</p>
                    <p class="text-xs text-stone-400 font-semibold">Niv. ${p.level} · ${fmt(p.totalXp)} XP</p>
                  </div>
                  <span class="text-xl" title="${l.name}">${l.emoji}</span>
                </div>`;
              }).join('')}
              ${me.rank > 20 ? `
                <div class="flex items-center gap-3 px-4 py-3 bg-orange-50 border-t-2 border-orange-200">
                  <div class="w-7 text-center font-extrabold text-stone-500 tabular-nums text-sm">#${me.rank}</div>
                  <div class="flex-1 min-w-0"><p class="font-bold text-sm text-orange-700">${esc(me.displayName)} (moi)</p><p class="text-xs text-stone-400 font-semibold">Niv. ${me.level} · ${fmt(me.totalXp)} XP</p></div>
                  <span class="text-xl">${myL.emoji}</span>
                </div>` : ''}
            </div>
          </div>

          <div class="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${data.leagues.map((l) => {
              const active = myL.id === l.id;
              return `<div class="glass rounded-2xl p-3 text-center ${active ? 'ring-2' : ''}" style="${active ? `--tw-ring-color:${l.hex}55` : ''}">
                <div class="text-2xl">${l.emoji}</div>
                <div class="text-xs font-extrabold mt-1 ${active ? 'font-black' : 'text-stone-600'}" style="${active ? `color:${l.hex}` : ''}">${l.name}</div>
                <div class="text-[10px] text-stone-400 font-semibold">${fmt(l.minXp)} XP</div>
              </div>`;
            }).join('')}
          </div>
        </section>`;
      icons(); animateBars(app);
    } catch (err) {
      app.innerHTML = emptyState('wifi-off', 'Chargement impossible', err.message);
      icons();
    }
  }

  // ===========================================================================
  // Onglet LEÇONS
  // ===========================================================================
  async function renderLessons() {
    app.innerHTML = skeleton();
    try {
      state.lessons = await api('/api/lessons');
      const skills = ['knife', 'fire', 'seasoning', 'prep', 'baking'];
      const gems = state.profile?.gems || 0;
      const isPro = state.profile?.isPro || false;

      app.innerHTML = `
        <section>
          ${sectionTitle('graduation-cap', 'Leçons de Chef', 'Maîtrise les techniques fondamentales et gagne de l\'XP.')}

          ${isPro
            ? `<div class="glass rounded-2xl p-3 mb-5 flex items-center gap-3 border-l-4 border-orange-500">
                <span class="text-xl">⭐</span>
                <p class="text-sm font-bold text-stone-800">Membre Pro — accès illimité à toutes les leçons</p>
              </div>`
            : `<div class="glass rounded-2xl p-4 mb-5 flex items-center gap-3">
                <div class="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 grid place-items-center text-white text-lg">💎</div>
                <div class="flex-1 min-w-0">
                  <p class="font-bold text-sm text-stone-800">${fmt(gems)} gemmes disponibles</p>
                  <p class="text-xs text-stone-400">Cuisine des recettes pour en gagner.</p>
                </div>
                <button data-open="gem-shop" class="press shrink-0 inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-extrabold bg-orange-500 text-white hover:bg-orange-600 transition-colors shadow-[0_2px_8px_rgba(249,115,22,.35)]">
                  <i data-lucide="star" class="w-3.5 h-3.5"></i>Pro
                </button>
              </div>`}

          <div class="space-y-3">
            ${state.lessons.map((lesson, i) => {
              const m = SKILL_META[lesson.skill];
              const locked = !lesson.unlocked;
              const diff = '★'.repeat(lesson.difficulty) + '☆'.repeat(3 - lesson.difficulty);
              return `
              <div class="rise glass rounded-2xl overflow-hidden" style="animation-delay:${i * 0.04}s">
                <div class="flex items-start gap-4 p-4">
                  <div class="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br ${m.grad} grid place-items-center text-white shadow-sm">
                    <i data-lucide="${lesson.icon}" class="w-5 h-5"></i>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <h3 class="font-bold text-stone-800 leading-tight">${esc(lesson.title)}</h3>
                        <p class="text-xs text-stone-400 mt-0.5">${esc(lesson.description)}</p>
                      </div>
                      ${lesson.completed ? '<span class="shrink-0 w-7 h-7 rounded-full bg-emerald-100 border border-emerald-300 grid place-items-center"><i data-lucide="check" class="w-4 h-4 text-emerald-600"></i></span>' : ''}
                    </div>
                    <div class="mt-2 flex items-center gap-3 flex-wrap">
                      <span class="text-[11px] text-stone-400 font-semibold">${diff}</span>
                      <span class="inline-flex items-center gap-1 text-[11px] font-bold ${m.text}"><i data-lucide="${m.icon}" class="w-3 h-3"></i>${m.name}</span>
                      <span class="text-[11px] font-bold text-orange-500">+${fmt(lesson.xpReward)} XP</span>
                      ${locked && !isPro ? `<span class="inline-flex items-center gap-0.5 text-[11px] font-bold text-cyan-600">💎 ${lesson.gemCost}</span>` : ''}
                    </div>
                  </div>
                </div>
                <div class="border-t border-stone-100 px-4 py-2.5 flex items-center justify-end gap-2">
                  ${lesson.completed
                    ? '<span class="text-xs font-bold text-emerald-600 flex items-center gap-1"><i data-lucide="check-circle" class="w-4 h-4"></i>Leçon complétée</span>'
                    : locked && !isPro
                      ? `<button data-lesson-buy="${lesson.id}" class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold bg-stone-100 border border-stone-200 text-stone-700 hover:bg-stone-200 transition-colors">Acheter · 0,99 €</button>
                         <button data-lesson-unlock="${lesson.id}" data-gem-cost="${lesson.gemCost}" class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold ${gems >= lesson.gemCost ? 'bg-cyan-50 border border-cyan-200 text-cyan-700 hover:bg-cyan-100' : 'bg-stone-50 border border-stone-200 text-stone-400 cursor-not-allowed'} transition-colors">💎 ${lesson.gemCost}</button>`
                      : `<button data-lesson-open="${lesson.id}" class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors"><i data-lucide="play" class="w-3.5 h-3.5"></i>Commencer</button>`}
                </div>
              </div>`;
            }).join('')}
          </div>
        </section>`;
      icons();
    } catch (err) {
      app.innerHTML = emptyState('wifi-off', 'Chargement impossible', err.message);
      icons();
    }
  }

  async function openLesson(id) {
    let lesson;
    try { lesson = await api(`/api/lessons/${id}`); }
    catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); return; }

    const m = SKILL_META[lesson.skill];
    const diff = '★'.repeat(lesson.difficulty) + '☆'.repeat(3 - lesson.difficulty);
    const blockHtml = (b) => {
      if (b.type === 'technique') return `<div class="rounded-xl border-l-4 border-orange-400 bg-orange-50 p-3 my-3"><p class="text-xs font-black uppercase tracking-wider text-orange-600 mb-1">${esc(b.title)}</p><p class="text-sm text-stone-700 leading-relaxed">${esc(b.text)}</p></div>`;
      if (b.type === 'tip') return `<div class="rounded-xl border-l-4 border-amber-400 bg-amber-50 p-3 my-3"><p class="text-xs font-black uppercase tracking-wider text-amber-600 mb-1">💡 Astuce</p><p class="text-sm text-stone-700 leading-relaxed">${esc(b.text)}</p></div>`;
      return `<p class="text-sm text-stone-700 leading-relaxed my-3">${esc(b.text)}</p>`;
    };

    openSheet(`
      <div class="p-5 pb-2">
        <div class="flex items-start gap-4 mb-5">
          <div class="w-14 h-14 shrink-0 rounded-2xl bg-gradient-to-br ${m.grad} grid place-items-center text-white shadow-sm">
            <i data-lucide="${lesson.icon}" class="w-6 h-6"></i>
          </div>
          <div>
            <h2 class="text-xl font-extrabold tracking-tight text-stone-800">${esc(lesson.title)}</h2>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-xs text-stone-400 font-semibold">${diff}</span>
              <span class="text-xs font-bold text-orange-500">+${fmt(lesson.xpReward)} XP</span>
            </div>
          </div>
        </div>
        <div>${lesson.content.map(blockHtml).join('')}</div>
      </div>
      ${!lesson.completed ? `<div class="sticky bottom-0 p-4 pb-safe bg-gradient-to-t from-white via-white/95 to-transparent">
        <button data-lesson-complete="${lesson.id}" class="${primaryBtn}"><i data-lucide="check-circle" class="w-5 h-5"></i>J'ai compris ! +${fmt(lesson.xpReward)} XP</button>
      </div>` : `<div class="p-4 pb-safe text-center text-sm font-bold text-emerald-600 flex items-center justify-center gap-2"><i data-lucide="check-circle" class="w-4 h-4"></i>Leçon complétée</div>`}
    `);
  }

  // ===========================================================================
  // Onglet RECETTES avec sous-onglet QUÊTES
  // ===========================================================================
  function recipesSubTabHtml() {
    const active = state.recipesSubTab;
    const btn = (id, icon, label) => `<button data-subtab="${id}" class="flex-1 py-2 rounded-xl text-xs font-bold transition-all ${active === id ? 'bg-white text-orange-600 shadow-sm' : 'text-stone-500'}"><i data-lucide="${icon}" class="w-3.5 h-3.5 inline mr-1 -mt-0.5"></i>${label}</button>`;
    return `
      <div class="flex rounded-2xl bg-stone-100 p-1 gap-1 mb-5">
        ${btn('catalog', 'book-open', 'Catalogue')}
        ${btn('myrecipes', 'chef-hat', 'Mes recettes')}
        ${btn('quests', 'target', 'Mes quêtes')}
      </div>`;
  }

  async function renderQuestsSub() {
    const questsContainer = $('#quests-sub');
    if (!questsContainer) return;
    try {
      state.quests = await api('/api/quests');
    } catch { return; }
    const quests = state.quests;

    questsContainer.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <span class="text-sm font-bold text-stone-600">${quests.length} quête${quests.length !== 1 ? 's' : ''}</span>
        <button data-quest-create class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors shadow-[0_2px_8px_rgba(249,115,22,.35)]">
          <i data-lucide="plus" class="w-4 h-4"></i>Nouvelle quête
        </button>
      </div>
      ${!quests.length ? emptyState('target', 'Aucune quête', 'Crée une quête personnalisée pour suivre tes objectifs culinaires !') : `
        <div class="space-y-3">
          ${quests.map((q) => {
            const m = SKILL_META[q.skill];
            const pct = Math.min(100, Math.round((q.currentCount / q.targetCount) * 100));
            return `<div class="glass rounded-2xl p-4 ${q.completed ? 'opacity-60' : ''}">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br ${m.grad} grid place-items-center text-white">
                  <i data-lucide="${q.icon || 'target'}" class="w-4 h-4"></i>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-start justify-between gap-2">
                    <h3 class="font-bold text-stone-800 leading-tight">${esc(q.title)}</h3>
                    ${q.completed
                      ? '<span class="shrink-0 text-[10px] font-black bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5">✓ ACCOMPLIE</span>'
                      : `<button data-quest-delete="${q.id}" class="press w-7 h-7 rounded-full bg-stone-100 grid place-items-center text-stone-400 hover:bg-rose-50 hover:text-rose-500 transition-colors"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>`}
                  </div>
                  ${q.description ? `<p class="text-xs text-stone-400 mt-0.5">${esc(q.description)}</p>` : ''}
                  <div class="mt-2">
                    <div class="flex justify-between text-xs font-semibold text-stone-400 mb-1">
                      <span class="${m.text}">${m.emoji} ${m.name}</span>
                      <span class="tabular-nums">${q.currentCount} / ${q.targetCount}</span>
                    </div>
                    ${glowBar(pct, m.grad, m.glow, 'h-2')}
                  </div>
                </div>
              </div>
              ${!q.completed ? `<button data-quest-log="${q.id}" class="press mt-3 w-full rounded-xl py-2.5 text-sm font-bold bg-stone-100 border border-stone-200 text-stone-700 hover:bg-stone-200 transition-colors flex items-center justify-center gap-2">
                <i data-lucide="check" class="w-4 h-4 text-orange-500"></i>Marquer une session (+1)
              </button>` : ''}
            </div>`;
          }).join('')}
        </div>`}`;
    icons(); animateBars(questsContainer);
  }

  function showCreateQuestModal() {
    openModal(`
      <div class="modal-in w-full max-w-sm rounded-[24px] my-auto">
        <div class="glass-strong rounded-[24px] p-6">
          <h2 class="text-xl font-extrabold tracking-tight text-stone-800 mb-4">Nouvelle quête</h2>
          <form id="quest-form" class="space-y-4" novalidate>
            <label class="block">
              <span class="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5">Titre</span>
              <input name="title" type="text" maxlength="60" placeholder="Cuisiner 3 plats italiens…" class="${inputCls}">
              <span data-error="title" class="hidden block text-xs font-semibold text-rose-500 mt-1.5"></span>
            </label>
            <label class="block">
              <span class="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5">Compétence ciblée</span>
              <div class="grid grid-cols-5 gap-2">
                ${SKILLS.map((k) => { const m = SKILL_META[k]; return `<button type="button" data-skill-pick="${k}" class="press rounded-xl p-2 border text-center text-xs font-bold border-stone-200 bg-stone-50 text-stone-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 transition-all">${m.emoji}<span class="block text-[9px] mt-0.5">${m.name.split(' ')[0]}</span></button>`; }).join('')}
              </div>
              <input type="hidden" id="quest-skill-val" name="skill" value="">
              <span data-error="skill" class="hidden block text-xs font-semibold text-rose-500 mt-1.5"></span>
            </label>
            <label class="block">
              <span class="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5">Objectif (sessions)</span>
              <input name="targetCount" type="number" min="1" max="50" value="5" class="${inputCls}">
            </label>
            <div class="flex gap-2 pt-1">
              <button type="button" data-close class="press flex-1 rounded-2xl py-3.5 font-bold bg-stone-100 border border-stone-200 text-stone-700">Annuler</button>
              <button type="submit" class="press flex-1 rounded-2xl py-3.5 font-bold text-white bg-orange-500 hover:bg-orange-600 transition-colors shadow-[0_4px_16px_rgba(249,115,22,.35)]">Créer</button>
            </div>
          </form>
        </div>
      </div>`);

    let selectedSkill = '';
    const modal = $('#modal-root .modal');
    modal.addEventListener('click', (e) => {
      const sp = e.target.closest('[data-skill-pick]');
      if (sp) {
        selectedSkill = sp.dataset.skillPick;
        $('#quest-skill-val').value = selectedSkill;
        $$('[data-skill-pick]', modal).forEach((b) => {
          const on = b.dataset.skillPick === selectedSkill;
          b.classList.toggle('border-orange-400', on); b.classList.toggle('bg-orange-50', on); b.classList.toggle('text-orange-600', on);
          b.classList.toggle('border-stone-200', !on); b.classList.toggle('bg-stone-50', !on); b.classList.toggle('text-stone-600', !on);
        });
      }
    });
    $('#quest-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.currentTarget));
      const btn = $('button[type=submit]', e.currentTarget);
      btn.disabled = true;
      try {
        await api('/api/quests', { method: 'POST', body: { title: fd.title, skill: fd.skill, targetCount: parseInt(fd.targetCount, 10) || 1 } });
        closeModal();
        toast('Quête créée !', { icon: 'check', tone: 'emerald' });
        renderQuestsSub();
      } catch (err) {
        const errEl = $('[data-error="' + (err.field || 'title') + '"]', e.currentTarget);
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
        else toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
      } finally { btn.disabled = false; }
    });
  }

  // ===========================================================================
  // Handlers quêtes & leçons
  // ===========================================================================
  async function handleLessonUnlock(id, gemCost) {
    const gems = state.profile?.gems ?? 0;
    if (gems < gemCost) { toast(`Il te faut ${gemCost} 💎 pour débloquer cette leçon.`, { icon: 'gem', tone: 'rose' }); return; }
    try {
      const res = await api(`/api/lessons/${id}/unlock`, { method: 'POST' });
      if (state.profile && res.gems !== undefined) { state.profile.gems = res.gems; renderHeader(); }
      state.lessons = null;
      toast('Leçon débloquée ! Tu peux maintenant la consulter.', { icon: 'unlock', tone: 'emerald' });
      await loadProfile();
      renderLessons();
      openLesson(id);
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  async function handleLessonComplete(id) {
    try {
      const res = await api(`/api/lessons/${id}/complete`, { method: 'POST' });
      const xpEarned = res.xpResult?.xpGained || 0;
      state.lessons = null;
      closeSheet();
      await loadProfile();
      showRewardModal({ xpGained: xpEarned, gemsEarned: 0, rewards: res.xpResult?.rewards || {}, skillLevelUps: res.xpResult?.skillLevelUps || [], globalLevelUp: res.xpResult?.globalLevelUp || null, recipe: { name: 'Leçon complétée !' } }, 'recipe');
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  async function handleQuestLog(id) {
    try {
      const res = await api(`/api/quests/${id}/log`, { method: 'POST' });
      if (res.completed) {
        toast('Quête accomplie ! 🎉', { icon: 'trophy', tone: 'emerald' });
        await loadProfile();
      } else {
        toast(`+1 session enregistrée (${res.currentCount}/${res.targetCount})`, { icon: 'check', tone: 'emerald' });
      }
      state.quests = null;
      renderQuestsSub();
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  async function handleQuestDelete(id) {
    try {
      await api(`/api/quests/${id}`, { method: 'DELETE' });
      state.quests = null;
      renderQuestsSub();
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  async function handleMyRecipeDelete(id) {
    try {
      await api(`/api/recipes/mine/${id}`, { method: 'DELETE' });
      state.myRecipes = null;
      toast('Recette supprimée', { icon: 'trash-2', tone: 'stone' });
      renderMyRecipesSub();
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  // ===========================================================================
  // Onglet PRO
  // ===========================================================================
  function renderPro() {
    const p = state.profile;
    const isPro = p?.isPro;
    if (isPro) {
      app.innerHTML = `
      <div class="rise max-w-lg mx-auto pt-6 pb-10 text-center space-y-6">
        <div class="text-6xl">⭐</div>
        <div>
          <h1 class="font-display text-3xl font-bold text-stone-800">Tu es Pro !</h1>
          <p class="mt-2 text-stone-500">Accès illimité à toutes les fonctionnalités.</p>
        </div>
        <div class="glass rounded-2xl p-5 text-left space-y-3">
          ${[
            ['graduation-cap', 'Toutes les leçons débloquées', 'Sans gemmes, sans limite'],
            ['star',           'Badge Pro ⭐ sur ton profil',  'Tu brilles dans le classement'],
            ['zap',            'Nouvelles leçons en avant-première', 'Accès prioritaire au contenu'],
            ['gem',            'Gemmes offerts chaque mois',   '50 💎 crédités automatiquement'],
          ].map(([ic, title, sub]) => `
            <div class="flex items-start gap-3">
              <span class="mt-0.5 w-8 h-8 rounded-xl bg-orange-50 border border-orange-200 grid place-items-center shrink-0">
                <i data-lucide="${ic}" class="w-4 h-4 text-orange-500"></i>
              </span>
              <div><p class="font-semibold text-stone-800 text-sm">${title}</p><p class="text-xs text-stone-400">${sub}</p></div>
            </div>`).join('')}
        </div>
      </div>`;
      icons();
      return;
    }
    app.innerHTML = `
    <div class="rise max-w-lg mx-auto pt-6 pb-10 space-y-6">
      <div class="text-center space-y-2">
        <div class="text-5xl">⭐</div>
        <h1 class="font-display text-3xl font-bold text-stone-800">Passer Pro</h1>
        <p class="text-stone-500 text-sm">Débloque tout CulinaRPG sans limite.</p>
      </div>

      <div class="glass rounded-2xl p-5 space-y-3">
        ${[
          ['graduation-cap', 'Toutes les leçons débloquées',       'Plus de 20 leçons premium sans payer de gemmes'],
          ['star',           'Badge Pro ⭐ sur ton profil',         'Montre ta passion dans le classement'],
          ['zap',            'Nouvelles leçons en avant-première',  'Contenu exclusif avant tout le monde'],
          ['gem',            '50 gemmes offerts chaque mois',       'Pour débloquer encore plus'],
        ].map(([ic, title, sub]) => `
          <div class="flex items-start gap-3">
            <span class="mt-0.5 w-8 h-8 rounded-xl bg-orange-50 border border-orange-200 grid place-items-center shrink-0">
              <i data-lucide="${ic}" class="w-4 h-4 text-orange-500"></i>
            </span>
            <div><p class="font-semibold text-stone-800 text-sm">${title}</p><p class="text-xs text-stone-400">${sub}</p></div>
          </div>`).join('')}
      </div>

      <div class="space-y-3">
        <button data-pro-plan="annual" class="pro-subscribe w-full press rounded-2xl p-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white text-center shadow-lg hover:shadow-xl transition-shadow">
          <div class="font-bold text-lg">Pro annuel</div>
          <div class="text-orange-100 text-sm">29,99 € / an · soit 2,50 € / mois</div>
          <div class="mt-1 inline-block text-[11px] font-bold bg-white/20 rounded-full px-2 py-0.5">Meilleure offre 🔥</div>
        </button>
        <button data-pro-plan="monthly" class="pro-subscribe w-full press rounded-2xl p-4 glass text-center hover:border-orange-300 transition-colors">
          <div class="font-bold text-stone-800">Pro mensuel</div>
          <div class="text-stone-500 text-sm">3,99 € / mois</div>
        </button>
      </div>

      <p class="text-center text-xs text-stone-400">Résiliable à tout moment · Paiement sécurisé Stripe</p>
    </div>`;
    icons();

    app.querySelectorAll('.pro-subscribe').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const plan = btn.dataset.proPlan;
        btn.disabled = true; btn.style.opacity = '0.6';
        try {
          const res = await api('/api/stripe/checkout/pro', { method: 'POST', body: { plan } });
          if (res.url) { window.location.href = res.url; return; }
          if (state.profile) { state.profile.isPro = true; }
          haptic([20, 30, 20]); fx.fireworks(2000);
          toast('Bienvenue dans le club Pro ⭐ !', { icon: 'star', tone: 'emerald' });
          renderPro();
        } catch (err) {
          toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
          btn.disabled = false; btn.style.opacity = '';
        }
      });
    });
  }

  // ===========================================================================
  // Boutique de gemmes + abonnement Pro
  // ===========================================================================
  function showGemShop() {
    const gems = state.profile?.gems || 0;
    const isPro = state.profile?.isPro || false;

    const packCard = (id, label, amount, price, tag) => `
      <button data-gem-pack="${id}" class="press glass rounded-2xl p-4 text-left border-2 ${tag ? 'border-orange-400' : 'border-stone-200'} hover:border-orange-400 transition-colors relative overflow-hidden">
        ${tag ? `<span class="absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-orange-500 text-white uppercase tracking-wide">${tag}</span>` : ''}
        <p class="text-2xl font-extrabold tabular-nums text-stone-800">💎 ${fmt(amount)}</p>
        <p class="text-xs text-stone-400 font-semibold mt-0.5">gemmes</p>
        <p class="mt-2 text-base font-extrabold text-orange-500">${price}</p>
      </button>`;

    openModal(`
      <div class="modal-in w-full max-w-md rounded-[28px]">
        <div class="glass-strong rounded-[28px] overflow-hidden">

          <!-- En-tête boutique -->
          <div class="relative bg-gradient-to-br from-orange-400 to-amber-500 p-6 pb-5">
            <button data-close class="press absolute top-4 right-4 w-9 h-9 rounded-full bg-white/20 grid place-items-center hover:bg-white/30 transition-colors"><i data-lucide="x" class="w-4 h-4 text-white"></i></button>
            <p class="text-[11px] font-bold uppercase tracking-widest text-white/70 mb-1">Boutique</p>
            <h2 class="text-2xl font-extrabold text-white tracking-tight">Gemmes & Pro</h2>
            <div class="mt-3 inline-flex items-center gap-2 rounded-full bg-white/20 px-3 py-1.5">
              <span class="text-lg">💎</span>
              <span class="font-extrabold text-white tabular-nums">${fmt(gems)} gemmes</span>
            </div>
          </div>

          <div class="p-5 space-y-6">

            <!-- Packs de gemmes -->
            <div>
              <h3 class="text-xs font-extrabold uppercase tracking-widest text-stone-500 mb-3">Acheter des gemmes</h3>
              <div class="grid grid-cols-3 gap-3">
                ${packCard('starter', 'Starter', 100, '1,99 €', '')}
                ${packCard('valeur', 'Valeur', 500, '4,99 €', 'Populaire')}
                ${packCard('maxi', 'Maxi', 1500, '9,99 €', '-37 %')}
              </div>
              <p class="text-center text-[11px] text-stone-400 mt-2">Paiement simulé — aucun débit réel</p>
            </div>

            <!-- Séparateur -->
            <div class="relative flex items-center gap-3">
              <div class="flex-1 h-px bg-stone-200"></div>
              <span class="text-xs font-bold text-stone-400">ou</span>
              <div class="flex-1 h-px bg-stone-200"></div>
            </div>

            <!-- Abonnement Pro -->
            ${isPro
              ? `<div class="rounded-2xl bg-orange-50 border border-orange-200 p-4 flex items-center gap-3">
                  <span class="text-2xl">⭐</span>
                  <div>
                    <p class="font-extrabold text-stone-800 text-sm">Tu es déjà Membre Pro</p>
                    <p class="text-xs text-stone-400 mt-0.5">Accès illimité à toutes les leçons activé.</p>
                  </div>
                </div>`
              : `<div class="rounded-2xl border-2 border-orange-400 overflow-hidden">
                  <div class="bg-gradient-to-r from-orange-50 to-amber-50 px-4 py-3 flex items-center gap-2">
                    <span class="text-xl">⭐</span>
                    <div class="flex-1 min-w-0">
                      <p class="font-extrabold text-stone-800 text-sm">Passer Pro</p>
                      <p class="text-xs text-stone-400">Toutes les leçons, à vie.</p>
                    </div>
                    <span class="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-extrabold text-orange-600">RECOMMANDÉ</span>
                  </div>
                  <div class="p-4 pt-3 space-y-2.5">
                    <ul class="space-y-1.5 text-xs text-stone-600 font-semibold">
                      <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-emerald-500 shrink-0"></i>Accès illimité aux 8 leçons premium</li>
                      <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-emerald-500 shrink-0"></i>Contenu exclusif à venir</li>
                      <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-emerald-500 shrink-0"></i>Badge Pro sur ton profil</li>
                    </ul>
                    <div class="grid grid-cols-2 gap-2 pt-1">
                      <button data-pro-plan="monthly" class="press rounded-2xl py-3 px-4 text-center bg-white border border-stone-200 hover:border-orange-400 transition-colors">
                        <p class="text-base font-extrabold text-stone-800">3,99 €</p>
                        <p class="text-[11px] text-stone-400 font-semibold">par mois</p>
                      </button>
                      <button data-pro-plan="annual" class="press rounded-2xl py-3 px-4 text-center bg-orange-500 hover:bg-orange-600 transition-colors relative overflow-hidden">
                        <span class="absolute -top-0.5 inset-x-0 flex justify-center"><span class="rounded-b-full px-2 py-0.5 bg-amber-400 text-[9px] font-extrabold text-white">ÉCONOMISE 37 %</span></span>
                        <p class="text-base font-extrabold text-white mt-1">29,99 €</p>
                        <p class="text-[11px] text-white/80 font-semibold">par an</p>
                      </button>
                    </div>
                  </div>
                </div>`}

          </div>
        </div>
      </div>`);

    icons();

    const modal = $('#modal-root .modal');
    modal.addEventListener('click', async (e) => {
      const packBtn = e.target.closest('[data-gem-pack]');
      if (packBtn) {
        packBtn.disabled = true; packBtn.style.opacity = '0.6';
        try {
          const res = await api('/api/stripe/checkout/gems', { method: 'POST', body: { pack: packBtn.dataset.gemPack } });
          if (res.url) { window.location.href = res.url; return; }
          // Mode simulation (pas de clé Stripe)
          if (state.profile) { state.profile.gems = res.gems; renderHeader(); }
          closeModal(); haptic(30);
          toast(`+${fmt(res.earned)} 💎 gemmes ajoutées !`, { icon: 'gem', tone: 'emerald' });
          if (state.tab === 'lessons') renderLessons();
        } catch (err) {
          toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
          packBtn.disabled = false; packBtn.style.opacity = '';
        }
        return;
      }
      const proBtn = e.target.closest('[data-pro-plan]');
      if (proBtn) {
        proBtn.disabled = true; proBtn.style.opacity = '0.6';
        try {
          const res = await api('/api/stripe/checkout/pro', { method: 'POST', body: { plan: proBtn.dataset.proPlan } });
          if (res.url) { window.location.href = res.url; return; }
          // Mode simulation
          if (state.profile) state.profile.isPro = true;
          closeModal(); haptic([20, 30, 20]); fx.fireworks(1500);
          toast('Bienvenue dans le club Pro ⭐ !', { icon: 'star', tone: 'emerald' });
          await loadProfile();
          if (state.tab === 'lessons') renderLessons();
        } catch (err) {
          toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
          proBtn.disabled = false; proBtn.style.opacity = '';
        }
      }
    });
  }

  async function handleLessonBuy(id) {
    try {
      const res = await api('/api/stripe/checkout/lesson', { method: 'POST', body: { lessonId: id } });
      if (res.url) { window.location.href = res.url; return; }
      // Mode simulation (pas de clé Stripe) : leçon débloquée, l'XP sera gagné à la complétion
      state.lessons = null;
      await loadProfile();
      renderLessons();
      toast('Leçon débloquée ! Lis-la et clique "J\'ai compris !" pour gagner l\'XP.', { icon: 'unlock', tone: 'emerald' });
      openLesson(id);
    } catch (err) { toast(err.message, { icon: 'alert-triangle', tone: 'rose' }); }
  }

  // ===========================================================================
  // Onglet RECETTES — sous-onglet "Mes Recettes" (privées)
  // ===========================================================================
  async function renderMyRecipesSub() {
    const container = $('#myrecipes-sub');
    if (!container) return;
    container.innerHTML = `<div class="flex justify-center py-8"><i data-lucide="loader-circle" class="w-8 h-8 animate-spin text-orange-400"></i></div>`;
    icons();
    try {
      state.myRecipes = await api('/api/recipes/mine');
    } catch { return; }
    const recipes = state.myRecipes;

    container.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <span class="text-sm font-bold text-stone-600">${recipes.length} recette${recipes.length !== 1 ? 's' : ''}</span>
        <button data-myrecipe-create class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors shadow-[0_2px_8px_rgba(249,115,22,.35)]">
          <i data-lucide="plus" class="w-4 h-4"></i>Créer ma recette
        </button>
      </div>
      ${!recipes.length
        ? emptyState('book-plus', 'Aucune recette perso', 'Crée ta première recette et gagne de l\'XP en la cuisinant !')
        : `<div class="space-y-3">
            ${recipes.map((r) => {
              const mainM = SKILL_META[r.mainSkill] || SKILL_META.prep;
              return `<div class="rise glass rounded-2xl overflow-hidden">
                <div class="flex items-start gap-3 p-4">
                  <div class="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br ${mainM.grad} grid place-items-center text-white text-xl shadow-sm">${r.emoji || '🍽️'}</div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-2">
                      <h3 class="font-bold text-stone-800 leading-tight">${esc(r.name)}</h3>
                      <button data-myrecipe-delete="${r.id}" class="press shrink-0 w-7 h-7 rounded-full bg-stone-100 grid place-items-center text-stone-400 hover:bg-rose-50 hover:text-rose-500 transition-colors"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                    <div class="flex items-center gap-2 mt-1 flex-wrap">
                      <span class="text-xs font-semibold text-stone-400">${esc(r.category)}</span>
                      <span class="text-xs font-semibold text-stone-400">⏱ ${r.timeMinutes} min</span>
                      <span class="text-xs font-bold text-orange-500">+${fmt(r.totalXp)} XP</span>
                      <span class="inline-flex items-center gap-0.5 text-[11px] font-bold ${mainM.text}"><i data-lucide="${mainM.icon}" class="w-3 h-3"></i>${mainM.name}</span>
                    </div>
                  </div>
                </div>
                <div class="border-t border-stone-100 px-4 py-2.5 flex items-center justify-between gap-3">
                  <span class="text-xs text-stone-400 font-semibold">Cuisinée ${r.cookedCount}×</span>
                  <button data-cook="${r.id}" class="press inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold bg-orange-500 text-white hover:bg-orange-600 transition-colors shadow-[0_2px_8px_rgba(249,115,22,.35)]">
                    <i data-lucide="chef-hat" class="w-3.5 h-3.5"></i>Cuisiner
                  </button>
                </div>
              </div>`;
            }).join('')}
          </div>`}`;
    icons();
  }

  function showCreateRecipeModal() {
    const CATS = Object.keys(CATEGORY_ICON);
    const fieldLabel = 'block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1.5';
    const smInput = 'w-full rounded-xl bg-white border border-stone-200 px-3 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none transition-all focus:border-orange-400 focus:shadow-[0_0_0_3px_rgba(249,115,22,.1)]';

    openModal(`
      <div class="modal-in w-full max-w-lg rounded-[24px] my-auto">
        <div class="glass-strong rounded-[24px]">
          <div class="flex items-center justify-between p-5 pb-0">
            <h2 class="text-xl font-extrabold tracking-tight text-stone-800">Créer ma recette</h2>
            <button data-close class="press w-9 h-9 rounded-full bg-stone-100 border border-stone-200 grid place-items-center hover:bg-stone-200 transition-colors"><i data-lucide="x" class="w-4 h-4 text-stone-500"></i></button>
          </div>
          <div class="overflow-y-auto max-h-[78dvh] p-5 pt-4">
            <form id="myrecipe-form" class="space-y-4" novalidate>

              <label class="block">
                <span class="${fieldLabel}">Titre *</span>
                <input name="title" id="mr-title" type="text" maxlength="80" placeholder="Mon poulet rôti au citron…" class="${inputCls}" required autocomplete="off">
              </label>

              <div class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="${fieldLabel}">Catégorie</span>
                  <select name="category" id="mr-cat" class="${smInput}">
                    ${CATS.map((c) => `<option value="${esc(c)}">${CATEGORY_ICON[c]} ${esc(c)}</option>`).join('')}
                  </select>
                </label>
                <label class="block">
                  <span class="${fieldLabel}">Temps (min)</span>
                  <input name="timeMinutes" id="mr-time" type="number" min="5" max="480" value="30" class="${smInput}">
                </label>
              </div>

              <label class="block">
                <span class="${fieldLabel}">Image (URL optionnelle)</span>
                <input name="imageUrl" type="url" placeholder="https://…" class="${inputCls}">
              </label>

              <div>
                <div class="flex items-center justify-between mb-2">
                  <span class="${fieldLabel} mb-0">Ingrédients *</span>
                  <button type="button" id="mr-add-ing" class="press inline-flex items-center gap-1 text-xs font-bold text-orange-500 hover:text-orange-700 transition-colors">
                    <i data-lucide="plus" class="w-3.5 h-3.5"></i>Ajouter
                  </button>
                </div>
                <div id="mr-ingredients" class="space-y-2">
                  <div class="ing-row flex gap-2">
                    <input name="ing-name" type="text" placeholder="Nom de l'ingrédient" class="${smInput} flex-1" autocomplete="off">
                    <input name="ing-measure" type="text" placeholder="Quantité" class="${smInput} w-28" autocomplete="off">
                    <button type="button" class="mr-rem-ing press w-9 h-9 shrink-0 rounded-xl bg-stone-100 border border-stone-200 grid place-items-center text-stone-400 hover:bg-rose-50 hover:text-rose-500 transition-colors"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
                  </div>
                </div>
              </div>

              <label class="block">
                <span class="${fieldLabel}">Étapes * <span class="text-stone-400 font-normal normal-case">(une étape par ligne)</span></span>
                <textarea name="instructions" id="mr-steps" rows="5" placeholder="Préchauffer le four à 200°C…&#10;Disposer les légumes sur la plaque…&#10;Enfourner 25 min." class="${inputCls} resize-y text-sm"></textarea>
              </label>

              <div class="rounded-2xl bg-orange-50 border border-orange-200 p-3 flex items-center gap-3">
                <span class="text-2xl">⚡</span>
                <div>
                  <p class="text-[10px] font-bold text-orange-500 uppercase tracking-wider">XP estimé</p>
                  <p id="mr-xp-val" class="text-xl font-extrabold text-stone-800 tabular-nums">— XP</p>
                </div>
                <div id="mr-diff" class="ml-auto text-right">
                  <p class="text-[10px] font-bold text-stone-400 uppercase tracking-wider">Difficulté</p>
                  <p id="mr-diff-val" class="text-sm font-extrabold text-stone-600">—</p>
                </div>
              </div>

              <div class="flex gap-2 pt-1">
                <button type="button" data-close class="press flex-1 rounded-2xl py-3.5 font-bold bg-stone-100 border border-stone-200 text-stone-700">Annuler</button>
                <button type="submit" id="mr-submit" class="press flex-1 rounded-2xl py-3.5 font-bold text-white bg-orange-500 hover:bg-orange-600 transition-colors shadow-[0_4px_16px_rgba(249,115,22,.35)]">
                  <i data-lucide="chef-hat" class="w-4 h-4 inline -mt-0.5 mr-1.5"></i>Créer
                </button>
              </div>

            </form>
          </div>
        </div>
      </div>`);

    icons();

    const modal = $('#modal-root .modal');
    const ingList = () => $$('.ing-row', modal);

    const updateXpPreview = () => {
      const ingCount = ingList().filter((r) => r.querySelector('[name="ing-name"]').value.trim()).length;
      const steps = ($('#mr-steps')?.value || '').split('\n').filter((l) => l.trim()).length;
      const time = parseInt($('#mr-time')?.value, 10) || 30;
      const complexity = ingCount * 1.2 + Math.max(1, steps) * 0.8 + Math.min(time, 120) / 15;
      const diff = 1 + [10, 14, 18, 22].filter((t) => complexity >= t).length;
      const xp = 40 + diff * 35 + Math.round(Math.min(time, 120) / 3);
      const xpEl = $('#mr-xp-val'); const diffEl = $('#mr-diff-val');
      if (xpEl) xpEl.textContent = `~${xp} XP`;
      if (diffEl) diffEl.textContent = ['', 'Facile', 'Normale', 'Modérée', 'Difficile', 'Expert'][diff] || 'Modérée';
    };

    $('#mr-add-ing').addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'ing-row flex gap-2';
      row.innerHTML = `<input name="ing-name" type="text" placeholder="Nom de l'ingrédient" class="${smInput} flex-1" autocomplete="off">
        <input name="ing-measure" type="text" placeholder="Quantité" class="${smInput} w-28" autocomplete="off">
        <button type="button" class="mr-rem-ing press w-9 h-9 shrink-0 rounded-xl bg-stone-100 border border-stone-200 grid place-items-center text-stone-400 hover:bg-rose-50 hover:text-rose-500 transition-colors"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>`;
      $('#mr-ingredients').appendChild(row);
      icons();
      updateXpPreview();
    });

    modal.addEventListener('click', (e) => {
      if (e.target.closest('.mr-rem-ing')) {
        const row = e.target.closest('.ing-row');
        if (ingList().length > 1) row.remove(); else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
        updateXpPreview();
      }
    });

    modal.addEventListener('input', updateXpPreview);
    updateXpPreview();

    $('#myrecipe-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('#mr-submit');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-circle" class="w-4 h-4 inline animate-spin -mt-0.5 mr-1.5"></i>Création…';
      icons();

      const fd = new FormData(ev.currentTarget);
      const title = (fd.get('title') || '').toString().trim();
      const category = (fd.get('category') || '').toString();
      const timeMinutes = parseInt((fd.get('timeMinutes') || '30').toString(), 10) || 30;
      const imageUrl = (fd.get('imageUrl') || '').toString().trim() || null;
      const instructions = (fd.get('instructions') || '').toString().trim();

      const nameInputs = $$('[name="ing-name"]', ev.currentTarget);
      const measureInputs = $$('[name="ing-measure"]', ev.currentTarget);
      const ingredients = nameInputs
        .map((inp, i) => ({ name: inp.value.trim(), measure: measureInputs[i]?.value.trim() || '' }))
        .filter((ing) => ing.name);

      if (!title) { toast('Le titre est requis', { icon: 'alert-triangle', tone: 'rose' }); btn.disabled = false; btn.innerHTML = '<i data-lucide="chef-hat" class="w-4 h-4 inline -mt-0.5 mr-1.5"></i>Créer'; icons(); return; }
      if (!ingredients.length) { toast('Au moins un ingrédient requis', { icon: 'alert-triangle', tone: 'rose' }); btn.disabled = false; btn.innerHTML = '<i data-lucide="chef-hat" class="w-4 h-4 inline -mt-0.5 mr-1.5"></i>Créer'; icons(); return; }
      if (!instructions) { toast('Les étapes sont requises', { icon: 'alert-triangle', tone: 'rose' }); btn.disabled = false; btn.innerHTML = '<i data-lucide="chef-hat" class="w-4 h-4 inline -mt-0.5 mr-1.5"></i>Créer'; icons(); return; }

      try {
        await api('/api/recipes/mine', { method: 'POST', body: { title, category, timeMinutes, ingredients, instructions, imageUrl } });
        closeModal();
        state.myRecipes = null;
        toast('Recette créée ! 🍽️', { icon: 'check', tone: 'emerald' });
        renderMyRecipesSub();
      } catch (err) {
        toast(err.message, { icon: 'alert-triangle', tone: 'rose' });
        btn.disabled = false; btn.innerHTML = '<i data-lucide="chef-hat" class="w-4 h-4 inline -mt-0.5 mr-1.5"></i>Créer'; icons();
      }
    });
  }

  // ===========================================================================
  // Événements globaux
  // ===========================================================================
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#screen')) {
      const m = t.closest('[data-auth-mode]');
      if (m) showAuth(m.dataset.authMode);
      return;
    }
    if (t.closest('#sheet-root') || t.closest('#page-root') || t.closest('#modal-root')) return;
    const navBtn = t.closest('.nav-btn');
    if (navBtn) { haptic(); setTab(navBtn.dataset.tab); return; }
    const nav = t.closest('[data-nav]');
    if (nav) { setTab(nav.dataset.nav); return; }
    const open = t.closest('[data-open]');
    if (open) {
      if (open.dataset.open === 'account') openAccount();
      else if (open.dataset.open === 'filters') openFilters();
      else if (open.dataset.open === 'gem-shop') showGemShop();
      return;
    }
    const cook = t.closest('[data-cook]');
    if (cook) { e.stopPropagation(); startCookingSession(cook.dataset.cook); return; }
    const daily = t.closest('[data-daily]');
    if (daily && !daily.disabled) { completeDaily(daily); return; }
    const cat = t.closest('[data-cat]');
    if (cat) {
      state.recipes.category = cat.dataset.cat; haptic();
      const chips = $('#cat-chips'); if (chips) chips.innerHTML = catChips();
      state.recipes.search = $('#recipe-search')?.value.trim() || '';
      loadRecipes(true);
      return;
    }
    if (t.closest('#load-more')) { loadRecipes(); return; }
    const recipe = t.closest('[data-recipe]');
    if (recipe) openRecipe(recipe.dataset.recipe);

    // Sub-tabs Recettes
    const subtab = t.closest('[data-subtab]');
    if (subtab) {
      const tab = subtab.dataset.subtab;
      if (state.recipesSubTab !== tab) { state.recipesSubTab = tab; haptic(); renderRecipes(); }
      return;
    }

    // Leçons
    const lessonBuy = t.closest('[data-lesson-buy]');
    if (lessonBuy) { e.stopPropagation(); handleLessonBuy(lessonBuy.dataset.lessonBuy); return; }
    const lessonUnlock = t.closest('[data-lesson-unlock]');
    if (lessonUnlock) { e.stopPropagation(); handleLessonUnlock(lessonUnlock.dataset.lessonUnlock, parseInt(lessonUnlock.dataset.gemCost, 10)); return; }
    const lessonOpen = t.closest('[data-lesson-open]');
    if (lessonOpen) { e.stopPropagation(); openLesson(lessonOpen.dataset.lessonOpen); return; }
    const lessonComplete = t.closest('[data-lesson-complete]');
    if (lessonComplete) { e.stopPropagation(); handleLessonComplete(lessonComplete.dataset.lessonComplete); return; }

    // Mes Recettes perso
    const myrecipeCreate = t.closest('[data-myrecipe-create]');
    if (myrecipeCreate) { e.stopPropagation(); showCreateRecipeModal(); return; }
    const myrecipeDelete = t.closest('[data-myrecipe-delete]');
    if (myrecipeDelete) { e.stopPropagation(); handleMyRecipeDelete(myrecipeDelete.dataset.myrecipeDelete); return; }

    // Quêtes
    const questCreate = t.closest('[data-quest-create]');
    if (questCreate) { e.stopPropagation(); showCreateQuestModal(); return; }
    const questLog = t.closest('[data-quest-log]');
    if (questLog) { e.stopPropagation(); handleQuestLog(questLog.dataset.questLog); return; }
    const questDelete = t.closest('[data-quest-delete]');
    if (questDelete) { e.stopPropagation(); handleQuestDelete(questDelete.dataset.questDelete); return; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#modal-root').innerHTML) closeModal();
    else if ($('#sheet-root').innerHTML) closeSheet();
    else if ($('#page-root').innerHTML) closePage();
  });
  window.addEventListener('resize', moveIndicator);
  window.addEventListener('hashchange', () => { if (state.profile) setTab(location.hash.slice(1), { push: false }); });
  setInterval(() => { const el = $('#daily-reset'); if (el) el.textContent = resetCountdown(); }, 30000);
  // Revenir sur l'app après minuit : on rafraîchit dailies et streak
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.profile) {
      loadProfile().catch(() => {});
      api('/api/dailies').then((d) => { state.dailies = d; updateDailyDot(); if (state.tab === 'dailies') renderDailies(); }).catch(() => {});
    }
  });

  // ===========================================================================
  // Démarrage
  // ===========================================================================
  (async function boot() {
    screen.innerHTML = '<div class="min-h-[100dvh] bg-stone-50 grid place-items-center"><div class="w-20 h-20 rounded-[24px] bg-gradient-to-br from-orange-400 to-amber-500 grid place-items-center text-4xl float-y shadow-[0_8px_32px_rgba(249,115,22,.35)]">🍳</div></div>';
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    try { state.meta = await api('/api/meta'); } catch { /* optionnel */ }
    try {
      const { user } = await api('/api/auth/me');
      state.user = user;
      if (!user.onboarded) showOnboarding(); else enterApp();
    } catch {
      showAuth('login');
    }
  }());
})();
