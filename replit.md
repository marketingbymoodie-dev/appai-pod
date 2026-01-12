# AI Art Studio - Shopify Print-on-Demand Artwork Customization App

## Overview

This is an AI-powered art generation and customization platform designed for creating custom print-on-demand products. The application enables customers to generate unique designs using AI (via Google's Gemini models) or import custom artwork, customize print sizes and variants, and integrates with Printify for print-on-demand fulfillment. The platform includes both customer-facing design tools and merchant administration features for managing orders, settings, and API integrations.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight client-side routing)
- **State Management**: TanStack Query (React Query) for server state and caching
- **Styling**: Tailwind CSS with CSS custom properties for theming
- **UI Components**: shadcn/ui component library built on Radix UI primitives
- **Build Tool**: Vite for development and production builds

The frontend follows a pages-based structure with shared components. Key pages include:

**Customer Pages:**
- Home (landing/dashboard)
- Design (AI art generation interface)
- Designs / My Designs (saved designs gallery)
- Orders (order history)

**Admin Pages (under /admin/*):**
- Dashboard (/admin) - Overview stats
- Products (/admin/products) - Manage product types from Printify
- Create Product (/admin/create-product) - Test AI generator for products
- Styles (/admin/styles) - Custom art style presets
- Coupons (/admin/coupons) - Discount codes management
- Credits (/admin/credits) - Credit usage monitoring
- Settings (/admin/settings) - Printify API configuration

The admin portal uses a sidebar navigation layout via AdminLayout component.

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript with ES modules
- **API Design**: RESTful endpoints under `/api/*`
- **Authentication**: Replit Auth integration via OpenID Connect with Passport.js
- **Session Management**: PostgreSQL-backed sessions using connect-pg-simple

The server uses a modular integration pattern with dedicated folders under `server/replit_integrations/` for:
- Authentication (auth)
- AI Chat functionality (chat)
- Image generation (image)
- Batch processing utilities (batch)

### Data Storage
- **Database**: PostgreSQL with Drizzle ORM
- **Schema Location**: `shared/schema.ts` for shared types between frontend and backend
- **Migration Tool**: Drizzle Kit with `db:push` command
- **Image Storage**: Replit Object Storage for AI-generated images (served via `/objects/*` routes)

Core database tables:
- `users` and `sessions` - Authentication (required for Replit Auth)
- `customers` - Extended user profiles with credits system
- `merchants` - Merchant configuration and API tokens
- `designs` - Customer-created artwork
- `orders` - Purchase history
- `generation_logs` - AI generation tracking
- `credit_transactions` - Credit purchase/usage history
- `conversations` and `messages` - Chat functionality
- `shopify_installations` - Shopify OAuth tokens and shop data

### AI Integration
- **Provider**: Google Gemini via Replit AI Integrations
- **Models Used**: 
  - `gemini-2.5-flash` - Fast text generation
  - `gemini-2.5-flash-image` - Image generation
- **Configuration**: Uses environment variables `AI_INTEGRATIONS_GEMINI_API_KEY` and `AI_INTEGRATIONS_GEMINI_BASE_URL`

## External Dependencies

### Third-Party Services
- **Replit Auth**: OpenID Connect-based authentication system (mandatory)
- **Replit AI Integrations**: Provides access to Gemini models without separate API keys
- **Printify**: Print-on-demand integration for product fulfillment (API token stored in merchant settings)

### Database
- **PostgreSQL**: Required for data persistence
- **Environment Variable**: `DATABASE_URL` must be set

### Key NPM Packages
- `drizzle-orm` / `drizzle-kit` - Database ORM and migrations
- `@google/genai` - Google Generative AI client
- `@tanstack/react-query` - Async state management
- `passport` / `openid-client` - Authentication
- `express-session` / `connect-pg-simple` - Session management
- `wouter` - Client-side routing
- Radix UI primitives - Accessible UI components

### Build Configuration
- Development: `npm run dev` (uses tsx for TypeScript execution)
- Production: `npm run build` then `npm start` (bundles with esbuild)
- Database sync: `npm run db:push` (Drizzle Kit push)

## Shopify Integration

### Overview
The app integrates with Shopify via a Theme App Extension that embeds the AI design studio directly on product pages.

### Components
- **OAuth Flow**: `server/shopify.ts` - Handles Shopify app installation and token management
- **Theme Extension**: `extensions/theme-extension/` - Liquid blocks for embedding design studio
- **Embedded Design Page**: `client/src/pages/embed-design.tsx` - React page loaded in Shopify iframe
- **Session Management**: Session tokens with shop verification and rate limiting

### Configuration
Required environment variables for Shopify integration:
- `SHOPIFY_API_KEY` - Shopify app API key
- `SHOPIFY_API_SECRET` - Shopify app API secret

### Theme Extension Deployment
Deploy the theme extension using Shopify CLI:
```bash
cd extensions/theme-extension
shopify app extension push
```

### Security Model
- Session tokens with referer validation and timestamp checks
- Rate limiting: 100 generations per shop per hour
- Shop installation verification for all requests
- Merchant isolation: Shopify installations and product types are verified to belong to the current merchant
- For enhanced security, implement Shopify App Bridge (see README in extensions folder)

### Publish to Shopify ("Send to Store")
The admin "Create Product" page includes a "Send to Store" button that creates draft products in the merchant's Shopify store.

**Endpoint**: `POST /api/shopify/products`
- Requires authenticated merchant
- Takes `productTypeId` and `shopDomain` in request body
- Validates merchant ownership of both Shopify installation and product type

**Product Creation**:
1. Creates a draft product with title, description, and tags
2. Populates all size/color variants from the product type's variant map
3. Adds base mockup images as product images
4. Sets metafields for the theme extension:
   - `ai_art_studio.product_type_id` - Links to the correct product type
   - `ai_art_studio.design_studio_url` - Full URL to the embedded design studio
   - `ai_art_studio.hide_add_to_cart` - Flag to disable native add-to-cart
5. Leaves product as draft with $0.00 pricing for merchant to set before publishing

**Variant Handling**:
- Products with sizes AND colors create a variant for each combination
- Products with only sizes (e.g., phone cases) create size-only variants
- Each variant gets a SKU based on blueprint ID and size/color IDs
- Shopify has a 100 variant limit per product

**Variant Selection at Import**:
- Merchants select which sizes and colors to include during Printify product import
- A three-step wizard guides: select blueprint → select provider → select variants
- Live variant count displayed (red if >100, green if ≤100)
- Import blocked until count is ≤100 to enforce Shopify's limit
- Selections stored in `selectedSizeIds` and `selectedColorIds` columns on productTypes table
- "Edit Variants" button on products page allows updating selections after import
- Backend uses saved selections when publishing to Shopify (not reconfigurable at publish time)

## Printify Integration

### Variant Mapping Architecture
The Printify integration uses a two-layer approach to separate catalog metadata from variant identifiers:

1. **Sizes** (catalog metadata only): Contains `id`, `name`, `width`, `height` - no variant-specific fields
2. **Colors**: Contains `id`, `name`, `hex` - pure display data
3. **VariantMap**: JSON dictionary mapping `${sizeId}:${colorId}` → `{printifyVariantId, providerId}`

This separation ensures:
- Size records are color-agnostic and don't get overwritten by multiple color variants
- Mockup generation resolves the correct Printify variant ID via the map
- Client-side code cannot bypass variant resolution

### Mockup Generation
The `/api/mockup/generate` endpoint:
1. Takes `productTypeId`, `designImageUrl`, `sizeId`, `colorId`
2. Looks up the variant using `variantMap[sizeId:colorId]`
3. Creates a temporary Printify product with the resolved variant
4. Retrieves mockup images from Printify
5. Cleans up the temporary product (in `finally` block to ensure cleanup)

## Custom Design Import

### Overview
Users can import custom designs from Kittl or other sources (in addition to AI generation) for use on print-on-demand products.

### Features
- Tabbed UI: "AI Generate" and "Import Design" tabs in the design studio
- Kittl integration with direct link to Kittl designer
- General custom upload support
- Imported designs work with mockup preview, zoom controls, add-to-cart, and sharing

### Security Controls
- **Allowed file types**: PNG, JPG, WebP only (SVG rejected to prevent XSS)
- **File size limit**: 10MB maximum
- **Path validation**: Only accepts paths from `/objects/uploads/`
- **Image validation**: Uses sharp to verify image dimensions

### API Endpoint
`POST /api/designs/import` validates and processes uploaded images:
- Validates objectPath starts with `/objects/uploads/`
- Fetches and validates content type and file size
- Extracts image dimensions using sharp
- Returns validated image URL and metadata

### Database Schema
The `designs` table includes a `designSource` field to track design origin:
- `ai` - AI-generated designs
- `upload` - Custom uploaded designs
- `kittl` - Designs imported from Kittl

### Future Security Enhancements
For production deployment, consider:
- Session-bound upload tokens (nonce validation)
- Single-use presigned URLs
- Content scanning for malicious payloads