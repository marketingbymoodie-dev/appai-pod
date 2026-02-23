/**
 * AppAI Custom Design Preview — Checkout UI Extension
 *
 * Renders a mockup image + "Custom Design" badge for every cart line item
 * that has a `_mockup_url` line item property (set by the AppAI customizer
 * or the product-page design studio via /cart/add.js properties).
 *
 * Target: purchase.checkout.cart-line-item.render-after
 *
 * SETUP:
 *   1. Install deps (run once in this directory):
 *        npm install
 *   2. Deploy with the rest of the app:
 *        npx shopify app deploy
 *
 * Dependencies (see package.json):
 *   @shopify/ui-extensions-react  ^0.50.0
 */

import {
  reactExtension,
  useCartLine,
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
  const cartLine = useCartLine();

  // Line item properties set via /cart/add.js map to `attributes` in the
  // Checkout UI Extension API (they appear as customAttributes in GraphQL).
  const attrs = cartLine.attributes || [];

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
