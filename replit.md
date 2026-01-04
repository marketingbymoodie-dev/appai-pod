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

Core database tables:
- `users` and `sessions` - Authentication (required for Replit Auth)
- `customers` - Extended user profiles with credits system
- `merchants` - Merchant configuration and API tokens
- `designs` - Customer-created artwork
- `orders` - Purchase history
- `generation_logs` - AI generation tracking
- `credit_transactions` - Credit purchase/usage history
- `conversations` and `messages` - Chat functionality

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