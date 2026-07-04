# Customizer tray & floating launcher — LOCKED DOWN, do not touch casually

**Status: WORKING and verified on live store (2026-07-04, `ai-art-studio-191`).**
Companion to **`docs/iframe-scroll-architecture.md`** — together these two
documents cover the storefront UX that took many failed iterations to get
right. **Do not modify any file or function listed here without explicit
approval from the project owner, and never without re-running the
verification scripts below. If any verification fails after a change, revert
immediately — do not iterate forward on a broken state.**

## Why the tray exists (do not go back to native nav)

Theme-native nav dropdowns are hover-driven and behave differently per theme.
Verified with **no app code involved**: Horizon-family menus (Horizon, Tinker,
Savor, Ritual) do not open when the pointer approaches from **below** the menu
bar — a plain merchant-created dropdown item reproduced the exact same bug as
our injected "Customizer" item. Fighting this per-theme was abandoned.

The replacement is fully app-owned DOM: a floating launcher button + slide-out
tray, **click-driven only**, identical on every theme, desktop and mobile. It
deliberately **never touches the theme's header/menu DOM**. (The old
`appai-saved-designs-nav.js` nav-injection still exists for the saved-designs
drawer itself, but navigation lives in the tray.)

## The pieces

| File | Role |
|---|---|
| `extensions/theme-extension/assets/appai-customizer-tray.js` | Launcher button, tray, positioning, overlay suppression, sign-in item |
| `extensions/theme-extension/blocks/ai-art-embed.liquid` | App embed (`target: body`) that loads the script + merchant settings JSON (`#appai-tray-settings`: `enabled`, `label`, `position`, `shimmer`) |
| `extensions/theme-extension/assets/appai-saved-designs-nav.js` | Provides `window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__` / `window.__APPAI_SAVED_DESIGNS__` that the tray delegates to |
| `client/src/pages/embed-design.tsx` | `hasStoredLoggedInIdentity()`, `openSignIn=1` initial state, `ai-art-studio:open-sign-in` message handler |
| `extensions/theme-extension/assets/appai-art-embed.js` | Forwards the page's `openSignIn=1` URL param into the designer iframe URL |
| `server/routes.ts` | `/apps/appai/customizer-pages` (App Proxy) supplies the tray's page list; `buildCustomizerBootHtml()` loads the same assets on self-bootstrapped pages (settings element absent → defaults) |

The launcher stays hidden when the shop has **no active customizer pages**
(`fetchPages()` returns empty), and when the merchant disables it in the
theme editor.

## Launcher behavior — why every piece exists

1. **Theme style matching** (`extractTrayTheme`): computed styles are read at
   runtime — primary button colors/radius/font for the launcher, body
   background/text + heading font for the tray. No theme-specific CSS
   variable names, so it works on any theme. Falls back to a neutral dark
   scheme when colors are transparent/unusable.

2. **Top placement must NEVER overlap the menu bar.** Two layers, both
   required (each fixed a real bug):
   - `visibleHeaderBottom()` measures header chrome and takes the **MAX**
     bottom across all candidates — announcement/welcome bars above the menu
     used to shadow it. Includes sections inside the header group
     (Horizon-family wraps sections in zero-height custom elements) and
     anchors on the header **cart icon** as a selector-proof fallback.
   - `verifiedClearOfHeaderChrome()` then **hit-tests the actual pixels** the
     button would occupy with `elementsFromPoint`, pushing the button below
     any real header chrome found there (up to 6 iterations). Measurement
     bugs cannot leave the button on the menu because this checks what is
     really rendered.
   - With no measurable header at page top, assume 72px rather than 16px —
     overlapping the menu is the one thing this button must never do.

3. **Bottom placement clears Shopify's preview bar** (`#preview-bar-iframe`
   etc.) on password-protected/preview stores.

4. **Offsets are CSS variables** (`--appai-tray-top` / `--appai-tray-bottom`)
   updated on scroll/resize (rAF-throttled) plus timed rechecks at 1s/3s for
   late-mounting sticky headers and the preview bar.

