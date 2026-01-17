(function() {
  'use strict';

  function replaceCartImages() {
    const cartItems = document.querySelectorAll('[data-cart-item], .cart-item, .cart__item, [class*="cart-item"], [class*="CartItem"]');
    
    cartItems.forEach(function(item) {
      const mockupUrl = findPropertyValue(item, '_mockup_url');
      if (!mockupUrl) return;

      const img = item.querySelector('img');
      if (img && img.src !== mockupUrl) {
        img.src = mockupUrl;
        img.srcset = '';
        img.dataset.originalSrc = img.dataset.originalSrc || img.src;
        console.log('[AI Art Studio] Replaced cart image with mockup');
      }
    });
  }

  function findPropertyValue(item, propertyName) {
    const propertyElements = item.querySelectorAll('[class*="property"], [class*="Property"], dt, dd, li');
    
    for (let i = 0; i < propertyElements.length; i++) {
      const el = propertyElements[i];
      const text = el.textContent || '';
      
      if (text.includes(propertyName + ':')) {
        const match = text.match(new RegExp(propertyName + ':\\s*(.+)'));
        if (match) return match[1].trim();
      }
      
      if (text.includes(propertyName)) {
        const nextSibling = el.nextElementSibling;
        if (nextSibling) {
          return nextSibling.textContent.trim();
        }
      }
    }

    const hiddenInputs = item.querySelectorAll('input[type="hidden"]');
    for (let i = 0; i < hiddenInputs.length; i++) {
      const input = hiddenInputs[i];
      if (input.name && input.name.includes(propertyName)) {
        return input.value;
      }
    }

    const dataAttr = item.getAttribute('data-properties') || item.getAttribute('data-line-item-properties');
    if (dataAttr) {
      try {
        const props = JSON.parse(dataAttr);
        if (props[propertyName]) return props[propertyName];
      } catch (e) {}
    }

    return null;
  }

  function init() {
    if (!window.location.pathname.includes('/cart')) return;

    replaceCartImages();

    const observer = new MutationObserver(function(mutations) {
      let shouldUpdate = false;
      mutations.forEach(function(mutation) {
        if (mutation.addedNodes.length > 0) shouldUpdate = true;
      });
      if (shouldUpdate) {
        setTimeout(replaceCartImages, 100);
      }
    });

    const cartContainer = document.querySelector('[data-cart], .cart, #cart, main, [role="main"]');
    if (cartContainer) {
      observer.observe(cartContainer, { childList: true, subtree: true });
    }

    document.addEventListener('cart:updated', replaceCartImages);
    document.addEventListener('cart:refresh', replaceCartImages);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
