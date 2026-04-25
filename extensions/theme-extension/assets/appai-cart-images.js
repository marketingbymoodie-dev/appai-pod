;(function () {
  'use strict';
  var CART_IMG_VERSION = '2.2';
  if (window.__APPAI_CART_IMG_REPLACER_V2__) return;
  window.__APPAI_CART_IMG_REPLACER_V2__ = true;
  window.__APPAI_CART_IMG_REPLACER__ = true;

  function ensureNoFlash() {
    if (window.location.pathname.indexOf('/cart') === -1) return;
    document.documentElement.classList.add('appai-cart-loading');
    if (!document.getElementById('appai-cart-noflash-style')) {
      var s = document.createElement('style');
      s.id = 'appai-cart-noflash-style';
      s.textContent =
        '.appai-cart-loading .cart-item img:not([data-appai-mockup]),' +
        '.appai-cart-loading [id*="CartItem"] img:not([data-appai-mockup]),' +
        '.appai-cart-loading cart-items img:not([data-appai-mockup]),' +
        '.appai-cart-loading form[action^="/cart"] img:not([data-appai-mockup]) { opacity:0 !important; }' +
        '.cart-item img,[id*="CartItem"] img,cart-items img,form[action^="/cart"] img{transition:opacity 120ms ease;}';
      document.head.appendChild(s);
    }
    setTimeout(function(){document.documentElement.classList.remove('appai-cart-loading');},1200);
  }
  ensureNoFlash();

  function getCart(){return fetch('/cart.js',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('cart.js '+r.status);return r.json();});}

  function mockupUrlFromLineProperties(props){
    if(!props)return null;
    if(Array.isArray(props)){
      for(var i=0;i<props.length;i++){
        var e=props[i];if(!e)continue;
        var n=String(e.name||e.key||'');
        if(n==='_mockup_url'||n==='mockup_url'){
          var v=e.value;if(v&&String(v).indexOf('https://')===0)return String(v);
        }
      }
      return null;
    }
    var u=props._mockup_url||props.mockup_url;
    if(u&&String(u).indexOf('https://')===0)return String(u);
    return null;
  }

  function isLikelyProductImg(img){
    var src=img.getAttribute('src')||img.getAttribute('data-src')||'';
    if(!src)return false;
    var w=Number(img.getAttribute('width')||img.naturalWidth||0);
    var h=Number(img.getAttribute('height')||img.naturalHeight||0);
    if((w&&w<=40)||(h&&h<=40))return false;
    if(img.hasAttribute('data-appai-mockup'))return false;
    return true;
  }

  function setImg(img,url){
    img.src=url;
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.removeAttribute('data-srcset');
    img.removeAttribute('data-lazy-src');
    img.setAttribute('data-appai-mockup','true');
  }

  function lineIdxFromEl(el){
    var m=/CartItem-(\d+)/i.exec(el.id||'');
    if(m)return parseInt(m[1],10);
    var a=el.getAttribute('data-line')||el.getAttribute('data-line-index')||el.getAttribute('data-index');
    if(a){var n=parseInt(a,10);if(!isNaN(n))return n;}
    return null;
  }

  function applyMockups(){
    getCart().then(function(cart){
      var items=cart.items||[];
      var keyMap=new Map(),varMap=new Map(),indexed=[];
      for(var i=0;i<items.length;i++){
        var it=items[i],url=mockupUrlFromLineProperties(it&&it.properties);
        if(!url)continue;
        keyMap.set(it.key,url);
        varMap.set(String(it.variant_id),url);
        indexed.push({index:i+1,variantId:String(it.variant_id),mockupUrl:url,key:it.key});
      }
      if(keyMap.size===0){document.documentElement.classList.remove('appai-cart-loading');return;}

      var replaced=0;

      var inps=[].slice.call(document.querySelectorAll("input[name^='updates[']"));
      for(var i=0;i<inps.length;i++){
        var m=/^updates\[(.+)\]$/.exec(inps[i].getAttribute('name')||'');
        if(!m)continue;
        var u=keyMap.get(m[1]);if(!u)continue;
        var c=inps[i].closest('[data-cart-item]')||inps[i].closest("[id*='CartItem']")||inps[i].closest('tr')||inps[i].closest('li')||inps[i].closest('.cart-item')||inps[i].closest("[class*='cart']")||inps[i].closest('form')||document;
        var imgs=[].slice.call(c.querySelectorAll('img')).filter(isLikelyProductImg);
        if(imgs.length){setImg(imgs[0],u);replaced++;}
      }

      if(replaced===0&&indexed.length>0){
        var sels=['.cart-item',"[class*='cart-item']","[id*='CartItem']",'cart-items > *',"form[action*='/cart'] li"];
        for(var s=0;s<sels.length;s++){
          var nodes=[].slice.call(document.querySelectorAll(sels[s]));
          if(!nodes.length)continue;
          var sr=0;
          for(var n=0;n<nodes.length;n++){
            var node=nodes[n];
            var img=[].slice.call(node.querySelectorAll('img')).find(isLikelyProductImg);
            if(!img)continue;
            var mu=null;
            var li=lineIdxFromEl(node);
            if(li!==null)for(var k=0;k<indexed.length;k++){if(indexed[k].index===li){mu=indexed[k].mockupUrl;break;}}
            if(!mu){
              var va=node.getAttribute('data-variant-id')||node.getAttribute('data-variant');
              if(!va){var vel=node.querySelector('[data-variant-id]');if(vel)va=vel.getAttribute('data-variant-id');}
              if(va)mu=varMap.get(String(va))||null;
            }
            if(!mu){
              var cnt=0;
              for(var p=0;p<=n;p++){var pi=[].slice.call(nodes[p].querySelectorAll('img')).find(function(im){return!im.hasAttribute('data-appai-mockup')&&(im.getAttribute('src')||'')!=='';});if(pi)cnt++;}
              if(cnt>0&&cnt<=indexed.length)mu=indexed[cnt-1].mockupUrl;
            }
            if(mu){setImg(img,mu);sr++;}
          }
          if(sr>0){replaced+=sr;break;}
        }
      }

      if(replaced===0&&indexed.length===1){
        var cs=[document.querySelector("form[action^='/cart']"),document.querySelector('cart-drawer'),document.querySelector('cart-items'),document.querySelector('[id*="cart"]')];
        for(var ci=0;ci<cs.length;ci++){if(!cs[ci])continue;var fi=[].slice.call(cs[ci].querySelectorAll('img')).find(isLikelyProductImg);if(fi){setImg(fi,indexed[0].mockupUrl);replaced++;break;}}
      }

      if(replaced>0)document.documentElement.classList.remove('appai-cart-loading');

      var cartContainerSels=['.cart-item','[class*="cart-item"]','[id*="CartItem"]','cart-items > *','form[action*="/cart"] li'];
      var linkedVariants=new Set(Array.from(varMap.keys()));
      for(var ls=0;ls<cartContainerSels.length;ls++){
        var lnodes=[].slice.call(document.querySelectorAll(cartContainerSels[ls]));
        if(!lnodes.length)continue;
        for(var ln=0;ln<lnodes.length;ln++){
          var lnode=lnodes[ln];
          var isAppAI=false;
          var lva=lnode.getAttribute('data-variant-id')||lnode.getAttribute('data-variant');
          if(!lva){var lvel=lnode.querySelector('[data-variant-id]');if(lvel)lva=lvel.getAttribute('data-variant-id');}
          if(lva&&linkedVariants.has(String(lva)))isAppAI=true;
          if(!isAppAI){var lli=lineIdxFromEl(lnode);if(lli!==null){for(var lk=0;lk<indexed.length;lk++){if(indexed[lk].index===lli){isAppAI=true;break;}}}}
          if(!isAppAI)continue;
          var links=[].slice.call(lnode.querySelectorAll('a[href*="/products/"]'));
          for(var ll=0;ll<links.length;ll++){
            if(links[ll].getAttribute('data-appai-link-disabled'))continue;
            links[ll].setAttribute('data-appai-link-disabled','1');
            links[ll].setAttribute('href','javascript:void(0)');
            links[ll].style.cursor='default';
            links[ll].style.pointerEvents='none';
            links[ll].addEventListener('click',function(e){e.preventDefault();e.stopPropagation();},{capture:true});
          }
        }
        if(lnodes.length>0)break;
      }
    }).catch(function(){document.documentElement.classList.remove('appai-cart-loading');});
  }

  var t=null;
  function schedule(){clearTimeout(t);t=setTimeout(applyMockups,150);}
  window.aiArtFastReplace=applyMockups;
  window.__applyCartMockups=applyMockups;

  if(window.location.pathname.indexOf('/cart')!==-1){applyMockups();schedule();}
  try{var ob=new MutationObserver(function(){schedule();});ob.observe(document.documentElement,{childList:true,subtree:true});}catch(_){}
  window.addEventListener('appai:cart-updated',schedule);
  document.addEventListener('cart:updated',schedule);
  document.addEventListener('cart:refresh',schedule);
  document.addEventListener('shopify:section:load',schedule);
  window.addEventListener('pageshow',schedule);
  console.log('[AppAI Cart Image] installed ' + CART_IMG_VERSION);
})();
