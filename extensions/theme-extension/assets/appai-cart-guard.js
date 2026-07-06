/* AppAI Cart Guard – inject latest generation properties into ALL add-to-cart paths.
   - Keeps hidden inputs in /cart/add forms up to date (non-AJAX fallback)
   - Intercepts fetch + XHR to /cart/add.js and injects properties if missing
   - Provides window.AppAI.setLatestDesign(...) for your studio to call
   - Provides window.AppAI.verify() to test in console
*/
;(function() {
  "use strict";

  if (window.__APPAI_CART_GUARD_PATCHED__) return;
  window.__APPAI_CART_GUARD_PATCHED__ = true;

  var NS = (window.AppAI = window.AppAI || {});
  NS.latest = NS.latest || null;

  var LOG_PREFIX = "[AppAI Cart Guard]";
  var CART_GUARD_VERSION = '1.5';
  var HIDDEN_CART_PROP_KEYS = [
    '_appai_job_id',
    '_artwork_url',
    '_mockup_url',
    '_design_id',
  ];
  /* DEBUG MARKERS (search these in DevTools console to diagnose issues):
     [AppAI Cart Guard] Loaded                        → script running (set ENABLE_DEBUG=true to see all logs)
     [AppAI Cart Guard] Ignored setLatestDesign       → payload missing _mockup_url; check embed-design.tsx handleAddToCart
     [AppAI Cart Guard] Latest set:                   → design registered OK; _mockup_url should be a valid URL
     [AppAI Cart Guard] fetch patch error:            → error injecting props into fetch /cart/add.js body
     [AppAI Cart Guard] xhr patch error:              → error injecting props into XHR /cart/add.js body
  */
  var ENABLE_DEBUG = false; // set to true temporarily to see verbose logs
  function debug() {
    if (ENABLE_DEBUG) console.log.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
  }

  // --------- Public API ----------
  NS.setLatestDesign = function setLatestDesign(payload) {
    var latest = normalizePayload(payload);
    if (!latest || !latest._mockup_url) {
      console.warn(LOG_PREFIX, 'Ignored setLatestDesign payload (missing _mockup_url):', payload);
      return;
    }
    NS.latest = latest;
    syncHiddenInputsIntoAllProductForms(latest);
    debug("Latest set:", latest);
  };

  window.addEventListener("message", function(e) {
    try {
      var d = e && e.data;
      if (!d) return;
      if (d.type === "APPAI_DESIGN_UPDATED" || d.type === "APPAI_SET_LATEST" || d.app === "AppAI") {
        NS.setLatestDesign(d);
      }
    } catch (_) {}
  });

  // --------- Form hidden inputs (non-AJAX add-to-cart) ----------
  function syncHiddenInputsIntoAllProductForms(latest) {
    var forms = document.querySelectorAll('form[action^="/cart/add"]');
    for (var i = 0; i < forms.length; i++) {
      upsertPropInput(forms[i], "_design_id", latest._design_id);
      upsertPropInput(forms[i], "_mockup_url", latest._mockup_url);
      upsertPropInput(forms[i], "_artwork_url", latest._artwork_url);
    }
  }

  function upsertPropInput(form, key, value) {
    if (!value) return;
    var name = "properties[" + key + "]";
    var escapedName = name.replace(/"/g, '\\"');
    var input = form.querySelector('input[name="' + escapedName + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = String(value);
  }

  // --------- Product-page guard ----------
  // Only patch fetch/XHR/forms on pages that could add to cart.
  var path = window.location.pathname;
  var isCartPage = path === "/cart" || path.indexOf("/cart/") === 0;
  var isRelevantPage = path.indexOf("/products/") !== -1 ||
    path.indexOf("/products_preview") !== -1 ||
    isCartPage ||
    !!document.querySelector('form[action^="/cart/add"]');

  // Cart property hiding runs even when interceptors are skipped (see bottom).
  setupCartPropertyHiding();

  if (!isRelevantPage) {
    debug("Not a product/cart page, skipping interceptors. Path:", path);
    return;
  }

  // --------- Intercept fetch to /cart/add.js ----------
  var origFetchGuard = window.fetch;
  if (typeof origFetchGuard === "function") {
    window.fetch = function patchedFetch(input, init) {
      init = init || {};
      var url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      } catch (_) {}

      if (url && isCartAddJs(url)) {
        try { init = injectAppAIPropsIntoRequestInit(init); } catch (e) { debug("fetch patch error:", e); }

        var result = origFetchGuard.call(this, input, init);
        result.then(function() {
          try { window.dispatchEvent(new Event("appai:cart-updated")); } catch(_) {}
        }).catch(function() {});
        return result;
      }

      return origFetchGuard.call(this, input, init);
    };
  }

  function mergePropsOnto(target, latest) {
    if (latest && latest._mockup_url) {
      if (!target._mockup_url) target._mockup_url = latest._mockup_url;
      if (!target._artwork_url && latest._artwork_url) target._artwork_url = latest._artwork_url;
      if (!target._design_id && latest._design_id) target._design_id = latest._design_id;
    }
  }

  function injectPropsIntoJsonObj(obj, latest) {
    if (Array.isArray(obj.items)) {
      for (var i = 0; i < obj.items.length; i++) {
        var item = obj.items[i];
        if (!item || typeof item !== "object") continue;
        item.properties = item.properties || {};
        mergePropsOnto(item.properties, latest);
      }
    } else {
      obj.properties = obj.properties || {};
      mergePropsOnto(obj.properties, latest);
    }
  }

  function injectAppAIPropsIntoRequestInit(init) {
    var latest = NS.latest;
    if (!latest || !latest._mockup_url) return init;

    var nextInit = {};
    for (var k in init) { nextInit[k] = init[k]; }
    var headers = (typeof Headers !== "undefined" && init.headers instanceof Headers)
      ? init.headers
      : new Headers(nextInit.headers || {});
    var contentType = "";
    try { contentType = (headers.get("content-type") || "").toLowerCase(); } catch(_) {}
    var body = nextInit.body;

    // JSON body
    if (body && contentType.indexOf("application/json") !== -1) {
      try {
        var obj = typeof body === "string" ? JSON.parse(body) : body;
        if (obj && typeof obj === "object") {
          injectPropsIntoJsonObj(obj, latest);
          nextInit.body = JSON.stringify(obj);
          nextInit.headers = headers;
          return nextInit;
        }
      } catch (_) {
        return nextInit;
      }
    }

    // FormData body
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      if (!body.has("properties[_mockup_url]")) {
        body.set("properties[_design_id]", latest._design_id || "");
        body.set("properties[_mockup_url]", latest._mockup_url || "");
        body.set("properties[_artwork_url]", latest._artwork_url || "");
      }
      nextInit.body = body;
      nextInit.headers = headers;
      return nextInit;
    }

    // URLSearchParams or string body
    if (typeof body === "string") {
      var p = new URLSearchParams(body);
      if (!p.has("properties[_mockup_url]")) {
        p.set("properties[_design_id]", latest._design_id || "");
        p.set("properties[_mockup_url]", latest._mockup_url || "");
        p.set("properties[_artwork_url]", latest._artwork_url || "");
        nextInit.body = p.toString();
        if (!contentType) headers.set("content-type", "application/x-www-form-urlencoded; charset=UTF-8");
        nextInit.headers = headers;
      }
      return nextInit;
    }

    nextInit.headers = headers;
    return nextInit;
  }

  // --------- Intercept XHR to /cart/add.js ----------
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpenGuard = XHR.prototype.open;
    var origSendGuard = XHR.prototype.send;

    XHR.prototype.open = function patchedOpen(method, url) {
      try {
        this.__appai_isCartAdd = typeof url === "string" && isCartAddJs(url);
      } catch (_) {
        this.__appai_isCartAdd = false;
      }
      return origOpenGuard.apply(this, arguments);
    };

    XHR.prototype.send = function patchedSend(body) {
      try {
        if (this.__appai_isCartAdd) {
          body = injectIntoXHRBody(body);
        }
      } catch (e) {
        debug("xhr patch error:", e);
      }
      return origSendGuard.call(this, body);
    };
  }

  function injectIntoXHRBody(body) {
    var latest = NS.latest;
    if (!latest || !latest._mockup_url) return body;

    if (typeof body === "string") {
      try {
        var obj = JSON.parse(body);
        if (obj && typeof obj === "object") {
          injectPropsIntoJsonObj(obj, latest);
          return JSON.stringify(obj);
        }
      } catch(_) {}
      var params = new URLSearchParams(body);
      if (!params.has("properties[_mockup_url]")) {
        params.set("properties[_design_id]", latest._design_id || "");
        params.set("properties[_mockup_url]", latest._mockup_url || "");
        params.set("properties[_artwork_url]", latest._artwork_url || "");
        return params.toString();
      }
      return body;
    }

    if (typeof FormData !== "undefined" && body instanceof FormData) {
      if (!body.has("properties[_mockup_url]")) {
        body.set("properties[_design_id]", latest._design_id || "");
        body.set("properties[_mockup_url]", latest._mockup_url || "");
        body.set("properties[_artwork_url]", latest._artwork_url || "");
      }
      return body;
    }

    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      if (!body.has("properties[_mockup_url]")) {
        body.set("properties[_design_id]", latest._design_id || "");
        body.set("properties[_mockup_url]", latest._mockup_url || "");
        body.set("properties[_artwork_url]", latest._artwork_url || "");
      }
      return body;
    }

    return body;
  }

  // --------- Form submit interceptor (native forms) ----------
  document.addEventListener("submit", function(e) {
    try {
      var form = e.target;
      if (!form || !form.action) return;
      if (!/\/cart\/add(\.js)?(\?|$)/.test(form.action)) return;
      var latest = NS.latest;
      if (!latest || !latest._mockup_url) return;
      upsertPropInput(form, "_design_id", latest._design_id);
      upsertPropInput(form, "_mockup_url", latest._mockup_url);
      upsertPropInput(form, "_artwork_url", latest._artwork_url);
    } catch (_) {}
  }, true);

  function isCartAddJs(url) {
    try {
      var u = new URL(url, window.location.origin);
      return u.pathname === "/cart/add.js" || u.pathname === "/cart/add";
    } catch (_) {
      return String(url).indexOf("/cart/add") !== -1;
    }
  }

  function normalizePayload(payload) {
    if (!payload || typeof payload !== "object") return null;

    var src = payload.detail || payload.data || payload;

    var _design_id = src._design_id || src.design_id || src.designId || null;
    var _mockup_url = src._mockup_url || src.mockup_url || src.mockupUrl || null;
    var _artwork_url = src._artwork_url || src.artwork_url || src.artworkUrl || null;
    var _shop = src._shop || src.shop || null;
    var _product_id = src._product_id || src.productId || null;
    var _app_url = src._app_url || src.appUrl || null;

    // Preserve existing values for shop/productId/appUrl when new payload omits them
    var existing = NS.latest || {};

    return {
      _design_id: _design_id ? String(_design_id) : "",
      _mockup_url: _mockup_url ? String(_mockup_url) : "",
      _artwork_url: _artwork_url ? String(_artwork_url) : "",
      _shop: _shop ? String(_shop) : (existing._shop || ""),
      _product_id: _product_id ? String(_product_id) : (existing._product_id || ""),
      _app_url: _app_url ? String(_app_url) : (existing._app_url || ""),
      _ts: Date.now()
    };
  }

  // --------- Console verification helper ----------
  NS.verify = function verifyAppAI() {
    var latest = NS.latest;
    var forms = document.querySelectorAll('form[action^="/cart/add"]');
    var formHas = false;
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].querySelector('input[name="properties[_mockup_url]"]')) { formHas = true; break; }
    }

    return {
      latest: latest,
      formsFound: forms.length,
      anyFormHasMockupHiddenInput: formHas,
      fetchPatched: typeof origFetchGuard === "function" && window.fetch !== origFetchGuard,
      xhrPatched: typeof origOpenGuard === "function" && typeof origSendGuard === "function",
      hint: "Test: call AppAI.setLatestDesign({_design_id:'x', _mockup_url:'https://...', _artwork_url:'https://...'}) then click Add to cart; Network /cart/add.js should include properties[_mockup_url]."
    };
  };

  if (NS.latest && NS.latest._mockup_url) {
    syncHiddenInputsIntoAllProductForms(NS.latest);
  }

  // --------- Hide internal line properties on cart page ----------
  // Shopify hides underscore props at checkout, but many themes still render them on /cart.
  // Modern themes (Dawn, Horizon, etc.) render <cart-items> inside shadow DOM — plain
  // document.querySelectorAll misses those nodes, which is why props were still visible.
  function isHiddenCartPropLabel(text) {
    if (!text) return false;
    var t = String(text).trim().replace(/:$/, '').toLowerCase();
    for (var i = 0; i < HIDDEN_CART_PROP_KEYS.length; i++) {
      if (t === HIDDEN_CART_PROP_KEYS[i]) return true;
    }
    return t.charAt(0) === '_';
  }

  function hideCartPropertyRow(el) {
    if (!el || el.getAttribute('data-appai-hidden-prop') === '1') return;
    el.setAttribute('data-appai-hidden-prop', '1');
    el.style.setProperty('display', 'none', 'important');
  }

  function collectElementTrees(root, out) {
    if (!root || root.nodeType !== 1) return;
    out.push(root);
    if (root.shadowRoot) collectElementTrees(root.shadowRoot, out);
    var kids = root.children || [];
    for (var i = 0; i < kids.length; i++) collectElementTrees(kids[i], out);
  }

  function deepCollectElements(start) {
    var out = [];
    collectElementTrees(start, out);
    return out;
  }

  function propertyLabelFromText(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return '';
    var colon = trimmed.indexOf(':');
    if (colon > 0 && colon < 40) return trimmed.slice(0, colon).trim();
    return trimmed.replace(/:$/, '').trim();
  }

  function textLooksLikeHiddenCartProp(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (isHiddenCartPropLabel(propertyLabelFromText(trimmed))) return true;
    for (var i = 0; i < HIDDEN_CART_PROP_KEYS.length; i++) {
      var key = HIDDEN_CART_PROP_KEYS[i];
      if (trimmed.indexOf(key + ':') === 0 || trimmed.indexOf(key + ' :') === 0) return true;
    }
    return trimmed.charAt(0) === '_' && /^_[\w-]+:\s/.test(trimmed);
  }

  function hideHiddenPropRowFrom(el) {
    if (!el) return;
    hideCartPropertyRow(el);
    var row = el.closest('.product-option, .cart-item__property, [class*="property"], li, tr, dl, p, dd, dt');
    if (row) hideCartPropertyRow(row);
    var parent = el.parentElement;
    if (parent && parent !== document.body && parent.children.length <= 4) hideCartPropertyRow(parent);
    var next = el.nextElementSibling;
    if (next) hideCartPropertyRow(next);
  }

  function hideInternalCartProperties() {
    if (!isCartPage) return;

    var scopes = [];
    var scopeSelectors = [
      'form[action="/cart"]',
      'form[action^="/cart"]',
      'cart-items',
      '.cart-items',
      '#main-cart-items',
      'main'
    ];
    for (var s = 0; s < scopeSelectors.length; s++) {
      var nodes = document.querySelectorAll(scopeSelectors[s]);
      for (var n = 0; n < nodes.length; n++) scopes.push(nodes[n]);
    }
    if (!scopes.length) scopes = [document.body];

    for (var si = 0; si < scopes.length; si++) {
      var elements = deepCollectElements(scopes[si]);
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.getAttribute('data-appai-hidden-prop') === '1') continue;

        var tag = el.tagName;
        if (tag === 'DT' || tag === 'DD') {
          if (isHiddenCartPropLabel(el.textContent)) hideHiddenPropRowFrom(el);
          continue;
        }

        if (el.classList && (el.classList.contains('product-option') || String(el.className || '').indexOf('property') !== -1)) {
          var label = el.querySelector('dt, .product-option__name, .caption-with-letter-spacing, [class*="property"] > :first-child');
          if (label && isHiddenCartPropLabel(label.textContent)) hideHiddenPropRowFrom(el);
        }

        var text = (el.textContent || '').trim();
        if (!text || text.length > 400) continue;
        if (el.children.length > 5) continue;

        if (textLooksLikeHiddenCartProp(text)) {
          hideHiddenPropRowFrom(el);
          continue;
        }

        if (el.children.length <= 2) {
          var first = el.firstElementChild;
          if (first && isHiddenCartPropLabel(first.textContent)) hideHiddenPropRowFrom(el);
        }
      }
    }
  }

  var observedShadowRoots = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function observeShadowRoot(root, onChange) {
    if (!root || typeof MutationObserver === 'undefined') return;
    if (observedShadowRoots && observedShadowRoots.has(root)) return;
    if (observedShadowRoots) observedShadowRoots.add(root);
    try {
      var obs = new MutationObserver(onChange);
      obs.observe(root, { childList: true, subtree: true });
    } catch (_) {}
  }

  function observeAllShadowRoots(onChange) {
    observeShadowRoot(document.documentElement, onChange);
    var all = deepCollectElements(document.documentElement);
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) observeShadowRoot(all[i].shadowRoot, onChange);
    }
  }

  function setupCartPropertyHiding() {
    if (!isCartPage) return;

    NS.hideInternalCartProperties = hideInternalCartProperties;

    hideInternalCartProperties();
    window.addEventListener('appai:cart-updated', hideInternalCartProperties);
    window.addEventListener('pageshow', hideInternalCartProperties);

    if (typeof MutationObserver !== 'undefined') {
      var rerun = function() { hideInternalCartProperties(); };
      observeAllShadowRoots(rerun);
      window.setInterval(function() {
        observeAllShadowRoots(rerun);
        hideInternalCartProperties();
      }, 800);
    }
  }

  console.log(LOG_PREFIX, 'Loaded. version=' + CART_GUARD_VERSION + ' isRelevantPage=' + isRelevantPage);
})();
