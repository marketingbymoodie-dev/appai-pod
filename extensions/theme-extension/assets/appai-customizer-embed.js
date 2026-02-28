/**
 * AppAI Customizer Embed — Redirect-only stub
 * ─────────────────────────────────────────────────────────────────────────
 * All rendering is handled by ai-art-embed.liquid (the primary embed).
 * This script only redirects disabled customizer pages to the fallback URL.
 *
 * It NEVER mounts any UI — the primary embed owns all DOM rendering.
 */
;(function () {
  'use strict';

  if (window.__APPAI_CUSTOMIZER_EMBED__) return;
  window.__APPAI_CUSTOMIZER_EMBED__ = true;

  // If the primary embed already ran, there's nothing for us to do.
  if (window.__APPAI_CUSTOMIZER_INIT__ || window.__APPAI_CUSTOMIZER_HANDLED) {
    return;
  }

  var PROXY = '/apps/appai';

  function getCurrentHandle() {
    var m = window.location.pathname.match(/^\/pages\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  async function checkDisabledRedirect() {
    var handle = getCurrentHandle();
    if (!handle) return;

    // Final guard: if the primary embed activated while we waited for DOM ready
    if (window.__APPAI_CUSTOMIZER_INIT__ || window.__APPAI_CUSTOMIZER_HANDLED) return;

    try {
      var res = await fetch(PROXY + '/customizer-pages', { credentials: 'same-origin' });
      if (!res.ok) return;
      var data = await res.json();
      var pages = data.pages || [];
      var fallbackUrl = data.fallbackUrl || '/';

      var page = null;
      for (var i = 0; i < pages.length; i++) {
        if (pages[i].handle === handle) { page = pages[i]; break; }
      }

      // Only act if the page is explicitly disabled — redirect to the fallback hub.
      // Active pages are handled by ai-art-embed.liquid; unknown handles are left alone.
      if (page && page.status !== 'active') {
        console.log('[AppAI Embed] Page "' + handle + '" is disabled, redirecting to', fallbackUrl);
        window.location.replace(fallbackUrl);
      }
    } catch (_) {
      // Silently ignore — the primary embed or the theme handles the page.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkDisabledRedirect);
  } else {
    checkDisabledRedirect();
  }
})();
