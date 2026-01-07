# AI Art Studio - Shopify Pillow Artwork Customization App

## Overview

This is an AI-powered art generation and customization platform designed for creating pillow artwork. The application enables customers to generate unique designs using AI (via Google's Gemini models), customize print sizes and frame colors, and integrates with Printify for print-on-demand fulfillment. The platform includes both customer-facing design tools and merchant administration features for managing orders, settings, and API integrations.

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
- Home (landing/dashboard)
- Design (AI art generation interface)
- Designs (saved designs gallery)
- Orders (order history)
- Admin (merchant settings panel)

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
- For enhanced security, implement Shopify App Bridge (see README in extensions folder)

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