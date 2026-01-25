import type { Express } from "express";

/**
 * Shopify-native auth has NO /api/login, /api/callback, /api/logout routes.
 * Those existed for Replit OIDC.
 *
 * We keep this file so any existing imports don't explode, but it intentionally
 * registers nothing.
 */
export function registerAuthRoutes(_app: Express) {
  // no-op
}
