(function() {
  'use strict';

  let cartData = null;
  let isUpdating = false;

  async function fetchCartData() {
    try {
      const response = await fetch('/cart.js', {
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error('Failed to fetch cart');
      cartData = await response.json();
      console.log('[AI Art Studio] Cart data fetched:', cartData.items?.length || 0, 'items');
      return cartData;
    } catch (error) {
      console.error('[AI Art Studio] Error fetching cart:', error);
      return null;
    }
  }

  function getMockupUrlFromCartItem(lineItem) {
    if (!lineItem || !lineItem.properties) return null;
    return lineItem.properties['_mockup_url'] || lineItem.properties['mockup_url'] || null;
  }

  function findCartItemElements() {
    const selectors = [
      '[data-cart-item]',
      '.cart-item',
      '.cart__item',
      '[class*="cart-item"]',
      '[class*="CartItem"]',
      'tr[data-variant-id]',
      'tr.cart__row',
      '.line-item',
      '[data-line-item]',
      '.cart-drawer__item',
      '.mini-cart__item'
    ];
    
    const allItems = [];
    selectors.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (!allItems.includes(el)) {
            allItems.push(el);
          }
        });
      } catch (e) {}
    });
    
    return allItems;
  }

  function extractVariantIdFromElement(element) {
    const dataVariantId = element.getAttribute('data-variant-id') || 
                          element.getAttribute('data-id') ||
                          element.getAttribute('data-line-item-id');
    if (dataVariantId) return dataVariantId;

    const input = element.querySelector('input[name*="variant"], input[data-variant-id]');
    if (input) {
      return input.getAttribute('data-variant-id') || input.value;
    }

    const link = element.querySelector('a[href*="/products/"]');
    if (link) {
      const match = link.href.match(/variant=(\d+)/);
      if (match) return match[1];
    }

    const lineIndex = element.getAttribute('data-line-item-key') ||
                      element.getAttribute('data-key') ||
                      element.getAttribute('data-cart-item-key');
    if (lineIndex && cartData?.items) {
      const item = cartData.items.find(i => i.key === lineIndex);
      if (item) return String(item.variant_id);
    }

    return null;
  }

  function extractLineKeyFromElement(element) {
    return element.getAttribute('data-line-item-key') ||
           element.getAttribute('data-key') ||
           element.getAttribute('data-cart-item-key') ||
           element.getAttribute('data-line');
  }

  function findMatchingCartItem(element) {
    if (!cartData?.items?.length) return null;

    const lineKey = extractLineKeyFromElement(element);
    if (lineKey) {
      const match = cartData.items.find(item => item.key === lineKey);
      if (match) return match;
    }

    const variantId = extractVariantIdFromElement(element);
    if (variantId) {
      const matches = cartData.items.filter(item => String(item.variant_id) === String(variantId));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const withMockup = matches.find(item => getMockupUrlFromCartItem(item));
        if (withMockup) return withMockup;
        return matches[0];
      }
    }

    const itemElements = findCartItemElements();
    const elementIndex = itemElements.indexOf(element);
    if (elementIndex >= 0 && elementIndex < cartData.items.length) {
      return cartData.items[elementIndex];
    }

    return null;
  }

  function replaceImage(element, mockupUrl) {
    const imgs = element.querySelectorAll('img');
    let replaced = false;

    imgs.forEach(img => {
      const isProductImage = img.src.includes('cdn.shopify.com') || 
                            img.classList.contains('cart-item__image') ||
                            img.classList.contains('cart__image') ||
                            img.closest('.cart-item__media, .cart__item-image, .line-item__image');
      
      if (isProductImage || imgs.length === 1) {
        if (img.dataset.aiMockupApplied === 'true' && img.src === mockupUrl) {
          return;
        }

        if (!img.dataset.originalSrc) {
          img.dataset.originalSrc = img.src;
        }
        
        img.src = mockupUrl;
        img.srcset = '';
        img.dataset.aiMockupApplied = 'true';
        replaced = true;
        console.log('[AI Art Studio] Replaced cart image with mockup');
      }
    });

    return replaced;
  }

  async function replaceCartImages() {
    if (isUpdating) return;
    isUpdating = true;

    try {
      await fetchCartData();
      
      if (!cartData?.items?.length) {
        console.log('[AI Art Studio] No cart items found');
        return;
      }

      const hasAnyMockups = cartData.items.some(item => getMockupUrlFromCartItem(item));
      if (!hasAnyMockups) {
        console.log('[AI Art Studio] No mockup URLs in cart items');
        return;
      }

      const cartElements = findCartItemElements();
      console.log('[AI Art Studio] Found', cartElements.length, 'cart item elements');

      let replacedCount = 0;
      
      cartElements.forEach((element, index) => {
        const cartItem = findMatchingCartItem(element);
        if (!cartItem) {
          console.log('[AI Art Studio] No matching cart item for element', index);
          return;
        }

        const mockupUrl = getMockupUrlFromCartItem(cartItem);
        if (!mockupUrl) {
          return;
        }

        console.log('[AI Art Studio] Found mockup URL for item:', cartItem.title);
        
        if (replaceImage(element, mockupUrl)) {
          replacedCount++;
        }
      });

      console.log('[AI Art Studio] Replaced', replacedCount, 'images');

      if (replacedCount === 0 && hasAnyMockups && cartElements.length > 0) {
        console.log('[AI Art Studio] Fallback: Direct position matching');
        
        cartData.items.forEach((item, index) => {
          const mockupUrl = getMockupUrlFromCartItem(item);
          if (mockupUrl && cartElements[index]) {
            replaceImage(cartElements[index], mockupUrl);
          }
        });
      }

    } catch (error) {
      console.error('[AI Art Studio] Error replacing cart images:', error);
    } finally {
      isUpdating = false;
    }
  }

  function init() {
    const isCartPage = window.location.pathname.includes('/cart') || 
                       document.querySelector('[data-cart-container], .cart, #cart, [class*="cart-drawer"]');
    
    if (!isCartPage) {
      console.log('[AI Art Studio] Not a cart page, skipping');
      return;
    }

    console.log('[AI Art Studio] Initializing cart image replacement');

    setTimeout(replaceCartImages, 500);

    const observer = new MutationObserver(function(mutations) {
      let shouldUpdate = false;
      mutations.forEach(function(mutation) {
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              const hasCartContent = node.matches && (
                node.matches('[data-cart-item], .cart-item, [class*="cart"]') ||
                node.querySelector('[data-cart-item], .cart-item, [class*="cart-item"]')
              );
              if (hasCartContent) shouldUpdate = true;
            }
          });
        }
      });
      
      if (shouldUpdate) {
        setTimeout(replaceCartImages, 300);
      }
    });

    const containers = document.querySelectorAll('[data-cart], .cart, #cart, main, [role="main"], body');
    containers.forEach(container => {
      if (container) {
        observer.observe(container, { childList: true, subtree: true });
      }
    });

    document.addEventListener('cart:updated', () => setTimeout(replaceCartImages, 300));
    document.addEventListener('cart:refresh', () => setTimeout(replaceCartImages, 300));

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        setTimeout(replaceCartImages, 300);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
