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
 * The version of @shopify/ui-extensions-react MUST match the api_version in
 * shopify.extension.toml (currently 2024-07 → package version 2024.7.0).
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

  const mockupUrl = getAttr(attrs, '_mockup_url');
  const designId  = getAttr(attrs, '_design_id');

  // Nothing to render if there's no mockup
  if (!mockupUrl) return null;

  // Validate it's a real HTTPS URL (never render data: or blob: URIs)
  if (!mockupUrl.startsWith('https://')) return null;

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
  var entry = attrs.find(function (a) { return a && a.key === key; });
  return entry ? entry.value : null;
}
