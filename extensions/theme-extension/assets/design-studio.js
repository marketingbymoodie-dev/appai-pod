(function() {
  console.log('[AI Art Studio] External script loaded');
  
  // Find all AI Art Studio containers on the page
  const containers = document.querySelectorAll('[id^="ai-art-studio-container-"]');
  console.log('[AI Art Studio] Found containers:', containers.length);
  
  containers.forEach(function(container) {
    const blockId = container.id.replace('ai-art-studio-container-', '');
    console.log('[AI Art Studio] Initializing block:', blockId);
    
    const appUrl = container.dataset.appUrl;
    console.log('[AI Art Studio] appUrl:', appUrl);
    
    if (!appUrl) {
      container.innerHTML = '<div class="ai-art-studio__error">This product has not been configured for the design studio. Please publish it from the AI Art Studio admin.</div>';
      return;
    }

    const productTypeId = container.dataset.productTypeId || '1';
    const productId = container.dataset.productId;
    const productHandle = container.dataset.productHandle;
    const productTitle = container.dataset.productTitle;
    const displayName = container.dataset.displayName || productTitle;
    const showPresets = container.dataset.showPresets === 'true';
    const selectedVariant = container.dataset.selectedVariant;
    const customerId = container.dataset.customerId || '';
    const customerEmail = container.dataset.customerEmail || '';
    const customerName = container.dataset.customerName || '';
    
    const shopDomain = container.dataset.shopDomain || (window.Shopify && window.Shopify.shop) || window.location.hostname;
    
    const urlParams = new URLSearchParams(window.location.search);
    const sharedDesignId = urlParams.get('sharedDesignId');
    
    const params = new URLSearchParams();
    params.set('embedded', 'true');
    params.set('shopify', 'true');
    params.set('shop', shopDomain);
    params.set('productTypeId', productTypeId);
    params.set('productId', productId);
    params.set('productHandle', productHandle);
    params.set('productTitle', productTitle);
    params.set('displayName', displayName);
    params.set('showPresets', showPresets.toString());
    params.set('selectedVariant', selectedVariant);
    if (customerId) {
      params.set('customerId', customerId);
      params.set('customerEmail', customerEmail);
      params.set('customerName', customerName);
    }
    if (sharedDesignId) {
      params.set('sharedDesignId', sharedDesignId);
    }

    const iframe = document.createElement('iframe');
    iframe.src = appUrl + '/embed/design?' + params.toString();
    iframe.allow = 'clipboard-write';
    iframe.title = 'AI Art Design Studio';

    iframe.onload = function() {
      const loading = container.querySelector('.ai-art-studio__loading');
      if (loading) loading.remove();
    };

    container.appendChild(iframe);

    // Store the expected origin for message validation
    var expectedOrigin = null;
    try {
      if (appUrl) {
        expectedOrigin = new URL(appUrl).origin;
      }
    } catch (e) {
      console.warn('[AI Art Studio] Could not parse appUrl:', appUrl);
    }
    
    // Also get origin from the iframe once it's created
    var iframeOrigin = null;
    try {
      iframeOrigin = new URL(iframe.src).origin;
    } catch (e) {}
    
    console.log('[AI Art Studio] Message listener initialized. Expected origins:', expectedOrigin, iframeOrigin);
    
    window.addEventListener('message', function(event) {
      // Debug: Log ALL messages to help troubleshoot
      try {
        var msgType = event.data && event.data.type;
        if (msgType && (msgType.indexOf('art-studio') !== -1 || msgType === 'AI_ART_STUDIO_MOCKUPS')) {
          console.log('[AI Art Studio] Received message:', msgType, 'from origin:', event.origin);
        }
      } catch (e) {
        // Ignore errors from checking message type
      }
      
      // Accept messages from either the configured appUrl or the iframe's actual origin
      var isValidOrigin = (expectedOrigin && event.origin === expectedOrigin) || 
                          (iframeOrigin && event.origin === iframeOrigin) ||
                          (event.origin && event.origin.indexOf('replit') !== -1);
      
      if (!isValidOrigin) {
        // Only log rejection for our message types to avoid noise
        if (event.data && event.data.type && (event.data.type.indexOf('art-studio') !== -1 || event.data.type === 'AI_ART_STUDIO_MOCKUPS')) {
          console.warn('[AI Art Studio] Rejected message from:', event.origin, 'expected:', expectedOrigin || iframeOrigin);
        }
        return;
      }

      var data = event.data;
      
      if (data.type === 'ai-art-studio:add-to-cart') {
        var variantId = data.variantId;
        var artworkUrl = data.artworkUrl;
        var designId = data.designId;

        var formData = {
          items: [{
            id: variantId,
            quantity: 1,
            properties: {
              '_artwork_url': artworkUrl,
              '_design_id': designId,
              'Artwork': 'Custom AI Design'
            }
          }]
        };

        fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        })
        .then(function(response) { return response.json(); })
        .then(function(result) {
          iframe.contentWindow.postMessage({
            type: 'ai-art-studio:cart-updated',
            success: true,
            cart: result
          }, appUrl);
          
          document.dispatchEvent(new CustomEvent('cart:refresh'));
          
          if (window.location.pathname !== '/cart') {
            var cartDrawer = document.querySelector('[data-cart-drawer]');
            if (cartDrawer) {
              cartDrawer.classList.add('is-active');
            }
          }
        })
        .catch(function(error) {
          console.error('Failed to add to cart:', error);
          iframe.contentWindow.postMessage({
            type: 'ai-art-studio:cart-updated',
            success: false,
            error: error.message
          }, appUrl);
        });
      }

      if (data.type === 'ai-art-studio:resize') {
        container.style.height = data.height + 'px';
      }

      // Handle mockup updates from the AI generator
      if (data.type === 'AI_ART_STUDIO_MOCKUPS') {
        var mockupUrls = data.mockupUrls;
        if (!mockupUrls || mockupUrls.length === 0) return;
        
        console.log('[AI Art Studio] Received mockup URLs:', mockupUrls.length);
        
        // Helper to update an image element with all lazy-loading patterns
        function updateImageElement(img, url) {
          // Store original values for potential reset
          if (!img.dataset.originalSrc) {
            img.dataset.originalSrc = img.src || '';
            if (img.dataset.src) img.dataset.originalDataSrc = img.dataset.src;
            if (img.dataset.srcset) img.dataset.originalDataSrcset = img.dataset.srcset;
            if (img.dataset.master) img.dataset.originalDataMaster = img.dataset.master;
          }
          
          // Update all src variants (handles lazy-loading themes)
          img.src = url;
          img.srcset = '';
          if (img.dataset.src) img.dataset.src = url;
          if (img.dataset.srcset) img.dataset.srcset = url;
          if (img.dataset.master) img.dataset.master = url;
          
          // Handle Shopify Dawn/OS 2.0 lazy loading
          img.removeAttribute('loading');
          img.classList.remove('lazyload', 'lazyloading');
          img.classList.add('lazyloaded');
          
          // Update parent picture element sources
          var picture = img.closest('picture');
          if (picture) {
            picture.querySelectorAll('source').forEach(function(source) {
              source.srcset = url;
              if (source.dataset.srcset) source.dataset.srcset = url;
            });
          }
          
          // Handle background-image containers
          var parent = img.parentElement;
          if (parent && parent.style.backgroundImage) {
            parent.dataset.originalBg = parent.style.backgroundImage;
            parent.style.backgroundImage = "url('" + url + "')";
          }
        }
        
        // STRATEGY 1: Try common theme-specific selectors first
        var imageSelectors = [
          '.product__media-item img',
          '.product-gallery__image',
          '.product-single__photo img',
          '.product__photo img',
          '[data-product-featured-image]',
          '.product-featured-media img',
          '.product__main-photos img',
          '.product__media img',
          '.product-image img',
          '.product-single__media img',
          '[data-media-id] img',
          '.product-gallery img',
          '.product__images img',
          '.product-images img'
        ];
        
        var productImages = [];
        for (var i = 0; i < imageSelectors.length; i++) {
          var selector = imageSelectors[i];
          productImages = document.querySelectorAll(selector);
          if (productImages.length > 0) {
            console.log('[AI Art Studio] Found images via selector:', selector);
            break;
          }
        }
        
        // Find the product media container for scoped searches
        var productMediaContainer = 
          document.querySelector('[data-product-media-container]') ||
          document.querySelector('[data-product-media]') ||
          document.querySelector('.product__media-list') ||
          document.querySelector('.product__media') ||
          document.querySelector('.product-media') ||
          document.querySelector('.product-gallery') ||
          document.querySelector('.product__images') ||
          document.querySelector('[data-section-type="product"]') ||
          document.querySelector('.product') ||
          document.querySelector('main');
        
        // STRATEGY 2: Find images by Shopify CDN URL pattern (scoped to product area)
        if (productImages.length === 0 && productMediaContainer) {
          var containerImages = productMediaContainer.querySelectorAll('img');
          var shopifyProductImages = Array.from(containerImages).filter(function(img) {
            var src = img.src || img.dataset.src || '';
            return (src.indexOf('cdn.shopify.com') !== -1 && src.indexOf('/products/') !== -1) ||
                   (src.indexOf('cdn.shopify.com') !== -1 && src.indexOf('/files/') !== -1);
          });
          
          if (shopifyProductImages.length > 0) {
            console.log('[AI Art Studio] Found images via CDN pattern:', shopifyProductImages.length);
            productImages = shopifyProductImages;
          }
        }
        
        // STRATEGY 3: Find large images in product section
        if (productImages.length === 0 && productMediaContainer) {
          var sectionImages = productMediaContainer.querySelectorAll('img');
          var largeImages = Array.from(sectionImages).filter(function(img) {
            return img.naturalWidth > 200 || img.width > 200 ||
                   (img.style.width && parseInt(img.style.width) > 200);
          });
          
          if (largeImages.length > 0) {
            console.log('[AI Art Studio] Found large images in product section:', largeImages.length);
            productImages = largeImages;
          }
        }
        
        // STRATEGY 4: Handle data-media-id wrappers (common in OS 2.0 themes)
        if (productImages.length === 0 && productMediaContainer) {
          var mediaWrappers = productMediaContainer.querySelectorAll('[data-media-id]');
          if (mediaWrappers.length > 0) {
            console.log('[AI Art Studio] Found media wrappers:', mediaWrappers.length);
            mockupUrls.forEach(function(url, index) {
              if (mediaWrappers[index]) {
                var wrapper = mediaWrappers[index];
                var img = wrapper.querySelector('img');
                if (img) {
                  updateImageElement(img, url);
                }
                if (wrapper.style.backgroundImage) {
                  wrapper.dataset.originalBg = wrapper.style.backgroundImage;
                  wrapper.style.backgroundImage = "url('" + url + "')";
                }
                var modelViewer = wrapper.querySelector('model-viewer');
                if (modelViewer) {
                  modelViewer.dataset.originalPoster = modelViewer.poster || '';
                  modelViewer.poster = url;
                }
                var video = wrapper.querySelector('video');
                if (video) {
                  video.dataset.originalPoster = video.poster || '';
                  video.poster = url;
                }
              }
            });
            productImages = mediaWrappers;
          }
        }
        
        // STRATEGY 5: Find and update background-image galleries (no img elements)
        if (productImages.length === 0 && productMediaContainer) {
          var allElements = productMediaContainer.querySelectorAll('*');
          var bgImageElements = Array.from(allElements).filter(function(el) {
            var bgImage = window.getComputedStyle(el).backgroundImage;
            return bgImage && bgImage !== 'none' && 
                   (bgImage.indexOf('cdn.shopify.com') !== -1 || bgImage.indexOf('shopify.com/s/files') !== -1);
          });
          
          if (bgImageElements.length > 0) {
            console.log('[AI Art Studio] Found background-image elements:', bgImageElements.length);
            mockupUrls.forEach(function(url, index) {
              if (bgImageElements[index]) {
                var el = bgImageElements[index];
                if (!el.dataset.originalBg) {
                  el.dataset.originalBg = el.style.backgroundImage || window.getComputedStyle(el).backgroundImage;
                }
                el.style.backgroundImage = "url('" + url + "')";
              }
            });
            productImages = bgImageElements;
          }
        }
        
        // STRATEGY 6: Find media container near add-to-cart form
        if (productImages.length === 0) {
          var addToCartForm = document.querySelector('form[action*="/cart/add"]') ||
                               document.querySelector('[data-product-form]') ||
                               document.querySelector('.product-form');
          
          if (addToCartForm) {
            var productSection = addToCartForm.closest('section') || addToCartForm.closest('.product');
            if (productSection) {
              var sectionImgs = productSection.querySelectorAll('img');
              var largeSectionImgs = Array.from(sectionImgs).filter(function(img) {
                var rect = img.getBoundingClientRect();
                return rect.width > 100 && rect.height > 100;
              });
              
              if (largeSectionImgs.length > 0) {
                console.log('[AI Art Studio] Found images near add-to-cart:', largeSectionImgs.length);
                mockupUrls.forEach(function(url, index) {
                  if (largeSectionImgs[index]) {
                    updateImageElement(largeSectionImgs[index], url);
                  }
                });
                productImages = largeSectionImgs;
              }
            }
          }
        }
        
        // Update found product images
        if (productImages.length > 0) {
          console.log('[AI Art Studio] Updating', Math.min(productImages.length, mockupUrls.length), 'product images');
          mockupUrls.forEach(function(url, index) {
            if (productImages[index]) {
              updateImageElement(productImages[index], url);
            }
          });
        }
        
        // ALWAYS update the fallback preview section (guaranteed to work)
        var previewSection = document.querySelector('.ai-art-mockup-preview');
        if (!previewSection) {
          // Create the preview section if it doesn't exist
          previewSection = document.createElement('div');
          previewSection.className = 'ai-art-mockup-preview';
          previewSection.innerHTML = '<h4 class="ai-art-mockup-preview__title">Your Custom Design Preview</h4><div class="ai-art-mockup-preview__grid"></div>';
          
          // Insert before the design studio block
          var designBlock = container.closest('.ai-art-studio-block');
          if (designBlock) {
            designBlock.parentNode.insertBefore(previewSection, designBlock);
          }
        }
        
        if (previewSection) {
          previewSection.style.display = 'block';
          var grid = previewSection.querySelector('.ai-art-mockup-preview__grid');
          if (grid) {
            grid.innerHTML = '';
            mockupUrls.forEach(function(url) {
              var item = document.createElement('div');
              item.className = 'ai-art-mockup-preview__item';
              var img = document.createElement('img');
              img.src = url;
              img.alt = 'Product mockup with custom design';
              item.appendChild(img);
              grid.appendChild(item);
            });
          }
        }
        
        if (productImages.length === 0) {
          console.log('[AI Art Studio] Using fallback preview only - could not detect theme gallery');
        }
      }
    });
  });
})();
