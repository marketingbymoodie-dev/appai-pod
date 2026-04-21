/**
 * AppAI Custom Design Preview — Checkout UI Extension
 *
 * Renders a mockup image + "Custom Design" badge for every cart line item
 * that has a `_mockup_url` line item property (set by the AppAI customizer
 * or the product-page design studio via /cart/add.js properties).
 *
 * Target: purchase.checkout.cart-line-item.render-after
 *
 * ─── IMPORTANT: Extension deps live here, NOT in the repo root ───────────────
 * The Shopify CLI bundles this extension with its own node_modules scoped to
 * THIS directory.  The root package.json does NOT provide these modules.
 *
 * Before running `shopify app dev` or `shopify app deploy` you must have run:
 *
 *   cd extensions/checkout-ui && npm install
 *   OR from the repo root:
 *   npm run ext:install
 *
 * Keep @shopify/ui-extensions(-react) aligned with `api_version` in shopify.extension.toml.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  reactExtension,
  useCartLineTarget,
  BlockStack,
  InlineLayout,
  View,
  Image,
  Text,
  Badge,
} from '@shopify/ui-extensions-react/checkout';

/**
 * TEMPORARY — set to `false` before you consider this checkout extension “done” for all merchants.
 * When true: if no mockup URL is resolved, a small line shows cart line attribute keys (checkout debugging).
 */
const APPAI_CHECKOUT_DEBUG_PREVIEW = true;

export default reactExtension(
  'purchase.checkout.cart-line-item.render-after',
  () => <AppAIDesignPreview />,
);

function AppAIDesignPreview() {
  // useCartLineTarget returns the specific line item this extension instance
  // is rendering for (one instance per cart line in the order summary).
  const cartLine = useCartLineTarget();

  // Line item properties set via /cart/add.js map to `attributes` in the
  // Checkout UI Extension API (they appear as customAttributes in GraphQL).
  const attrs = (cartLine && cartLine.attributes) ? cartLine.attributes : [];

  const mockupUrl = pickPreviewImageUrl(attrs);
  const designId  = getAttr(attrs, '_design_id') || getAttr(attrs, 'design_id');

  // Nothing to render if there's no usable preview URL
  if (!mockupUrl) {
    if (!APPAI_CHECKOUT_DEBUG_PREVIEW) return null;
    return (
      <BlockStack spacing="extraTight" padding={['tight', 'none', 'none', 'none']}>
        <Text size="extraSmall" appearance="subdued">
          [AppAI debug] No preview URL — attrs: {summarizeAttrsForDebug(attrs)}
        </Text>
      </BlockStack>
    );
  }

  // Validate it's a real HTTPS URL (never render data: or blob: URIs)
  if (!mockupUrl.startsWith('https://')) {
    if (!APPAI_CHECKOUT_DEBUG_PREVIEW) return null;
    return (
      <BlockStack spacing="extraTight" padding={['tight', 'none', 'none', 'none']}>
        <Text size="extraSmall" appearance="subdued">
          [AppAI debug] URL rejected (need https://): {String(mockupUrl).slice(0, 80)}
        </Text>
      </BlockStack>
    );
  }

  return (
    <BlockStack spacing="tight" padding={['base', 'none', 'none', 'none']}>
      <InlineLayout
        spacing="base"
        blockAlignment="center"
        columns={['auto', 'fill']}
      >
        {/* Mockup thumbnail */}
        <View
          border="base"
          borderRadius="base"
          overflow="hidden"
          inlineSize={80}
          blockSize={80}
          background="subdued"
        >
          <Image
            source={mockupUrl}
            alt="Your custom design"
            fit="contain"
            accessibilityDescription="Preview of your personalized design"
          />
        </View>

        {/* Labels */}
        <BlockStack spacing="extraTight">
          <Text size="small" emphasis="bold">
            Custom Design
          </Text>
          {designId && (
            <Text size="extraSmall" appearance="subdued">
              Ref: {designId.slice(0, 12)}
            </Text>
          )}
          <Badge tone="success">Personalized</Badge>
        </BlockStack>
      </InlineLayout>
    </BlockStack>
  );
}

/** Safe attribute lookup */
function getAttr(attrs, key) {
  if (!Array.isArray(attrs)) return null;
  var entry = attrs.find(function (a) {
    if (!a) return false;
    var k = a.key != null ? a.key : a.name;
    return k === key;
  });
  return entry ? (entry.value != null ? entry.value : entry.val) : null;
}

/**
 * Pick the best HTTPS image URL for checkout preview.
 * - Prefer explicit mockup properties.
 * - Fall back to hosted artwork (still better than the blank product photo).
 * - Scan keys containing "mockup" (handles minor naming drift).
 */
function pickPreviewImageUrl(attrs) {
  var u =
    getAttr(attrs, '_mockup_url') ||
    getAttr(attrs, 'mockup_url') ||
    getAttr(attrs, 'Mockup URL');
  if (u && String(u).startsWith('https://')) return String(u);

  var art = getAttr(attrs, '_artwork_url') || getAttr(attrs, 'artwork_url');
  if (art && String(art).startsWith('https://')) return String(art);

  if (!Array.isArray(attrs)) return null;
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i];
    if (!a) continue;
    var k = String(a.key != null ? a.key : a.name || '').toLowerCase();
    var v = a.value != null ? a.value : a.val;
    if (!v || typeof v !== 'string') continue;
    if (v.indexOf('https://') !== 0) continue;
    if (k.indexOf('mockup') !== -1) return v;
  }
  return null;
}

/** One-line summary for checkout debug (truncated; no full secrets). */
function summarizeAttrsForDebug(attrs) {
  if (!Array.isArray(attrs) || attrs.length === 0) return '(none)';
  return attrs
    .map(function (a) {
      if (!a) return '';
      var k = a.key != null ? a.key : a.name;
      var v = a.value != null ? a.value : a.val;
      var vs = v == null ? '' : String(v);
      var tail = vs.length > 48 ? vs.slice(0, 45) + '…' : vs;
      return String(k) + '=' + tail;
    })
    .filter(Boolean)
    .join(' · ');
}