5. **Theme overlay suppression** (`themeOverlayOpen` +
   `startOverlaySuppression`): when the theme opens its own nav drawer / mega
   menu / cart drawer / modal, the launcher fades out (`.appai-suppressed`)
   and returns when it closes — the same pattern chat widgets use. Pushing
   the button "below the menu" is impossible: drawers cover the full viewport
   height on mobile. Detection is theme-agnostic and all three prongs are
   needed:
   - open `<dialog>` overlays taller than 35% of the viewport (Horizon-family
     drawers, Tinker cart drawer);
   - `<details open>` **inside header chrome only** with a panel > 80px —
     content accordions (FAQs) also use `<details>` and must NOT count;
   - header toggles with `aria-expanded="true"` whose `aria-controls` target
     is taller than 35% of the viewport (Dawn's burger).
   Re-checks run on click/keyup/resize with 250ms/650ms follow-ups so drawer
   animations settle; there is deliberately **no permanent MutationObserver**.

6. **Shimmer** on the label reuses the boot-title shimmer treatment,
   recolored to sweep the theme's button text color; merchant-toggleable.

## Tray content order (top to bottom)

1. **Sign in** ("Your account") — only when NOT signed in (rules below).
2. **Saved Designs** ("Your designs") — only when
   `window.__APPAI_OPEN_SAVED_DESIGNS_DRAWER__` exists (logged-in customer
   with ≥1 design); re-checked every render because that script initialises
   asynchronously.
3. **Customizer pages** ("Design your own") — active pages from the App
   Proxy; the current page is marked "You're here" and does not navigate.
   The list background-refreshes on every open so a just-published page
   appears without a reload.

## Signed-in detection — THE pitfall (bug shipped once, do not re-ship)

The persisted-storage rule is strict:

**Signed in ⇔ `localStorage.appai_customer` parses and has
`isLoggedIn === true`. Anything else — record absent, malformed, or
`isLoggedIn: false` — is signed OUT. There is NO fallback.**

**Never** treat `appai_customer_id` presence as "signed in" — not even as a
fallback when the `appai_customer` record is absent. The **anonymous identity
bootstrap writes the id for every visitor** who has merely loaded the
designer once, and **older app versions wrote the id WITHOUT the
`appai_customer` record**, so returning visitors can carry an id-only
localStorage state indefinitely. This bug shipped **twice**:

1. v1 checked only `!!appai_customer_id` → swallowed the open-sign-in
   request for every returning anonymous visitor.
2. v2 read `appai_customer.isLoggedIn` first but **fell back to the id when
   the record was absent** → same symptom for visitors with the legacy
   id-only state ("the button just navigates to a customizer page").

Implemented in two places that must stay in sync:
- `isSignedIn()` in `appai-customizer-tray.js` (parent page)
- `hasStoredLoggedInIdentity()` in `embed-design.tsx` (iframe)

This works because the designer iframe is served over the **App Proxy on the
shop domain** — its localStorage IS the storefront page's localStorage, so
tray reads are always fresh and signing in inside the iframe hides the tray
item on the next open without a reload.

## Sign-in flow (two paths)

- **Designer iframe on the current page** → the tray posts
  `{ type: 'ai-art-studio:open-sign-in' }` to the iframe.
  `embed-design.tsx` handles it: if no logged-in identity, open the OTP panel
  (`setShowOtpLogin(true)`) and `scrollIntoView` the login prompt (same-origin
  iframe, so this also scrolls the parent page to it).
- **No iframe on the current page** → navigate to the first customizer page
  with `?openSignIn=1`. `appai-art-embed.js` forwards that param into the
  iframe URL; `embed-design.tsx` seeds `showOtpLogin` from it at mount
  (skipped when already signed in).

## Mandatory verification after ANY change to the above

```bash
npx tsx scripts/diagnose-tray-signin.ts    # sign-in item + both open paths
npx tsx scripts/diagnose-tray-overlay.ts   # launcher hides under theme menus
```

Pass criteria (`?preview_theme_id` is used — the live theme never changes;
storefront password defaults to the dev-store one):

- `diagnose-tray-signin`: in a fresh (logged-out) context the tray shows
  "Sign in or Create an Account" first; Case 1 (customizer page) opens the
  OTP panel in the iframe via postMessage; Case 2 (homepage) navigates with
  `openSignIn=1` in the iframe URL and the panel opens on load.
- `diagnose-tray-overlay`: on Dawn, Tinker, and Horizon at 390px, opening the
  theme's drawer/menu sets `.appai-suppressed` (opacity 0) and closing it
  restores the launcher (opacity 1).
- If the tray change also touched anything in the iframe-scroll lockdown
  list, run the scroll suite from `docs/iframe-scroll-architecture.md` too.

**If any criterion fails: `git revert` and redeploy (Railway `production`
push + `npx shopify app deploy -f`) BEFORE investigating further.**

## Deploy notes

- `appai-customizer-tray.js` / `appai-art-embed.js` / liquid changes need
  **`npx shopify app deploy -f`** (CDN asset is versioned per extension
  release; allow a few minutes for cache).
- `embed-design.tsx` / `server/routes.ts` changes need the **Railway**
  deploy (build → commit → merge `production` → push).
- Most tray changes touch both sides — deploy both.

## What was tried and rejected (do not redo)

- Injecting/repairing items in the theme's native nav dropdown for
  navigation — hover behavior is broken per-theme at the theme level
  (approach-from-below never opens on Horizon-family; reproduced with plain
  merchant menu items, zero app code).
- A fixed `top` offset for the launcher — announcement bars, sticky headers
  and zero-height Horizon wrappers all broke it; measurement + pixel
  hit-testing are both required.
- Checking only `appai_customer_id` for signed-in state — anonymous
  bootstrap writes it too (see pitfall above).
- Pushing the launcher below an open theme menu on mobile — drawers are
  full-viewport-height; there is no "below". Fade out/in is the only
  placement that never fights the theme's overlay.
- A permanent MutationObserver for overlay state — timed rechecks on
  click/keyup/resize are cheaper and theme-agnostic.
