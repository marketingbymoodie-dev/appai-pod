# AI Art Studio - Shopify Theme App Extension

This Theme App Extension embeds the AI Art Design Studio directly on your Shopify product pages, allowing customers to create custom AI-generated artwork for print-on-demand products.

## Installation

### Prerequisites

1. A Shopify Partners account
2. The AI Art Studio app installed on your Shopify store
3. Shopify CLI installed (`npm install -g @shopify/cli`)

### Deploying the Extension

1. Navigate to the extensions folder:
   ```bash
   cd extensions/theme-extension
   ```

2. Register the extension with Shopify:
   ```bash
   shopify app extension register
   ```

3. Push the extension to Shopify:
   ```bash
   shopify app extension push
   ```

## Configuration

After deploying the extension, merchants can add the "AI Art Design Studio" block to their product pages:

1. Go to **Online Store > Themes > Customize**
2. Navigate to a product page template
3. Click **Add section** or **Add block**
4. Find "AI Art Design Studio" under the app sections
5. Configure the block settings:
   - **App URL**: Enter your AI Art Studio app URL (e.g., `https://your-app.replit.app`)
   - **Section Heading**: Customize the heading text
   - **Section Description**: Add descriptive text for customers
   - **Show Style Presets**: Toggle to show/hide AI style presets
   - **Studio Height**: Adjust the design studio height (400-800px)

## How It Works

1. The block reads product variants from the current product page
2. Size and frame color options are extracted from variant options
3. An iframe loads the embedded design studio from your app
4. Customers can:
   - Enter a text prompt describing their artwork
   - Upload a reference image (optional)
   - Select a style preset (optional)
   - Choose size and frame color
   - Generate AI artwork
   - Add the customized product to cart

## Cart Integration

When customers click "Add to Cart", the artwork is added as a line item property:
- `_artwork_url`: URL of the generated artwork
- `_design_id`: Unique design identifier
- `Artwork`: Display label for the cart

These properties are passed to your order fulfillment system (Printify) for print-on-demand production.

## Message Protocol

The extension communicates with your app via `postMessage`:

### From App to Shopify:
```javascript
// Add to cart
{
  type: 'ai-art-studio:add-to-cart',
  variantId: '12345',
  artworkUrl: 'https://...',
  designId: 'abc123'
}

// Resize iframe
{
  type: 'ai-art-studio:resize',
  height: 600
}
```

### From Shopify to App:
```javascript
// Cart update result
{
  type: 'ai-art-studio:cart-updated',
  success: true,
  cart: { /* cart data */ }
}
```

## Styling

The extension includes basic styling that adapts to most themes. For advanced customization, merchants can add CSS in their theme's `theme.liquid` or asset files:

```css
.ai-art-studio-block {
  /* Custom container styles */
}

.ai-art-studio__heading {
  /* Custom heading styles */
}

.ai-art-studio__description {
  /* Custom description styles */
}
```

## Troubleshooting

### Extension not appearing
- Ensure the extension is deployed and enabled in your Shopify Partners dashboard
- Verify the App URL is correctly configured

### Design studio not loading
- Check that the App URL is accessible and using HTTPS
- Verify CORS headers allow embedding in an iframe

### Add to cart not working
- Ensure product variants are properly configured
- Check browser console for JavaScript errors
- Verify the message protocol is working correctly

## Security Considerations

### Current Implementation (MVP)

The current implementation uses session tokens with the following security measures:
- Referer/Origin header validation
- Timestamp validation (5-minute window)
- IP binding for session tokens
- Rate limiting (100 generations per shop per hour)
- Shop installation verification

### Production Recommendations

For enhanced security in production environments, consider implementing:

1. **Shopify App Bridge Integration**: Use Shopify App Bridge session tokens for cryptographically verified authentication. This requires:
   - Installing `@shopify/app-bridge` in the embedded app
   - Creating authenticated sessions via App Bridge
   - Verifying JWTs on the backend

2. **App Proxy Routing**: Route generation requests through Shopify's App Proxy, which adds HMAC verification to all requests.

3. **Per-Shop Credit System**: Implement usage tracking and credit limits per shop installation to control AI generation costs.

## Support

For issues with the AI Art Studio app, contact support or visit the documentation.
