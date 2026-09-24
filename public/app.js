/* CulinaRPG — SPA mobile-first (vanilla ES6) */
(() => {
  'use strict';

  // ===========================================================================
  // Métadonnées
  // ===========================================================================
  const SKILL_META = {
    knife: { name: 'Couteau', emoji: '🔪', icon: 'slice', grad: 'from-emerald-400 to-teal-500', text: 'text-emerald-300', glow: 'rgba(52,211,153,.75)', hex: '#34d399' },
    fire: { name: 'Feu', emoji: '🔥', icon: 'flame', grad: 'from-amber-400 to-orange-500', text: 'text-amber-300', glow: 'rgba(251,146,60,.75)', hex: '#fb923c' },
    seasoning: { name: 'Assaisonnement', emoji: '🧂', icon: 'sparkles', grad: 'from-violet-400 to-fuchsia-500', text: 'text-fuchsia-300', glow: 'rgba(217,70,239,.75)', hex: '#d946ef' },
    prep: { name: 'Préparation', emoji: '⏱️', icon: 'timer', grad: 'from-cyan-400 to-blue-500', text: 'text-cyan-300', glow: 'rgba(34,211,238,.75)', hex: '#22d3ee' },
    baking: { name: 'Pâtisserie', emoji: '🥐', icon: 'croissant', grad: 'from-pink-400 to-rose-500', text: 'text-pink-300', glow: 'rgba(244,114,182,.75)', hex: '#f472b6' },
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

  const state = {
    tab: 'profile',
    user: null,
    profile: null,
    dailies: null,
    meta: null,
    categories: [],
    recipes: { items: [], page: 0, totalPages: 1, total: 0, search: '', category: 'all', skill: '', sort: 'featured', loading: false, reqId: 0 },
  };

  // ===========================================================================
  // Utilitaires
  // ===========================================================================
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

  function toast(message, { icon = 'sparkles', tone = 'violet' } = {}) {
    const tones = {
      violet: 'from-violet-500/25 to-fuchsia-500/25 border-violet-400/40 text-violet-50',
      emerald: 'from-emerald-500/25 to-teal-500/25 border-emerald-400/40 text-emerald-50',
      amber: 'from-amber-500/25 to-orange-500/25 border-amber-400/40 text-amber-50',
      rose: 'from-rose-500/25 to-pink-500/25 border-rose-400/40 text-rose-50',
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
    return `<div class="relative ${h} rounded-full bg-slate-800/90 overflow-hidden ring-1 ring-inset ring-white/5">
      <div class="bar-fill h-full rounded-full bg-gradient-to-r ${grad}" data-w="${percent}" style="width:0%;box-shadow:0 0 12px ${glow}"></div>
    </div>`;
  }

  const sectionTitle = (icon, title, sub = '', right = '') => `
    <div class="flex items-end justify-between gap-4 mb-3">
      <div class="min-w-0">
        <h2 class="flex items-center gap-2 text-lg sm:text-2xl font-bold tracking-tight">
          <i data-lucide="${icon}" class="w-5 h-5 text-violet-300"></i>${title}
        </h2>
        ${sub ? `<p class="text-sm text-slate-400 mt-0.5">${sub}</p>` : ''}
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
      ? `<img src="${esc(thumb(r.imageUrl, w))}" alt="${esc(r.name)}" loading="lazy" decoding="async" class="img-zoom absolute inset-0 w-full h-full object-cover bg-slate-800" onerror="this.remove()">`
      : '';
    return `<div class="relative ${cls} overflow-hidden">${fallback}${img}
      <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/10 to-transparent"></div></div>`;
  }

  function emptyState(icon, title, text, action = '') {
    return `<div class="glass rounded-3xl p-8 text-center">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-slate-800 grid place-items-center text-slate-400"><i data-lucide="${icon}" class="w-6 h-6"></i></div>
      <h3 class="mt-3 font-bold tracking-tight text-lg">${title}</h3>
      <p class="text-sm text-slate-400 mt-1">${text}</p>${action}
    </div>`;
  }

  const skeleton = () => `<div class="grid gap-4"><div class="h-48 rounded-3xl skeleton"></div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${'<div class="h-40 rounded-2xl skeleton"></div>'.repeat(6)}</div></div>`;

  const inputCls = 'w-full rounded-2xl bg-slate-950/70 border border-slate-800 px-4 py-3.5 text-base placeholder:text-slate-500 outline-none transition-all duration-300 focus:border-violet-400/70 focus:shadow-[0_0_0_4px_rgba(167,139,250,.15)]';
  const primaryBtn = 'press w-full inline-flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-extrabold text-white bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 shadow-[0_0_28px_rgba(217,70,239,.45)] disabled:opacity-60';

  function field({ name, label, type = 'text', value = '', placeholder = '', autocomplete = '', extra = '' }) {
    return `<label class="block">
      <span class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">${label}</span>
      <input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${extra} class="${inputCls}">
      <span data-error="${name}" class="hidden block text-xs font-semibold text-rose-300 mt-1.5"></span>
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
      <div class="min-h-[100dvh] flex flex-col px-5 pt-safe pb-safe max-w-md mx-auto">
        <div class="flex-1 flex flex-col justify-center py-8">
          <div class="text-center rise">
            <div class="relative mx-auto w-24 h-24 float-y">
              <div class="absolute inset-0 rounded-[28px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 blur-xl opacity-60"></div>
              <div class="relative w-24 h-24 rounded-[28px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 grid place-items-center text-5xl shadow-2xl">🍳</div>
            </div>
            <h1 class="mt-6 text-4xl font-black tracking-tight text-glow">Culina<span class="bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">RPG</span></h1>
            <p class="mt-2 text-slate-400">Monte en niveau en cuisinant. 500 quêtes t'attendent.</p>
            <div class="mt-4 flex justify-center gap-1.5">${SKILLS.map((s) => `<span class="w-9 h-9 rounded-xl grid place-items-center bg-gradient-to-br ${SKILL_META[s].grad} text-slate-950 text-lg" style="box-shadow:0 0 14px ${SKILL_META[s].glow.replace('.75', '.35')}">${SKILL_META[s].emoji}</span>`).join('')}</div>
          </div>

          <div class="glass rise rounded-3xl p-5 mt-8" style="animation-delay:.08s">
            <div class="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-slate-950/60 border border-slate-800">
              <button data-auth-mode="login" class="press rounded-xl py-2.5 text-sm font-bold transition-all ${isLogin ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_16px_rgba(192,132,252,.45)]' : 'text-slate-400'}">Connexion</button>
              <button data-auth-mode="signup" class="press rounded-xl py-2.5 text-sm font-bold transition-all ${!isLogin ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_16px_rgba(192,132,252,.45)]' : 'text-slate-400'}">Inscription</button>
            </div>
            ${notice ? `<p class="mt-4 text-sm font-semibold text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">${esc(notice)}</p>` : ''}
            <form id="auth-form" class="mt-5 space-y-4" novalidate>
              ${isLogin ? `
                ${field({ name: 'identifier', label: 'E-mail ou pseudo', placeholder: 'chef@exemple.fr', autocomplete: 'username', extra: 'autocapitalize="none" required' })}
                ${field({ name: 'password', label: 'Mot de passe', type: 'password', placeholder: '••••••••', autocomplete: 'current-password', extra: 'required' })}
              ` : `
                ${field({ name: 'username', label: 'Pseudo', placeholder: 'chef_victor', autocomplete: 'username', extra: 'autocapitalize="none" maxlength="20" required' })}
                ${field({ name: 'email', label: 'E-mail', type: 'email', placeholder: 'chef@exemple.fr', autocomplete: 'email', extra: 'autocapitalize="none" required' })}
                ${field({ name: 'password', label: 'Mot de passe (8 caractères min.)', type: 'password', placeholder: '••••••••', autocomplete: 'new-password', extra: 'minlength="8" required' })}
              `}
              <button type="submit" class="${primaryBtn}">
                <i data-lucide="${isLogin ? 'log-in' : 'sparkles'}" class="w-5 h-5"></i>${isLogin ? 'Entrer dans la cuisine' : 'Créer mon personnage'}
              </button>
            </form>
          </div>
        </div>
        <p class="text-center text-xs text-slate-600 pb-2">Photos des recettes : Wikipédia / Wikimedia Commons</p>
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
          <div id="av-preview" class="w-28 h-28 rounded-full p-[3px] bg-gradient-to-br from-violet-400 via-fuchsia-400 to-amber-300 shadow-[0_0_40px_rgba(217,70,239,.35)]">
            <div class="w-full h-full rounded-full overflow-hidden bg-slate-900">${avatarHtml(d, { text: 'text-5xl' })}</div>
          </div>
          <label class="press absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-slate-900 border border-slate-700 grid place-items-center cursor-pointer shadow-lg" aria-label="Choisir une photo">
            <i data-lucide="camera" class="w-5 h-5 text-violet-300"></i>
            <input id="av-file" type="file" accept="image/*" class="hidden">
          </label>
        </div>
        ${d.avatarImage ? '<button type="button" data-av-remove class="mt-3 text-xs font-bold text-rose-300 press">Retirer la photo</button>' : '<p class="mt-3 text-xs text-slate-500">Choisis un emoji ou ajoute une photo</p>'}
      </div>
      <div class="mt-4 grid grid-cols-6 sm:grid-cols-10 gap-2">
        ${AVATAR_EMOJIS.map((e) => `<button type="button" data-av-emoji="${e}" class="press aspect-square rounded-2xl grid place-items-center text-2xl border transition-all ${!d.avatarImage && d.avatar === e ? 'border-violet-400 bg-violet-500/20 shadow-[0_0_14px_rgba(167,139,250,.45)]' : 'border-slate-800 bg-slate-900/60'}">${e}</button>`).join('')}
      </div>
      <div class="mt-4 flex justify-center gap-3">
        ${Object.entries(AVATAR_COLORS).map(([k, g]) => `<button type="button" data-av-color="${k}" aria-label="Couleur ${k}" class="press w-9 h-9 rounded-full bg-gradient-to-br ${g} transition-all ${d.avatarColor === k ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-110' : 'opacity-70'}"></button>`).join('')}
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
      const dots = [1, 2, 3].map((i) => `<span class="h-1.5 rounded-full transition-all duration-500 ${i === draft.step ? 'w-8 bg-gradient-to-r from-violet-400 to-fuchsia-400' : i < draft.step ? 'w-4 bg-violet-400/60' : 'w-4 bg-slate-700'}"></span>`).join('');
      let body = '';
      if (draft.step === 1) {
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-violet-300/80 font-semibold">Étape 1 · Identité</p>
          <h1 class="text-3xl font-black tracking-tight mt-1">Crée ton chef</h1>
          <p class="text-slate-400 text-sm mt-1">Choisis ton apparence et ton nom de héros.</p>
          <div class="glass rounded-3xl p-5 mt-5" id="ob-avatar">${avatarEditorHtml(draft)}</div>
          <div class="mt-4">${field({ name: 'displayName', label: 'Nom affiché', value: draft.displayName, placeholder: 'Chef Victor', extra: 'maxlength="30" id="ob-name"' })}</div>`;
      } else if (draft.step === 2) {
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-violet-300/80 font-semibold">Étape 2 · Classe</p>
          <h1 class="text-3xl font-black tracking-tight mt-1">Choisis ta voie</h1>
          <p class="text-slate-400 text-sm mt-1">Ta classe te donne <b class="text-violet-200">+10 % d'XP</b> dans sa compétence. Modifiable plus tard.</p>
          <div class="mt-5 grid gap-3">
            ${classes.map((c) => {
              const m = SKILL_META[c.skill]; const on = draft.chefClass === c.skill;
              return `<button type="button" data-class="${c.skill}" class="press text-left glass rounded-2xl p-4 flex items-center gap-4 transition-all duration-300 ${on ? 'border-transparent ring-2 ring-offset-2 ring-offset-slate-950' : ''}" style="${on ? `box-shadow:0 0 28px ${m.glow.replace('.75', '.45')};--tw-ring-color:${m.hex}` : ''}">
                <span class="w-14 h-14 shrink-0 rounded-2xl grid place-items-center text-2xl bg-gradient-to-br ${m.grad}">${m.emoji}</span>
                <span class="flex-1 min-w-0"><span class="block text-lg font-extrabold tracking-tight">${esc(c.name)}</span>
                  <span class="block text-sm text-slate-400">${esc(c.description || `+10 % d'XP ${m.name}`)}</span></span>
                <span class="w-6 h-6 rounded-full border-2 grid place-items-center ${on ? 'border-transparent bg-gradient-to-br ' + m.grad : 'border-slate-600'}">${on ? '<i data-lucide="check" class="w-4 h-4 text-slate-950"></i>' : ''}</span>
              </button>`;
            }).join('')}
          </div>`;
      } else {
        const m = SKILL_META[draft.chefClass] || SKILL_META.prep;
        const c = classes.find((x) => x.skill === draft.chefClass);
        body = `
          <p class="text-xs uppercase tracking-[.25em] text-violet-300/80 font-semibold">Étape 3 · Prêt</p>
          <h1 class="text-3xl font-black tracking-tight mt-1">Ton aventure commence</h1>
          <div class="holo-border mt-6 rounded-[28px]">
            <div class="shine glass-strong rounded-[28px] p-6 text-center">
              <div class="mx-auto w-28 h-28 rounded-full p-[3px] bg-gradient-to-br ${m.grad} pop"><div class="w-full h-full rounded-full overflow-hidden bg-slate-900">${avatarHtml(draft, { text: 'text-5xl' })}</div></div>
              <h2 class="mt-4 text-2xl font-black tracking-tight">${esc(draft.displayName)}</h2>
              <p class="text-violet-300 font-semibold text-sm">Commis de Cuisine · Niv. 1</p>
              <div class="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gradient-to-r ${m.grad} text-slate-950 font-extrabold text-sm">${m.emoji} Classe ${esc(c?.name || '')}</div>
              <div class="mt-5 grid grid-cols-3 gap-2 text-center">
                <div class="rounded-2xl bg-slate-950/60 border border-slate-800 p-3"><div class="text-xl font-black">500</div><div class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Quêtes</div></div>
                <div class="rounded-2xl bg-slate-950/60 border border-slate-800 p-3"><div class="text-xl font-black">5</div><div class="text-[9px] uppercase tracking-normal text-slate-500 font-bold">Compétences</div></div>
                <div class="rounded-2xl bg-slate-950/60 border border-slate-800 p-3"><div class="text-xl font-black">7</div><div class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Dailies</div></div>
              </div>
            </div>
          </div>`;
      }

      screen.innerHTML = `
        <div class="min-h-[100dvh] flex flex-col px-5 pt-safe max-w-lg mx-auto">
          <div class="flex items-center justify-between py-4">
            ${draft.step > 1 ? '<button data-ob-back class="press w-10 h-10 rounded-full glass grid place-items-center" aria-label="Retour"><i data-lucide="chevron-left" class="w-5 h-5"></i></button>' : '<span class="w-10"></span>'}
            <div class="flex gap-1.5">${dots}</div><span class="w-10"></span>
          </div>
          <div class="flex-1 rise" key="${draft.step}">${body}</div>
          <div class="sticky bottom-0 py-4 pb-safe bg-gradient-to-t from-[#0b0f17] via-[#0b0f17] to-transparent">
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
    setTab(['profile', 'dailies', 'recipes'].includes(initial) ? initial : state.tab, { push: false });
    if (document.fonts?.ready) document.fonts.ready.then(moveIndicator);
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
    $('#hdr-ring').style.background = `conic-gradient(#c084fc ${p.global.percent}%, #1e293b ${p.global.percent}%)`;
    $('#hdr-streak-count').textContent = p.streak;
    $('#hdr-flame').classList.toggle('flame-off', p.streak === 0);
    $('#hdr-streak').title = p.activeToday ? `Série de ${p.streak} jour(s) — actif aujourd'hui` : 'Cuisine ou complète une daily pour entretenir ta série !';
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
      b.classList.toggle('text-slate-500', !active);
      const ico = $('.nav-ico', b);
      // Mobile : pastille lumineuse derrière l'icône active
      ico.classList.toggle('bg-gradient-to-r', active);
      ico.classList.toggle('from-violet-500', active);
      ico.classList.toggle('to-fuchsia-500', active);
      ico.classList.toggle('shadow-[0_0_18px_rgba(192,132,252,.6)]', active);
      ico.classList.toggle('sm:bg-none', true);
      ico.classList.toggle('sm:shadow-none', true);
    });
  }

  function setTab(tab, { push = true } = {}) {
    if (!['profile', 'dailies', 'recipes'].includes(tab)) tab = 'profile';
    const changed = state.tab !== tab;
    state.tab = tab;
    if (push) history.replaceState(null, '', `#${tab}`);
    moveIndicator();
    if (changed) window.scrollTo({ top: 0 });
    ({ profile: renderProfile, dailies: renderDailies, recipes: renderRecipes })[tab]();
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
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa" stop-opacity=".55"/><stop offset="1" stop-color="#22d3ee" stop-opacity=".35"/></linearGradient></defs>
      ${rings}${axes}
      <polygon points="${poly}" fill="url(#rg)" stroke="#c4b5fd" stroke-width="2" style="filter:drop-shadow(0 0 10px rgba(167,139,250,.6))"/>
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
          <div class="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-violet-600/20 blur-3xl"></div>
          <button data-open="account" class="press absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-slate-950/60 border border-slate-800 grid place-items-center" aria-label="Réglages du compte"><i data-lucide="settings-2" class="w-5 h-5 text-slate-300"></i></button>
          <div class="relative flex flex-col sm:flex-row items-center gap-5 sm:gap-7">
            <div class="relative shrink-0">
              <div class="w-32 h-32 rounded-full p-[4px] shadow-[0_0_40px_rgba(167,139,250,.35)]" style="background:conic-gradient(#a78bfa, #f0abfc ${p.global.percent}%, #1e293b ${p.global.percent}%)">
                <div class="w-full h-full rounded-full overflow-hidden bg-slate-900">${avatarHtml(p, { text: 'text-6xl' })}</div>
              </div>
              <div class="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-extrabold tracking-wider bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-[0_0_16px_rgba(217,70,239,.6)] border-2 border-slate-900 whitespace-nowrap">NIV. ${p.level}</div>
            </div>
            <div class="flex-1 min-w-0 w-full text-center sm:text-left">
              <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-glow truncate">${esc(p.displayName)}</h1>
              <p class="text-sm text-slate-500 font-semibold">@${esc(p.username)}</p>
              <div class="mt-2 flex flex-wrap justify-center sm:justify-start gap-2">
                <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold bg-violet-500/15 border border-violet-400/30 text-violet-200"><i data-lucide="crown" class="w-3.5 h-3.5"></i>${esc(p.title)}</span>
                ${cls ? `<span class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-extrabold bg-gradient-to-r ${cls.grad} text-slate-950">${cls.emoji} ${esc(clsName || cls.name)}</span>` : ''}
              </div>
              ${p.bio ? `<p class="mt-3 text-sm text-slate-300 leading-relaxed">${esc(p.bio)}</p>` : ''}
              <div class="mt-4">
                <div class="flex justify-between text-xs font-semibold text-slate-400 mb-1.5">
                  <span>XP global · ${fmt(p.totalXp)}</span><span class="tabular-nums">${fmt(p.global.currentLevelXp)} / ${fmt(p.global.nextLevelXp)}</span>
                </div>
                ${glowBar(p.global.percent, 'from-violet-500 via-fuchsia-500 to-cyan-400', 'rgba(192,132,252,.8)', 'h-3')}
              </div>
            </div>
          </div>
          <div class="relative grid grid-cols-3 gap-2 sm:gap-3 mt-6">
            ${[
              ['utensils', 'Recettes', p.stats.recipesCooked, 'text-emerald-300'],
              ['calendar-check', 'Dailies', p.stats.dailiesDone, 'text-cyan-300'],
              ['flame', 'Record', `${p.bestStreak} j`, 'text-amber-300'],
            ].map(([ic, label, val, c]) => `
              <div class="rounded-2xl bg-slate-950/50 border border-slate-800/80 p-3 text-center">
                <i data-lucide="${ic}" class="w-4 h-4 mx-auto ${c}"></i>
                <div class="text-xl sm:text-2xl font-extrabold mt-1 tabular-nums">${val}</div>
                <div class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">${label}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="glass rise rounded-3xl p-5 flex flex-col" style="animation-delay:.08s">
          <h3 class="font-bold tracking-tight flex items-center gap-2"><i data-lucide="radar" class="w-4 h-4 text-cyan-300"></i>Profil de compétences</h3>
          <div class="flex-1 grid place-items-center py-2">${radarChart(p.skills)}</div>
        </div>
      </section>

      <section class="mt-7">
        ${sectionTitle('swords', 'Compétences', 'Chaque recette et daily fait progresser tes stats.')}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          ${p.skills.map((s, i) => {
            const m = SKILL_META[s.skill]; const isClass = p.chefClass === s.skill;
            return `
            <div class="glass rise rounded-2xl p-3.5 lg:p-4 flex lg:block items-center gap-3 relative overflow-hidden" style="animation-delay:${0.04 * i + 0.1}s">
              <div class="absolute -top-10 -right-10 w-28 h-28 rounded-full bg-gradient-to-br ${m.grad} opacity-10 blur-2xl"></div>
              <div class="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br ${m.grad} grid place-items-center text-slate-950" style="box-shadow:0 0 18px ${m.glow.replace('.75', '.4')}">
                <i data-lucide="${m.icon}" class="w-5 h-5"></i>
              </div>
              <div class="flex-1 min-w-0 lg:mt-3">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold tracking-tight truncate">${m.name}${isClass ? ' <span class="text-[10px] align-middle font-black text-amber-300">+10%</span>' : ''}</span>
                  <span class="text-sm font-black ${m.text} shrink-0">Niv. ${s.level}</span>
                </div>
                <div class="mt-2">${glowBar(s.percent, m.grad, m.glow, 'h-2')}</div>
                <div class="mt-1 flex justify-between text-[11px] font-semibold text-slate-500 tabular-nums">
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
            <div class="rise rounded-2xl p-3 text-center ${b.unlocked
              ? 'glass border-amber-400/30 shadow-[0_0_24px_-6px_rgba(251,191,36,.45)]'
              : 'bg-slate-900/30 border border-dashed border-slate-800 opacity-60'}" style="animation-delay:${0.03 * i}s" title="${esc(b.description)}">
              <div class="w-11 h-11 mx-auto rounded-2xl grid place-items-center ${b.unlocked
                ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-amber-950 shadow-[0_0_16px_rgba(251,191,36,.6)]'
                : 'bg-slate-800 text-slate-500'}"><i data-lucide="${b.unlocked ? b.icon : 'lock'}" class="w-5 h-5"></i></div>
              <div class="mt-2 text-xs font-bold tracking-tight leading-tight ${b.unlocked ? '' : 'text-slate-400'}">${esc(b.name)}</div>
              <div class="text-[10px] text-slate-500 mt-0.5 leading-snug">${esc(b.description)}</div>
            </div>`).join('')}
        </div>
      </section>

      <section class="mt-7">
        ${sectionTitle('scroll-text', 'Journal de quêtes', 'Tes dernières recettes accomplies.')}
        ${p.recent.length ? `<div class="glass rounded-2xl divide-y divide-slate-800/70 overflow-hidden">
          ${p.recent.map((c) => `
            <button data-recipe="${c.recipe.id}" class="press w-full flex items-center gap-3 p-3 text-left">
              <span class="w-12 h-12 rounded-xl overflow-hidden bg-slate-800 grid place-items-center text-xl shrink-0">${c.recipe.imageUrl ? `<img src="${esc(thumb(c.recipe.imageUrl, 330))}" class="w-full h-full object-cover" loading="lazy" alt="">` : c.recipe.emoji}</span>
              <span class="flex-1 min-w-0"><span class="block font-semibold truncate">${esc(c.recipe.name)}</span>
                <span class="text-xs text-slate-500">${new Date(c.cookedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}</span></span>
              <span class="text-sm font-extrabold text-violet-300 tabular-nums">+${fmt(c.xpGained)}</span>
            </button>`).join('')}
        </div>` : emptyState('chef-hat', 'Aucune recette cuisinée', 'Ouvre le tableau des quêtes et lance ta première recette !',
          '<button data-nav="recipes" class="press mt-4 rounded-xl px-5 py-3 text-sm font-bold bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-[0_0_18px_rgba(192,132,252,.45)]">Voir les quêtes</button>')}
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
      <div class="page fixed inset-0 z-[70] bg-[#0b0f17] overflow-y-auto page-in">
        <div class="sticky top-0 z-10 glass-strong border-x-0 border-t-0 pt-safe">
          <div class="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3">
            <button data-close-page class="press w-10 h-10 rounded-full bg-slate-900 border border-slate-800 grid place-items-center" aria-label="Retour"><i data-lucide="chevron-left" class="w-5 h-5"></i></button>
            <h1 class="text-lg font-bold tracking-tight flex-1">Mon compte</h1>
          </div>
        </div>
        <div class="max-w-2xl mx-auto px-4 py-5 space-y-5 pb-safe">
          <form id="acc-profile" class="glass rounded-3xl p-5 space-y-4" novalidate>
            <h2 class="font-bold tracking-tight flex items-center gap-2"><i data-lucide="user-round-pen" class="w-4 h-4 text-violet-300"></i>Profil</h2>
            <div id="acc-avatar">${avatarEditorHtml(draft)}</div>
            ${field({ name: 'displayName', label: 'Nom affiché', value: p.displayName, extra: 'maxlength="30"' })}
            ${field({ name: 'username', label: 'Pseudo', value: p.username, extra: 'maxlength="20" autocapitalize="none"' })}
            <label class="block">
              <span class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">Bio</span>
              <textarea name="bio" rows="3" maxlength="160" placeholder="Passionné de cuisine au feu de bois…" class="${inputCls} resize-none">${esc(p.bio)}</textarea>
              <span data-error="bio" class="hidden block text-xs font-semibold text-rose-300 mt-1.5"></span>
            </label>
            <button type="submit" class="${primaryBtn}"><i data-lucide="save" class="w-5 h-5"></i>Enregistrer</button>
          </form>

          <section class="glass rounded-3xl p-5">
            <h2 class="font-bold tracking-tight flex items-center gap-2"><i data-lucide="crown" class="w-4 h-4 text-amber-300"></i>Titre affiché</h2>
            <p class="text-xs text-slate-500 mt-1">Débloque de nouveaux titres en montant de niveau.</p>
            <div class="mt-3 grid gap-2">
              <button data-title="" class="press flex items-center justify-between rounded-2xl px-4 py-3 border text-left ${!p.selectedTitle ? 'border-violet-400/60 bg-violet-500/10' : 'border-slate-800 bg-slate-900/50'}">
                <span><span class="block font-semibold text-sm">Automatique</span><span class="text-xs text-slate-500">Selon ton niveau global</span></span>
                ${!p.selectedTitle ? '<i data-lucide="check" class="w-5 h-5 text-violet-300"></i>' : ''}
              </button>
              ${p.titles.map((t) => `
                <button data-title="${esc(t.name)}" ${t.unlocked ? '' : 'disabled'} class="press flex items-center justify-between rounded-2xl px-4 py-3 border text-left ${p.selectedTitle === t.name ? 'border-violet-400/60 bg-violet-500/10' : 'border-slate-800 bg-slate-900/50'} ${t.unlocked ? '' : 'opacity-45'}">
                  <span><span class="block font-semibold text-sm">${t.skill ? SKILL_META[t.skill].emoji + ' ' : ''}${esc(t.name)}</span><span class="text-xs text-slate-500">${esc(t.requirement)}</span></span>
                  <i data-lucide="${t.unlocked ? (p.selectedTitle === t.name ? 'check' : 'circle') : 'lock'}" class="w-5 h-5 ${p.selectedTitle === t.name ? 'text-violet-300' : 'text-slate-600'}"></i>
                </button>`).join('')}
            </div>
          </section>

          <section class="glass rounded-3xl p-5">
            <h2 class="font-bold tracking-tight flex items-center gap-2"><i data-lucide="swords" class="w-4 h-4 text-fuchsia-300"></i>Classe</h2>
            <p class="text-xs text-slate-500 mt-1">+10 % d'XP sur la compétence de ta classe.</p>
            <div class="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              ${classes.map((c) => { const m = SKILL_META[c.skill]; const on = p.chefClass === c.skill; return `
                <button data-set-class="${c.skill}" class="press rounded-2xl p-3 border text-left transition-all ${on ? 'border-transparent bg-gradient-to-br ' + m.grad + ' text-slate-950' : 'border-slate-800 bg-slate-900/50'}">
                  <span class="text-2xl">${m.emoji}</span><span class="block font-extrabold text-sm mt-1">${esc(c.name)}</span><span class="block text-[11px] ${on ? 'text-slate-900/80' : 'text-slate-500'}">${m.name}</span>
                </button>`; }).join('')}
            </div>
          </section>

          <form id="acc-password" class="glass rounded-3xl p-5 space-y-4" novalidate>
            <h2 class="font-bold tracking-tight flex items-center gap-2"><i data-lucide="key-round" class="w-4 h-4 text-cyan-300"></i>Sécurité</h2>
            <p class="text-xs text-slate-500 -mt-2">Connecté avec <b class="text-slate-300">${esc(p.email)}</b>. Changer le mot de passe déconnecte tes autres appareils.</p>
            ${field({ name: 'currentPassword', label: 'Mot de passe actuel', type: 'password', autocomplete: 'current-password' })}
            ${field({ name: 'newPassword', label: 'Nouveau mot de passe', type: 'password', autocomplete: 'new-password', extra: 'minlength="8"' })}
            <button type="submit" class="press w-full rounded-2xl py-3.5 font-bold bg-slate-800 border border-slate-700">Changer le mot de passe</button>
          </form>

          <button data-logout class="press w-full glass rounded-2xl py-4 font-bold flex items-center justify-center gap-2"><i data-lucide="log-out" class="w-5 h-5"></i>Se déconnecter</button>

          <form id="acc-delete" class="rounded-3xl p-5 border border-rose-500/30 bg-rose-500/5 space-y-3" novalidate>
            <h2 class="font-bold tracking-tight text-rose-200 flex items-center gap-2"><i data-lucide="triangle-alert" class="w-4 h-4"></i>Zone de danger</h2>
            <p class="text-xs text-rose-200/70">Supprime définitivement ton compte, ta progression et ton historique.</p>
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
        <div class="absolute -top-20 -left-20 w-64 h-64 rounded-full bg-amber-500/15 blur-3xl"></div>
        <div class="relative flex items-center gap-5">
          <div class="relative w-28 h-28 shrink-0">
            <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
              <defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f97316"/></linearGradient></defs>
              <circle cx="50" cy="50" r="42" fill="none" stroke="#1e293b" stroke-width="9"/>
              <circle id="daily-ring" cx="50" cy="50" r="42" fill="none" stroke="url(#dg)" stroke-width="9" stroke-linecap="round"
                stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition:stroke-dashoffset 1s cubic-bezier(.22,1,.36,1);filter:drop-shadow(0 0 8px rgba(251,146,60,.7))"/>
            </svg>
            <div class="absolute inset-0 grid place-items-center text-center">
              <div><div id="daily-count" class="text-2xl font-extrabold tabular-nums">${d.completedCount}<span class="text-slate-500 text-base">/${d.totalCount}</span></div>
              <div class="text-[9px] uppercase tracking-widest text-slate-500 font-bold">faites</div></div>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[11px] uppercase tracking-[.2em] text-amber-300/80 font-semibold">Quêtes du jour</p>
            <h1 class="text-2xl font-extrabold tracking-tight mt-0.5">Entraînement</h1>
            <p class="text-slate-400 text-sm mt-1 leading-snug">Garde ta série 🔥 en vie : chaque action compte.</p>
            <div class="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-slate-950/60 border border-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
              <i data-lucide="hourglass" class="w-3.5 h-3.5 text-amber-300"></i>Reset dans <span id="daily-reset" class="tabular-nums text-amber-200">${resetCountdown()}</span>
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
        class="daily rise press w-full text-left glass rounded-2xl p-3.5 flex items-center gap-3 transition-all duration-300 ${t.completed ? 'done opacity-60' : ''}" style="animation-delay:${0.04 * i}s">
        <div class="check shrink-0 w-10 h-10 rounded-full grid place-items-center border-2 transition-all duration-300 ${t.completed
          ? 'bg-gradient-to-br from-emerald-400 to-teal-500 border-transparent shadow-[0_0_16px_rgba(52,211,153,.6)]' : 'border-slate-600'}">
          <svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="${t.completed ? '#022c22' : '#34d399'}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="check-path" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="title font-bold tracking-tight text-[15px] leading-tight ${t.completed ? 'line-through decoration-2 decoration-emerald-400/70' : ''}">${esc(t.title)}</div>
          <div class="text-[13px] text-slate-400 leading-snug mt-0.5">${esc(t.description)}</div>
        </div>
        <div class="shrink-0 flex flex-col items-end gap-1">
          <span class="w-8 h-8 rounded-lg bg-gradient-to-br ${m.grad} grid place-items-center text-slate-950"><i data-lucide="${esc(t.icon)}" class="w-4 h-4"></i></span>
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
    if (cnt) cnt.innerHTML = `${d.completedCount}<span class="text-slate-500 text-base">/${d.totalCount}</span>`;
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
        ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 border-transparent text-white shadow-[0_0_16px_rgba(192,132,252,.5)]'
        : 'bg-slate-900/60 border-slate-800 text-slate-300'}">${label}${count !== undefined ? ` <span class="opacity-60 text-xs">${count}</span>` : ''}</button>`;
    return chip(s.category === 'all', 'all', '✨ Toutes')
      + state.categories.map((c) => chip(s.category === c.name, c.name, `${CATEGORY_ICON[c.name] || '🍽️'} ${esc(c.name)}`, c.count)).join('');
  }

  function renderRecipes() {
    const s = state.recipes;
    const n = activeFilterCount();
    app.innerHTML = `
      <section class="rise">
        <p class="text-[11px] uppercase tracking-[.2em] text-cyan-300/80 font-semibold">Tableau des quêtes</p>
        <div class="flex items-end justify-between gap-3 mt-0.5">
          <h1 class="text-2xl sm:text-3xl font-extrabold tracking-tight">Que cuisines-tu ?</h1>
          <span id="recipe-total" class="text-xs text-slate-400 font-semibold whitespace-nowrap pb-1"></span>
        </div>
      </section>

      <div class="sticky z-30 -mx-4 px-4 sm:mx-0 sm:px-0 pt-3 pb-2 bg-gradient-to-b from-[#0b0f17] via-[#0b0f17]/95 to-[#0b0f17]/0" style="top: calc(max(.75rem, env(safe-area-inset-top)) + 4.5rem)">
        <div class="flex gap-2">
          <div class="relative flex-1 min-w-0">
            <i data-lucide="search" class="pointer-events-none absolute z-10 left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500"></i>
            <input id="recipe-search" type="search" enterkeyhint="search" autocomplete="off" placeholder="Recette, ingrédient…" value="${esc(s.search)}"
              class="w-full glass-strong rounded-2xl pl-12 pr-4 py-3.5 text-base placeholder:text-slate-500 outline-none transition-all duration-300 focus:border-violet-400/60 focus:shadow-[0_0_0_4px_rgba(167,139,250,.15)]">
          </div>
          <button data-open="filters" class="press relative shrink-0 w-[52px] rounded-2xl glass-strong grid place-items-center" aria-label="Filtres">
            <i data-lucide="sliders-horizontal" class="w-5 h-5"></i>
            ${n ? `<span class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[11px] font-black grid place-items-center">${n}</span>` : ''}
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

  function recipeCard(r, i = 0) {
    const rank = RANKS[r.difficulty] || RANKS[3];
    const skills = Object.entries(r.skillRewards).sort((a, b) => b[1] - a[1]);
    return `
      <article class="recipe-card rise group glass rounded-3xl overflow-hidden flex flex-col press cursor-pointer" data-recipe="${r.id}" style="animation-delay:${Math.min(i, 8) * 0.035}s">
        <div class="relative">
          ${recipeVisual(r)}
          <span class="absolute top-2 right-2 w-8 h-8 rounded-xl bg-gradient-to-br ${rank.cls} grid place-items-center text-sm font-black shadow-lg" title="Rang de difficulté">${rank.label}</span>
          ${r.cookedCount ? `<span class="absolute top-2 left-2 inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold glass-strong text-emerald-300"><i data-lucide="check" class="w-3 h-3"></i>${r.cookedCount}</span>` : ''}
          <span class="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold glass-strong"><i data-lucide="clock" class="w-3 h-3 text-cyan-300"></i>${r.timeMinutes >= 90 ? `${Math.floor(r.timeMinutes / 60)}h${String(r.timeMinutes % 60).padStart(2, '0')}` : `${r.timeMinutes} min`}</span>
        </div>
        <div class="p-3 pt-2.5 flex flex-col gap-2 flex-1">
          <h3 class="text-[14px] sm:text-[15px] font-bold tracking-tight leading-snug line-clamp-2">${esc(r.name)}</h3>
          <div class="mt-auto flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="flex -space-x-1">${skills.slice(0, 4).map(([k]) => `<span class="w-5 h-5 rounded-full bg-gradient-to-br ${SKILL_META[k].grad} ring-2 ring-slate-900 grid place-items-center text-[10px]">${SKILL_META[k].emoji}</span>`).join('')}</div>
              <div class="text-xs mt-1"><span class="font-extrabold text-violet-300 tabular-nums">${fmt(r.totalXp)}</span> <span class="text-slate-500 font-semibold">XP</span></div>
            </div>
            <button data-cook="${r.id}" class="cook-btn press shrink-0 w-11 h-11 rounded-2xl grid place-items-center text-white bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-[0_0_18px_rgba(192,132,252,.5)] disabled:opacity-60" aria-label="Cuisiner ${esc(r.name)}">
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
    if (loading && s.items.length) more.innerHTML = '<div class="flex items-center gap-2 text-slate-400 text-sm font-semibold"><i data-lucide="loader-circle" class="w-4 h-4 animate-spin"></i>Chargement…</div>';
    else if (s.page < s.totalPages && s.items.length) more.innerHTML = '<button id="load-more" class="press glass rounded-xl px-5 py-3 text-sm font-bold">Charger plus de quêtes</button>';
    else if (s.items.length) more.innerHTML = '<p class="text-[11px] text-slate-600 font-bold uppercase tracking-widest">— Fin du tableau —</p>';
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
        <h2 class="text-xl font-extrabold tracking-tight">Filtres</h2>
        <h3 class="mt-4 text-xs font-bold uppercase tracking-widest text-slate-500">Compétence principale</h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
          ${SKILLS.map((k) => { const m = SKILL_META[k]; const on = draft.skill === k; return `
            <button data-f-skill="${k}" class="press flex items-center gap-2 rounded-2xl px-3 py-3 border font-bold text-sm ${on ? `border-transparent bg-gradient-to-r ${m.grad} text-slate-950` : 'border-slate-800 bg-slate-900/60 text-slate-300'}">${m.emoji} ${m.name}</button>`; }).join('')}
        </div>
        <h3 class="mt-5 text-xs font-bold uppercase tracking-widest text-slate-500">Trier par</h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
          ${SORTS.map(([v, l]) => `<button data-f-sort="${v}" class="press rounded-2xl px-3 py-3 border font-bold text-sm ${draft.sort === v ? 'border-violet-400/60 bg-violet-500/15 text-violet-100' : 'border-slate-800 bg-slate-900/60 text-slate-300'}">${l}</button>`).join('')}
        </div>
        <div class="mt-6 grid grid-cols-3 gap-2">
          <button data-f-reset class="press rounded-2xl py-4 font-bold bg-slate-800 border border-slate-700">Réinitialiser</button>
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
          <div class="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-200/90">
            <span class="w-6 h-6 rounded-lg bg-gradient-to-br ${rank.cls} grid place-items-center text-[11px] font-black">${rank.label}</span>
            ${esc(r.category)} · ${r.timeMinutes} min
          </div>
          <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1.5 drop-shadow">${esc(r.name)}</h2>
        </div>
      </div>
      <div class="p-5 space-y-6">
        <div>
          <p class="text-slate-400 text-sm">${esc(r.description)}</p>
          ${r.imageSource ? `<a href="${esc(r.imageSource)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-slate-500 underline decoration-dotted"><i data-lucide="camera" class="w-3 h-3"></i>Photo : Wikipédia / Wikimedia Commons</a>` : ''}
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-slate-500 mb-2">Récompenses</h3>
          <div class="flex flex-wrap gap-2">${Object.entries(r.skillRewards).map(([k, v]) => skillPill(k, v, 'md')).join('')}</div>
          ${r.cookedCount ? `<p class="text-xs text-amber-300/80 mt-2 font-semibold">Déjà cuisinée ${r.cookedCount}× — XP réduite à ${Math.round(Math.max(0.4, 1 - r.cookedCount * 0.2) * 100)} %.</p>` : ''}
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-slate-500 mb-2">Ingrédients · ${r.ingredients.length}</h3>
          <ul class="rounded-2xl bg-slate-950/50 border border-slate-800 divide-y divide-slate-800/80">${r.ingredients.map((g) => `
            <li class="flex justify-between gap-3 px-4 py-2.5 text-sm"><span>${esc(g.name)}</span><span class="text-slate-400 text-right font-semibold">${esc(g.measure)}</span></li>`).join('')}</ul>
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-widest font-bold text-slate-500 mb-2">Étapes</h3>
          <ol class="space-y-3">${steps.map((st, i) => `
            <li class="flex gap-3"><span class="shrink-0 w-7 h-7 rounded-lg bg-violet-500/20 text-violet-300 text-xs font-extrabold grid place-items-center">${i + 1}</span><span class="text-[15px] text-slate-200 leading-relaxed pt-0.5">${esc(st)}</span></li>`).join('')}</ol>
        </div>
      </div>
      <div class="sticky bottom-0 p-4 pb-safe bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent">
        <button data-cook="${r.id}" class="cook-btn ${primaryBtn}"><i data-lucide="chef-hat" class="w-5 h-5"></i>J'ai cuisiné cette recette !</button>
      </div>`, { flush: true });
    sheet.addEventListener('click', (e) => { const c = e.target.closest('[data-cook]'); if (c) cookRecipe(c); });
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
      <div class="sheet-overlay fixed inset-0 z-[80] bg-slate-950/70 backdrop-blur-sm fade-in"></div>
      <div class="sheet fixed z-[81] inset-x-0 bottom-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[640px] max-h-[92dvh] sm:max-h-[86vh] flex flex-col glass-strong rounded-t-[28px] sm:rounded-[28px] shadow-2xl sheet-up overflow-hidden">
        <div class="sheet-handle relative z-20 shrink-0 flex justify-center pt-3 pb-2 cursor-grab ${flush ? '' : ''}"><span class="w-11 h-1.5 rounded-full bg-slate-600/80"></span></div>
        <button data-close-sheet class="press absolute z-20 top-3 right-3 w-9 h-9 rounded-full glass-strong grid place-items-center" aria-label="Fermer"><i data-lucide="x" class="w-4 h-4"></i></button>
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
    root.innerHTML = `<div class="modal fixed inset-0 z-[90] grid place-items-center p-4 bg-slate-950/80 backdrop-blur-sm fade-in overflow-y-auto">${html}</div>`;
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
      <div class="holo-border modal-in w-full max-w-md rounded-[28px] my-auto">
        <div class="shine glass-strong rounded-[28px] p-6 text-center relative overflow-hidden">
          <div class="absolute inset-x-0 -top-24 h-56 bg-gradient-to-b ${lvlUp ? 'from-amber-400/30' : 'from-violet-500/30'} to-transparent blur-2xl pointer-events-none"></div>
          <div class="relative">
            <div class="pop mx-auto w-24 h-24 rounded-3xl overflow-hidden grid place-items-center text-5xl bg-gradient-to-br ${lvlUp ? 'from-amber-300 to-orange-500' : 'from-violet-500 to-fuchsia-500'} shadow-[0_0_40px_rgba(217,70,239,.6)] ring-4 ring-white/10">${hero}</div>
            <p class="mt-5 text-[11px] font-bold uppercase tracking-[.25em] ${lvlUp ? 'text-amber-300' : 'text-violet-300'} line-clamp-1">${esc(kind === 'recipe' ? result.recipe?.name : result.task?.title)}</p>
            <h2 class="pop mt-1 ${heading.length > 12 ? 'text-[30px]' : 'text-4xl'} sm:text-5xl whitespace-nowrap font-black tracking-tight bg-gradient-to-r ${lvlUp ? 'from-amber-200 via-yellow-300 to-orange-400' : 'from-violet-200 via-fuchsia-300 to-cyan-300'} bg-clip-text text-transparent" style="animation-delay:.1s;filter:drop-shadow(0 0 18px ${lvlUp ? 'rgba(251,191,36,.55)' : 'rgba(192,132,252,.55)'})">${heading}</h2>
            ${lvlUp ? `
              <div class="pop mt-3 flex items-center justify-center gap-3" style="animation-delay:.25s">
                <span class="text-2xl font-extrabold text-slate-500">${lvlUp.from}</span><i data-lucide="chevrons-right" class="w-6 h-6 text-amber-300"></i>
                <span class="text-5xl font-black text-amber-300" style="text-shadow:0 0 24px rgba(251,191,36,.8)">${lvlUp.to}</span>
              </div>
              ${lvlUp.newTitle ? `<p class="mt-1 text-sm font-semibold text-amber-200/90">Nouveau titre débloqué : ${esc(lvlUp.newTitle)}</p>` : ''}` : ''}
            <div class="mt-4 text-5xl font-black tabular-nums text-white">+<span id="xp-count">0</span> <span class="text-2xl text-violet-300">XP</span></div>
            ${result.classBonus ? `<p class="text-xs text-amber-300 mt-1 font-bold">Bonus de classe ${SKILL_META[result.classBonus.skill].emoji} +${result.classBonus.xp} XP</p>` : ''}
            ${result.multiplier && result.multiplier < 1 ? `<p class="text-xs text-slate-500 mt-1 font-semibold">Recette déjà maîtrisée · XP ×${result.multiplier.toFixed(1)}</p>` : ''}
            <div class="mt-5 space-y-2.5 text-left">
              ${Object.entries(result.rewards).map(([k, v], i) => {
                const m = SKILL_META[k]; const sp = p.skills.find((s) => s.skill === k); const up = skillUps[k];
                return `<div class="rise rounded-2xl bg-slate-950/50 border ${up ? 'border-amber-400/40' : 'border-slate-800'} p-3" style="animation-delay:${0.3 + i * 0.08}s">
                  <div class="flex items-center gap-2.5 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-gradient-to-br ${m.grad} grid place-items-center text-slate-950"><i data-lucide="${m.icon}" class="w-4 h-4"></i></span>
                    <span class="flex-1 min-w-0 font-bold text-sm truncate">${m.name} <span class="text-slate-500 font-semibold">· ${sp.level}</span></span>
                    ${up ? '<span class="rounded-full px-2 py-0.5 text-[10px] font-black bg-gradient-to-r from-amber-300 to-orange-500 text-amber-950 shadow-[0_0_12px_rgba(251,191,36,.7)]">UP !</span>' : ''}
                    <span class="text-sm font-extrabold ${m.text} tabular-nums">+${v}</span>
                  </div>
                  ${glowBar(sp.percent, m.grad, m.glow, 'h-2')}
                </div>`;
              }).join('')}
            </div>
            ${result.streakIncreased ? `<div class="rise mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-orange-400/40 text-sm font-bold text-amber-200" style="animation-delay:.6s"><span class="flame">🔥</span>Série : ${result.streak} jour${result.streak > 1 ? 's' : ''} !</div>` : ''}
            <button data-close class="press mt-6 w-full rounded-2xl py-4 font-extrabold text-white bg-gradient-to-r ${lvlUp ? 'from-amber-400 to-orange-500 shadow-[0_0_24px_rgba(251,146,60,.55)]' : 'from-violet-500 to-fuchsia-500 shadow-[0_0_24px_rgba(192,132,252,.5)]'}">Continuer l'aventure</button>
          </div>
        </div>
      </div>`, { onClose: () => { if (state.tab === 'profile') renderProfile(); } });

    countUp($('#xp-count'), result.xpGained);
    animateBars($('#modal-root'));
    haptic(isEpic ? [30, 40, 30] : 20);
    if (isEpic) fx.fireworks(lvlUp ? 3000 : 1800); else fx.burst();
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
    if (open) { if (open.dataset.open === 'account') openAccount(); if (open.dataset.open === 'filters') openFilters(); return; }
    const cook = t.closest('[data-cook]');
    if (cook) { e.stopPropagation(); cookRecipe(cook); return; }
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
    screen.innerHTML = '<div class="min-h-[100dvh] grid place-items-center"><div class="w-20 h-20 rounded-[24px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 grid place-items-center text-4xl float-y shadow-2xl">🍳</div></div>';
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
