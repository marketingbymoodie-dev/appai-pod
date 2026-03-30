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
  var CART_GUARD_VERSION = '1.1';
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
  var isRelevantPage = path.indexOf("/products/") !== -1 ||
    path.indexOf("/products_preview") !== -1 ||
    path === "/cart" ||
    path.indexOf("/cart/") === 0 ||
    !!document.querySelector('form[action^="/cart/add"]');

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

      if (!target._image) target._image = latest._mockup_url;
      if (!target.image) target.image = latest._mockup_url;
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

  console.log(LOG_PREFIX, 'Loaded. version=' + CART_GUARD_VERSION + ' isRelevantPage=' + isRelevantPage);
})();
