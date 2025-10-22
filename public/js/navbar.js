// Reusable navbar renderer for AI(ttention)
// Usage: call initNavbar({ active: 'summary' | 'checkbox' | 'mindmap' | 'prompts' | 'data' })
// Requires Tailwind + Lucide (icon CDN) already loaded on the page.

(function () {
  function modeItem({ href, icon, label, isActive }) {
    const base = 'mode-btn px-3 py-2 rounded text-sm font-medium transition-colors flex items-center justify-center';
    const active = 'bg-slate-100 text-black';
    const inactive = 'text-black hover:bg-slate-100';
    const cls = `${base} ${isActive ? active : inactive}`;
    const inner = `\n        <i data-lucide="${icon}" class="w-4 h-4 mr-2"></i>\n        <span class="truncate">${label}</span>\n    `;
    if (isActive) {
      // active is a button for current page
      return `<button class="${cls}" aria-current="page">${inner}</button>`;
    } else {
      return `<a class="${cls}" href="${href}">${inner}</a>`;
    }
  }

  function ensureBrandFont() {
    // Load Plus Jakarta Sans for brand text
    const existing = document.querySelector('link[data-brand-font="plus-jakarta"]');
    if (!existing) {
      const link = document.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('data-brand-font', 'plus-jakarta');
      link.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700&display=swap';
      document.head.appendChild(link);
    }
  }

  function renderNavbar(opts) {
    const options = Object.assign({ active: '', showModes: true }, opts || {});
    const container = document.getElementById('app-navbar');
    if (!container) return;
    ensureBrandFont();

    const modes = [
      { key: 'summary',  href: '/admin.html',    icon: 'message-square', label: 'Summary' },
      { key: 'checkbox', href: '/checkbox.html', icon: 'check-square',   label: 'Checkbox' },
      { key: 'mindmap',  href: '/mindmap.html',  icon: 'brain-circuit',  label: 'Mindmap' },
      { key: 'prompts',  href: '/prompts.html',  icon: 'file-text',      label: 'Prompts' },
      { key: 'data',     href: '/data.html',     icon: 'database',       label: 'Data' },
    ];

    const modesHtml = options.showModes
      ? `
        <div class="flex items-center space-x-3">
          <span class="text-sm text-black/80 hidden sm:inline">Modes:</span>
          <div class="flex bg-white rounded-lg p-1 space-x-1 border border-slate-200 shadow-sm">
            ${modes.map(m => modeItem({ href: m.href, icon: m.icon, label: m.label, isActive: m.key === options.active })).join('')}
          </div>
        </div>
      `
      : '';

    container.innerHTML = `
      <header class="gradient-bg text-black shadow-xl">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center space-x-3 sm:space-x-4 min-w-0">
              <div class="w-9 h-9 sm:w-10 sm:h-10 bg-white rounded-xl flex items-center justify-center backdrop-blur-sm border border-slate-200">
                <i data-lucide="graduation-cap" class="w-5 h-5 sm:w-6 sm:h-6 text-slate-700"></i>
              </div>
              <div class="min-w-0">
                <h1 class="text-2xl truncate" style="font-family: 'Plus Jakarta Sans', Inter, ui-sans-serif, system-ui, sans-serif; font-weight:700; letter-spacing:-0.02em; font-size:1.8rem;">AI(ttention)</h1>
              </div>
            </div>
            <div class="flex items-center gap-3">
              ${modesHtml}
              <button id="adminSignOutBtn" class="bg-white hover:bg-slate-50 text-black px-3 sm:px-4 py-2 rounded-lg transition-colors flex items-center text-sm border border-slate-200 shadow-sm">
                <i data-lucide="log-out" class="w-4 h-4 mr-2"></i>
                <span class="hidden sm:inline">Sign out</span>
                <span class="sm:hidden">Exit</span>
              </button>
            </div>
          </div>
        </div>
      </header>
    `;

    try { if (window.lucide) window.lucide.createIcons(); } catch (_) {}
  }

  // Public API
  window.initNavbar = renderNavbar;
})();
