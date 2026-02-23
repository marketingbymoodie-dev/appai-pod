/* AppAI Customizer
 * Handles the /pages/appai-customize page UI:
 *   1. Loads blank products from /api/storefront/blanks
 *   2. Lets customer pick a product + variant (size/color)
 *   3. Accepts prompt + style
 *   4. Creates a design via POST /api/storefront/customizer/designs
 *   5. Polls GET until READY
 *   6. Shows mockup carousel
 *   7. "Add to Cart" → calls /cart/add.js with all line item properties
 *   8. "Save Design" → shows confirmation + resume link (?design_id=...)
 *   9. Resume: if ?design_id=... in URL, loads that design
 */
;(function () {
  'use strict';

  var root = document.getElementById('appai-customizer-root');
  if (!root) return;

  // ─── Config ──────────────────────────────────────────────────────────────────
  var shop    = root.getAttribute('data-shop') || (window.Shopify && window.Shopify.shop) || window.location.hostname;
  var appUrl  = root.getAttribute('data-app-url') || '';
  var heading = root.closest('[data-block-id]')
    ? (root.closest('section') || root).querySelector('[data-heading]')?.textContent
    : '';

  // Detect app URL from environment if not set in block settings
  if (!appUrl) {
    // Assume same domain (app proxy) or try well-known location
    appUrl = '';
  }

  var API = appUrl; // base for API calls (empty string = same origin, only works if proxied)

  // ─── State ───────────────────────────────────────────────────────────────────
  var state = {
    blanks: [],
    selectedBlank: null,    // { productTypeId, name, variants, sizes, frameColors, ... }
    selectedVariant: null,  // { shopifyVariantId, sizeId, colorId, sizeLabel, colorLabel, price }
    prompt: '',
    stylePreset: '',
    designId: null,
    status: null,           // null | GENERATING | READY | FAILED
    artworkUrl: null,
    mockupUrl: null,
    mockupUrls: [],
    selectedMockupIndex: 0,
    pollingTimer: null,
    error: null,
    saved: false,
    addedToCart: false,
    loading: true,
  };

  // ─── CSS (injected once) ──────────────────────────────────────────────────────
  var STYLES = [
    '#appai-cust{box-sizing:border-box;max-width:900px;margin:0 auto;padding:32px 16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;}',
    '#appai-cust *{box-sizing:border-box;}',
    '#appai-cust h1{font-size:clamp(22px,4vw,32px);font-weight:700;margin:0 0 8px;letter-spacing:-0.02em;}',
    '#appai-cust .sub{font-size:15px;color:#555;margin:0 0 32px;line-height:1.5;}',
    /* Steps */
    '#appai-cust .step{margin-bottom:28px;}',
    '#appai-cust .step-title{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:0 0 10px;}',
    /* Product grid */
    '#appai-cust .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;}',
    '#appai-cust .product-card{border:2px solid #e5e5e5;border-radius:10px;padding:12px;cursor:pointer;transition:border-color .15s,box-shadow .15s;text-align:center;background:#fafafa;}',
    '#appai-cust .product-card:hover{border-color:#aaa;box-shadow:0 2px 8px rgba(0,0,0,.07);}',
    '#appai-cust .product-card.selected{border-color:#111;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.1);}',
    '#appai-cust .product-card img{width:80px;height:80px;object-fit:contain;border-radius:6px;margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;}',
    '#appai-cust .product-card .card-name{font-size:13px;font-weight:600;line-height:1.3;}',
    /* Variant selectors */
    '#appai-cust .option-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}',
    '#appai-cust .opt-btn{padding:6px 14px;border:1.5px solid #e0e0e0;border-radius:20px;font-size:13px;cursor:pointer;background:#fff;transition:border-color .15s,background .15s;white-space:nowrap;}',
    '#appai-cust .opt-btn:hover{border-color:#999;}',
    '#appai-cust .opt-btn.selected{border-color:#111;background:#111;color:#fff;}',
    /* Prompt area */
    '#appai-cust textarea{width:100%;padding:12px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:15px;font-family:inherit;resize:vertical;min-height:80px;outline:none;transition:border-color .15s;line-height:1.5;}',
    '#appai-cust textarea:focus{border-color:#111;}',
    '#appai-cust select{width:100%;padding:10px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;background:#fff;cursor:pointer;outline:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\'%3E%3Cpath fill=\'%23555\' d=\'M6 8L1 3h10z\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;}',
    '#appai-cust select:focus{border-color:#111;}',
    /* Generate button */
    '#appai-cust .btn-generate{display:block;width:100%;padding:15px 20px;background:#111;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s;letter-spacing:.01em;margin-top:20px;}',
    '#appai-cust .btn-generate:disabled{opacity:.45;cursor:not-allowed;}',
    '#appai-cust .btn-generate:hover:not(:disabled){opacity:.85;}',
    /* Spinner */
    '@keyframes appai-spin{to{transform:rotate(360deg)}}',
    '#appai-cust .spinner{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:appai-spin .7s linear infinite;vertical-align:middle;margin-right:8px;}',
    /* Skeleton */
    '@keyframes appai-shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}',
    '#appai-cust .skeleton{background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:800px 100%;animation:appai-shimmer 1.4s infinite linear;border-radius:6px;}',
    /* Preview */
    '#appai-cust .preview-wrap{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start;}',
    '@media(max-width:600px){#appai-cust .preview-wrap{grid-template-columns:1fr;}}',
    '#appai-cust .main-preview{border-radius:10px;overflow:hidden;background:#f5f5f5;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;position:relative;}',
    '#appai-cust .main-preview img{width:100%;height:100%;object-fit:contain;}',
    '#appai-cust .thumbs{display:flex;flex-direction:column;gap:8px;width:72px;}',
    '@media(max-width:600px){#appai-cust .thumbs{flex-direction:row;width:auto;}}',
    '#appai-cust .thumb{width:72px;height:72px;border:2px solid #e0e0e0;border-radius:6px;overflow:hidden;cursor:pointer;flex-shrink:0;}',
    '#appai-cust .thumb.active{border-color:#111;}',
    '#appai-cust .thumb img{width:100%;height:100%;object-fit:cover;}',
    /* CTA buttons */
    '#appai-cust .cta-row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap;}',
    '#appai-cust .btn-atc{flex:1;min-width:160px;padding:15px 20px;background:#111;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s;}',
    '#appai-cust .btn-atc:disabled{opacity:.45;cursor:not-allowed;}',
    '#appai-cust .btn-atc:hover:not(:disabled){opacity:.85;}',
    '#appai-cust .btn-save{flex:1;min-width:160px;padding:15px 20px;background:#fff;color:#111;border:1.5px solid #111;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s;}',
    '#appai-cust .btn-save:hover:not(:disabled){background:#f5f5f5;}',
    /* Alerts */
    '#appai-cust .alert{padding:12px 16px;border-radius:8px;font-size:14px;line-height:1.4;margin-top:12px;}',
    '#appai-cust .alert-error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;}',
    '#appai-cust .alert-success{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;}',
    /* Toast */
    '#appai-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;max-width:92vw;text-align:center;}',
    '#appai-toast.show{opacity:1;}',
    /* Loading overlay on main preview */
    '#appai-cust .main-preview .overlay{position:absolute;inset:0;background:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;}',
    '#appai-cust .main-preview .overlay p{font-size:14px;color:#555;margin:0;}',
    '@keyframes appai-spin-dark{to{transform:rotate(360deg)}}',
    '#appai-cust .spinner-dark{width:32px;height:32px;border:3px solid #ddd;border-top-color:#333;border-radius:50%;animation:appai-spin-dark .8s linear infinite;}',
    /* Generate again link */
    '#appai-cust .regen-link{display:inline-block;margin-top:10px;font-size:13px;color:#555;text-decoration:underline;cursor:pointer;background:none;border:none;padding:0;}',
  ].join('');

  (function injectStyles() {
    if (document.getElementById('appai-cust-style')) return;
    var s = document.createElement('style');
    s.id = 'appai-cust-style';
    s.textContent = STYLES;
    document.head.appendChild(s);
  })();

  // Toast element
  var toast = document.createElement('div');
  toast.id = 'appai-toast';
  document.body.appendChild(toast);
  var toastTimer = null;

  function showToast(msg, duration) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, duration || 3000);
  }

  // ─── API helpers ─────────────────────────────────────────────────────────────
  function apiUrl(path) {
    return API + path;
  }

  async function fetchBlanks() {
    var res = await fetch(apiUrl('/api/storefront/blanks?shop=' + encodeURIComponent(shop)));
    if (!res.ok) throw new Error('Failed to load products');
    var data = await res.json();
    return data.blanks || [];
  }

  async function createDesign(params) {
    var res = await fetch(apiUrl('/api/storefront/customizer/designs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start generation');
    return data;
  }

  async function pollDesign(id) {
    var res = await fetch(apiUrl('/api/storefront/customizer/designs/' + encodeURIComponent(id) + '?shop=' + encodeURIComponent(shop)));
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'Failed to fetch design');
    }
    return await res.json();
  }

  // ─── Render ───────────────────────────────────────────────────────────────────
  function render() {
    root.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.id = 'appai-cust';
    root.appendChild(wrap);

    if (state.loading) {
      renderSkeleton(wrap);
      return;
    }

    renderHeader(wrap);

    if (state.status === 'READY') {
      renderPreview(wrap);
    } else {
      renderForm(wrap);
      if (state.error) {
        var alert = document.createElement('div');
        alert.className = 'alert alert-error';
        alert.textContent = state.error;
        wrap.appendChild(alert);
      }
    }
  }

  function renderSkeleton(wrap) {
    wrap.innerHTML = [
      '<h1 class="skeleton" style="width:55%;height:32px;margin-bottom:12px;"></h1>',
      '<p class="skeleton" style="width:80%;height:16px;margin-bottom:32px;"></p>',
      '<div class="step"><div class="step-title skeleton" style="width:120px;height:12px;margin-bottom:10px;"></div>',
      '<div class="product-grid">',
      '<div class="skeleton" style="height:130px;border-radius:10px;"></div>',
      '<div class="skeleton" style="height:130px;border-radius:10px;"></div>',
      '<div class="skeleton" style="height:130px;border-radius:10px;"></div>',
      '</div></div>',
    ].join('');
  }

  function renderHeader(wrap) {
    var h1 = document.createElement('h1');
    h1.textContent = 'Create Your Custom Design';
    wrap.appendChild(h1);

    var sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = 'Pick a product, describe your vision, and we\'ll generate a one-of-a-kind design for you.';
    wrap.appendChild(sub);
  }

  function renderForm(wrap) {
    // Step 1: Product selection
    renderProductStep(wrap);

    // Step 2: Options (size/color) — only shown after product selected
    if (state.selectedBlank) {
      renderVariantStep(wrap);
    }

    // Step 3: Prompt + style — shown after blank + variant selected
    if (state.selectedVariant) {
      renderPromptStep(wrap);
    }
  }

  function renderProductStep(wrap) {
    var step = document.createElement('div');
    step.className = 'step';

    var title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = 'Step 1 — Choose a Product';
    step.appendChild(title);

    if (state.blanks.length === 0) {
      var none = document.createElement('p');
      none.style.cssText = 'color:#888;font-size:14px;';
      none.textContent = 'No customizable products found. Please contact the store.';
      step.appendChild(none);
      wrap.appendChild(step);
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'product-grid';

    state.blanks.forEach(function (blank) {
      var card = document.createElement('div');
      card.className = 'product-card' + (state.selectedBlank && state.selectedBlank.productTypeId === blank.productTypeId ? ' selected' : '');

      if (blank.primaryMockupImage || (blank.shopifyProductHandle && blank.shopifyProductHandle !== '')) {
        var img = document.createElement('img');
        img.src = blank.primaryMockupImage || ('https://cdn.shopify.com/s/files/1/0/0/0/products/placeholder.png');
        img.alt = blank.name;
        img.onerror = function () { this.style.display = 'none'; };
        card.appendChild(img);
      } else {
        var placeholder = document.createElement('div');
        placeholder.style.cssText = 'width:80px;height:80px;background:#f0f0f0;border-radius:6px;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;font-size:28px;';
        placeholder.textContent = '🎨';
        card.appendChild(placeholder);
      }

      var name = document.createElement('div');
      name.className = 'card-name';
      name.textContent = blank.name;
      card.appendChild(name);

      card.addEventListener('click', function () {
        state.selectedBlank = blank;
        state.selectedVariant = null; // reset variant when product changes
        // Auto-select first variant if only one exists
        if (blank.variants && blank.variants.length === 1) {
          state.selectedVariant = blank.variants[0];
        }
        render();
      });

      grid.appendChild(card);
    });

    step.appendChild(grid);
    wrap.appendChild(step);
  }

  function renderVariantStep(wrap) {
    var blank = state.selectedBlank;
    if (!blank || !blank.variants || blank.variants.length === 0) return;

    var step = document.createElement('div');
    step.className = 'step';

    var title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = 'Step 2 — Choose Options';
    step.appendChild(title);

    // Group by size first, then color
    var sizeIds = [];
    var colorIds = [];
    blank.variants.forEach(function (v) {
      if (v.sizeId && sizeIds.indexOf(v.sizeId) === -1) sizeIds.push(v.sizeId);
      if (v.colorId && colorIds.indexOf(v.colorId) === -1) colorIds.push(v.colorId);
    });

    // Size buttons
    if (sizeIds.length > 1 || (sizeIds.length === 1 && sizeIds[0] !== 'default')) {
      var sizeLabel = document.createElement('div');
      sizeLabel.style.cssText = 'font-size:13px;color:#555;margin-bottom:6px;';
      sizeLabel.textContent = 'Size';
      step.appendChild(sizeLabel);

      var sizeRow = document.createElement('div');
      sizeRow.className = 'option-row';

      sizeIds.forEach(function (sizeId) {
        var v = blank.variants.find(function (v) { return v.sizeId === sizeId; });
        if (!v) return;
        var btn = document.createElement('button');
        btn.className = 'opt-btn' + (state.selectedVariant && state.selectedVariant.sizeId === sizeId ? ' selected' : '');
        btn.textContent = v.sizeLabel || sizeId;
        btn.addEventListener('click', function () {
          var targetColorId = state.selectedVariant ? state.selectedVariant.colorId : (colorIds[0] || 'default');
          var match = blank.variants.find(function (vv) {
            return vv.sizeId === sizeId && vv.colorId === targetColorId;
          }) || blank.variants.find(function (vv) { return vv.sizeId === sizeId; });
          state.selectedVariant = match || null;
          render();
        });
        sizeRow.appendChild(btn);
      });
      step.appendChild(sizeRow);
    }

    // Color buttons
    if (colorIds.length > 1 || (colorIds.length === 1 && colorIds[0] !== 'default')) {
      var colorLabel = document.createElement('div');
      colorLabel.style.cssText = 'font-size:13px;color:#555;margin:12px 0 6px;';
      colorLabel.textContent = 'Color';
      step.appendChild(colorLabel);

      var colorRow = document.createElement('div');
      colorRow.className = 'option-row';

      colorIds.forEach(function (colorId) {
        var v = blank.variants.find(function (v) { return v.colorId === colorId; });
        if (!v) return;
        var btn = document.createElement('button');
        btn.className = 'opt-btn' + (state.selectedVariant && state.selectedVariant.colorId === colorId ? ' selected' : '');
        btn.textContent = v.colorLabel || colorId;
        btn.addEventListener('click', function () {
          var targetSizeId = state.selectedVariant ? state.selectedVariant.sizeId : (sizeIds[0] || 'default');
          var match = blank.variants.find(function (vv) {
            return vv.colorId === colorId && vv.sizeId === targetSizeId;
          }) || blank.variants.find(function (vv) { return vv.colorId === colorId; });
          state.selectedVariant = match || null;
          render();
        });
        colorRow.appendChild(btn);
      });
      step.appendChild(colorRow);
    }

    // Auto-select if only one variant
    if (blank.variants.length === 1 && !state.selectedVariant) {
      state.selectedVariant = blank.variants[0];
    }

    // If no size/color options shown (only one variant), auto-select and skip to next step
    if (sizeIds.length <= 1 && colorIds.length <= 1 && blank.variants.length === 1) {
      wrap.appendChild(step);
      return;
    }

    wrap.appendChild(step);
  }

  function renderPromptStep(wrap) {
    var step = document.createElement('div');
    step.className = 'step';

    var title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = 'Step 3 — Describe Your Design';
    step.appendChild(title);

    // Prompt textarea
    var ta = document.createElement('textarea');
    ta.placeholder = 'e.g. "A majestic mountain sunset with purple clouds and a golden eagle in flight"';
    ta.value = state.prompt;
    ta.rows = 3;
    ta.addEventListener('input', function () { state.prompt = ta.value; });
    step.appendChild(ta);

    // Style select
    var styleWrap = document.createElement('div');
    styleWrap.style.cssText = 'margin-top:12px;';

    var styleLabel = document.createElement('label');
    styleLabel.style.cssText = 'display:block;font-size:13px;color:#555;margin-bottom:6px;';
    styleLabel.textContent = 'Art Style (optional)';
    styleWrap.appendChild(styleLabel);

    var sel = document.createElement('select');
    var styleOptions = [
      { id: '', label: 'No Style (use prompt only)' },
      { id: 'watercolor', label: 'Watercolor' },
      { id: 'oil-painting', label: 'Oil Painting' },
      { id: 'pop-art', label: 'Pop Art' },
      { id: 'minimal-line', label: 'Minimal Line Art' },
      { id: 'abstract', label: 'Abstract' },
      { id: 'vintage-poster', label: 'Vintage Poster' },
      { id: 'photorealistic', label: 'Photorealistic' },
    ];
    styleOptions.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      if (opt.id === state.stylePreset) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { state.stylePreset = sel.value; });
    styleWrap.appendChild(sel);
    step.appendChild(styleWrap);

    // Generate button
    var canGenerate = !!(state.selectedVariant && state.prompt.trim().length > 3);
    var isGenerating = state.status === 'GENERATING';

    var btn = document.createElement('button');
    btn.className = 'btn-generate';
    btn.disabled = !canGenerate || isGenerating;

    if (isGenerating) {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      btn.appendChild(spinner);
      btn.appendChild(document.createTextNode('Generating…'));
    } else {
      btn.textContent = '✨ Generate My Design';
    }

    btn.addEventListener('click', handleGenerate);
    step.appendChild(btn);

    wrap.appendChild(step);
  }

  function renderPreview(wrap) {
    // Mockup preview section
    var step = document.createElement('div');
    step.className = 'step';

    var title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = 'Your Custom Design';
    step.appendChild(title);

    var previewWrap = document.createElement('div');
    previewWrap.className = 'preview-wrap';

    // Main image
    var mainPreview = document.createElement('div');
    mainPreview.className = 'main-preview';

    var mainImg = document.createElement('img');
    mainImg.src = state.mockupUrls[state.selectedMockupIndex] || state.mockupUrl || '';
    mainImg.alt = 'Your custom design';
    mainPreview.appendChild(mainImg);

    previewWrap.appendChild(mainPreview);

    // Thumbnails (only if multiple mockups)
    if (state.mockupUrls.length > 1) {
      var thumbsCol = document.createElement('div');
      thumbsCol.className = 'thumbs';

      state.mockupUrls.forEach(function (url, i) {
        var thumb = document.createElement('div');
        thumb.className = 'thumb' + (i === state.selectedMockupIndex ? ' active' : '');

        var tImg = document.createElement('img');
        tImg.src = url;
        tImg.alt = 'View ' + (i + 1);
        thumb.appendChild(tImg);

        (function (idx) {
          thumb.addEventListener('click', function () {
            state.selectedMockupIndex = idx;
            render();
          });
        })(i);

        thumbsCol.appendChild(thumb);
      });

      previewWrap.appendChild(thumbsCol);
    }

    step.appendChild(previewWrap);

    // Regenerate link
    var regenBtn = document.createElement('button');
    regenBtn.className = 'regen-link';
    regenBtn.textContent = '↩ Generate a different design';
    regenBtn.addEventListener('click', function () {
      state.status = null;
      state.designId = null;
      state.artworkUrl = null;
      state.mockupUrl = null;
      state.mockupUrls = [];
      state.selectedMockupIndex = 0;
      state.error = null;
      render();
    });
    step.appendChild(regenBtn);

    wrap.appendChild(step);

    // Saved confirmation
    if (state.saved) {
      var savedAlert = document.createElement('div');
      savedAlert.className = 'alert alert-success';
      var resumeUrl = window.location.pathname + '?design_id=' + encodeURIComponent(state.designId);
      savedAlert.innerHTML = '✅ Design saved! <a href="' + resumeUrl + '" style="color:#166534;font-weight:600;">Resume or share this link</a>';
      wrap.appendChild(savedAlert);
    }

    if (state.addedToCart) {
      var cartAlert = document.createElement('div');
      cartAlert.className = 'alert alert-success';
      cartAlert.innerHTML = '🛒 Added to cart! <a href="/cart" style="color:#166534;font-weight:600;">View cart →</a>';
      wrap.appendChild(cartAlert);
    }

    // CTA buttons
    var ctaRow = document.createElement('div');
    ctaRow.className = 'cta-row';

    var atcBtn = document.createElement('button');
    atcBtn.className = 'btn-atc';
    atcBtn.textContent = state.addedToCart ? '✓ Added to Cart' : 'Add to Cart';
    atcBtn.disabled = state.addedToCart;
    atcBtn.addEventListener('click', handleAddToCart);
    ctaRow.appendChild(atcBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save';
    saveBtn.textContent = state.saved ? '✓ Design Saved' : '💾 Save Design';
    saveBtn.addEventListener('click', handleSaveDesign);
    ctaRow.appendChild(saveBtn);

    wrap.appendChild(ctaRow);
  }

  // ─── Event handlers ───────────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!state.selectedVariant || !state.prompt.trim()) return;

    state.status = 'GENERATING';
    state.error = null;
    state.designId = null;
    state.artworkUrl = null;
    state.mockupUrl = null;
    state.mockupUrls = [];
    render();

    try {
      var blank = state.selectedBlank;
      var result = await createDesign({
        shop: shop,
        productTypeId: blank ? String(blank.productTypeId) : '',
        baseVariantId: state.selectedVariant.shopifyVariantId,
        sizeId: state.selectedVariant.sizeId,
        colorId: state.selectedVariant.colorId,
        prompt: state.prompt.trim(),
        stylePreset: state.stylePreset || '',
      });

      state.designId = result.designId;
      startPolling(result.designId);
    } catch (err) {
      state.status = 'FAILED';
      state.error = err.message || 'Failed to start generation. Please try again.';
      render();
    }
  }

  function startPolling(designId) {
    clearInterval(state.pollingTimer);
    var attempts = 0;
    var maxAttempts = 90; // 90 × 2s = 3 minutes max

    state.pollingTimer = setInterval(async function () {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(state.pollingTimer);
        state.status = 'FAILED';
        state.error = 'Generation timed out. Please try again.';
        render();
        return;
      }

      try {
        var design = await pollDesign(designId);
        if (design.status === 'READY') {
          clearInterval(state.pollingTimer);
          state.status = 'READY';
          state.artworkUrl = design.artworkUrl;
          state.mockupUrl = design.mockupUrl;
          state.mockupUrls = Array.isArray(design.mockupUrls) && design.mockupUrls.length
            ? design.mockupUrls
            : (design.mockupUrl ? [design.mockupUrl] : []);
          state.selectedMockupIndex = 0;
          render();
        } else if (design.status === 'FAILED') {
          clearInterval(state.pollingTimer);
          state.status = 'FAILED';
          state.error = design.errorMessage || 'Generation failed. Please try again.';
          render();
        }
        // GENERATING: keep polling
      } catch (_) {
        // Transient errors — keep polling
      }
    }, 2000);
  }

  async function handleAddToCart() {
    if (!state.selectedVariant || !state.mockupUrl || !state.designId) return;

    var btn = root.querySelector('.btn-atc');
    if (btn) btn.disabled = true;
    if (btn) btn.textContent = 'Adding…';

    try {
      var uid = state.designId + '-' + Date.now().toString(36);
      var payload = {
        id: state.selectedVariant.shopifyVariantId,
        quantity: 1,
        properties: {
          _design_id: state.designId,
          _mockup_url: state.mockupUrls[state.selectedMockupIndex] || state.mockupUrl,
          _artwork_url: state.artworkUrl || state.mockupUrl,
          _appai_uid: uid,
        },
      };

      var res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });

      if (!res.ok) {
        var errData = await res.json().catch(function () { return {}; });
        throw new Error(errData.description || errData.error || 'Failed to add to cart');
      }

      // Dispatch event so cart drawers / the guard picks it up
      window.dispatchEvent(new Event('appai:cart-updated'));

      state.addedToCart = true;
      render();
      showToast('Added to cart! 🛒');

      // If theme has a cart drawer, try to open it
      var drawerEvents = ['cart:open', 'cart-drawer:open', 'cartDrawer:open', 'open-cart'];
      drawerEvents.forEach(function (evName) {
        try { document.dispatchEvent(new CustomEvent(evName)); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent(evName)); } catch (_) {}
      });
    } catch (err) {
      if (btn) btn.disabled = false;
      if (btn) btn.textContent = 'Add to Cart';
      state.error = err.message || 'Failed to add to cart';
      var wrap = root.querySelector('#appai-cust');
      if (wrap) {
        var alert = document.createElement('div');
        alert.className = 'alert alert-error';
        alert.textContent = state.error;
        wrap.appendChild(alert);
      }
    }
  }

  function handleSaveDesign() {
    // The design is already saved server-side (created on generate).
    // Just surface the resume link.
    state.saved = true;
    render();
    var resumeUrl = window.location.pathname + '?design_id=' + encodeURIComponent(state.designId);
    window.history.replaceState({}, '', resumeUrl);
    showToast('Design saved! Link updated in your address bar.');
  }

  // ─── Resume from ?design_id= ──────────────────────────────────────────────────
  async function tryResume() {
    var params = new URLSearchParams(window.location.search);
    var designId = params.get('design_id');
    if (!designId) return false;

    try {
      var design = await pollDesign(designId);
      if (!design) return false;

      state.designId = design.designId;
      state.status = design.status;
      state.artworkUrl = design.artworkUrl;
      state.mockupUrl = design.mockupUrl;
      state.mockupUrls = Array.isArray(design.mockupUrls) && design.mockupUrls.length
        ? design.mockupUrls
        : (design.mockupUrl ? [design.mockupUrl] : []);
      state.prompt = design.prompt || '';

      if (design.options) {
        state.stylePreset = design.options.stylePreset || '';
      }

      if (design.status === 'GENERATING') {
        startPolling(designId);
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    render(); // show skeleton

    try {
      // Check for resume first
      var resumed = await tryResume();

      // Load blank products in parallel
      var blanks = await fetchBlanks();
      state.blanks = blanks;

      if (!resumed) {
        // Auto-select if only one blank
        if (blanks.length === 1) {
          state.selectedBlank = blanks[0];
          if (blanks[0].variants && blanks[0].variants.length === 1) {
            state.selectedVariant = blanks[0].variants[0];
          }
        }
      } else {
        // Find the blank that matches the resumed design
        if (state.designId) {
          var design = state; // already loaded into state
          // Match by variant ID
          for (var i = 0; i < blanks.length; i++) {
            var blank = blanks[i];
            var matchVariant = blank.variants.find(function (v) {
              return v.shopifyVariantId === design.selectedVariant;
            });
            if (matchVariant) {
              state.selectedBlank = blank;
              state.selectedVariant = matchVariant;
              break;
            }
          }
        }
      }
    } catch (err) {
      state.error = err.message || 'Failed to load. Please refresh.';
    }

    state.loading = false;
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
