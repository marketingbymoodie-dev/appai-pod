# Iframe scrolling architecture — LOCKED DOWN, do not touch casually

**Status: WORKING and verified on live store (2026-07-03, `ai-art-studio-188`).**
Desktop wheel/trackpad scroll over the iframe and mobile internal iframe scroll
both work on Savor, Ritual, Horizon, Dawn, Tinker. This took many failed
iterations to get right. **Do not modify any file or function listed here
without explicit approval from the project owner, and never without re-running
the verification scripts below. If any verification fails after a change,
revert the change immediately — do not iterate forward on a broken state.**

## The two modes

Mode is decided ONCE at mount in `appai-art-embed.js` by:

```js
window.matchMedia('(pointer: coarse), (max-width: 767px)').matches
```

| | Desktop mode (`mobileNativeScroll = false`) | Mobile-native mode (`true`) |
|---|---|---|
| Iframe height | Grows to full content height via `ai-art-studio:resize` postMessage | Fixed to viewport height − 24 (min 520) |
| Iframe internal scroll | None — `html/body overflow: hidden` inside iframe, `scrolling="no"` | Yes — iframe scrolls its own content (`overflow-y: auto`), scrollbar hidden by CSS |
| Who scrolls on wheel/touch | The PARENT store page, via forwarding (below) | The iframe itself; parent only at boundary handoff |

## Desktop wheel forwarding — why every piece exists

`appaiAttachIframeWheelForward()` attaches a capture-phase `wheel` listener to
the same-origin iframe **document**. It `preventDefault()`s and calls
`appaiScrollParentPage()`. Every rule below was added to fix a real, observed
production bug:

1. **`appaiInstantScrollBy()` — all scroll writes MUST go through it.**
   Savor/Ritual/Horizon set CSS `scroll-behavior: smooth` on the page scroller.
   A plain `el.scrollTop = x` write respects that CSS and starts a ~300ms
   animation; writing every wheel tick cancels-and-restarts the animation from
   a barely-moved position → **the page looks completely frozen** even though
   hundreds of writes succeed. `el.scrollBy({behavior:'instant'})` bypasses the
   CSS. This was THE bug that made Savor/Ritual "not scroll at all".

2. **Scroller resolution (`appaiGetPageScrollElement` + `appaiScrollRootForEmbedIframe`).**
   Savor-family themes scroll an inner `.page-wrapper` div, NOT `<html>`.
   `document.scrollingElement` writes silently do nothing there. Resolution
   order: main page scroller if it can move in the wheel direction, else the
   nearest scrollable wrapper around the iframe (walk up from the iframe, max
   16 levels).

3. **`appaiAnimateWheelScroll()` — discrete wheel notches are animated.**
   A classic mouse wheel sends one ~100px delta per notch; writing it in a
   single frame is a hard visual step ("choppy"). Deltas ≥ 60px (or
   deltaMode ≠ 0) animate at 35% of remaining distance per frame. Trackpad
   deltas stay instant 1:1 — adding smoothing to trackpads feels laggy.

4. **Inner-scroll panels hand off at their boundary.** Pointer over
   `[data-appai-inner-scroll]` (e.g. saved-designs grid) scrolls the panel only
   while it can still move in the wheel direction; at the edge the wheel goes
   to the page (previously a dead zone). Radix overlay content always scrolls
   internally.

5. **`__APPAI_PARENT_WHEEL_FORWARD__` flag prevents double scroll.** When the
   parent attaches the direct listener, the iframe's own `postMessage` wheel
   fallback (`embed-design.tsx`) must NOT also fire — both running = jitter.

## Mobile-native mode — why every piece exists

1. **The wheel-forward hijack must NEVER attach in mobile mode.**
   `appaiAttachIframeWheelForward()` self-checks the media query and returns —
   it does not trust the caller's flag, because `cleanupDuplicateGenerators()`
   once passed `false` blindly and the hijack scrolled only the store page,
   making lower iframe content unreachable (visible in Shopify's desktop
   mobile preview, which combines wheel input with a narrow viewport).

2. **The iframe's internal scrollbar is hidden, not disabled** (`index.css`,
   `scrollbar-width: none` + `::-webkit-scrollbar`) — it rendered next to the
   page scrollbar as a confusing double bar.

3. **Touch boundary handoff** (`embed-design.tsx`): passive touch listeners
   forward `deltaY` to the parent ONLY when the iframe is pinned at its
   top/bottom edge in the drag direction (iOS does not propagate iframe touch
   scroll natively). Parent-side handlers (`ai-art-studio:touchscroll` /
   `touchfling`) resolve the real scroller per event and write via
   `appaiInstantScrollBy` (same smooth-behavior + inner-wrapper traps as
   desktop).

## Files that implement this (the lockdown list)

| File | Locked-down parts |
|---|---|
| `extensions/theme-extension/assets/appai-art-embed.js` | `appaiInstantScrollBy`, `appaiAnimateWheelScroll`, `appaiScrollParentPage`, `appaiGetPageScrollElement`, `appaiScrollRootForEmbedIframe`, `appaiCanScroll`, `appaiAttachIframeWheelForward`, `cleanupDuplicateGenerators` (wheel-attach calls), `ai-art-studio:resize/wheel/touchscroll/touchfling/touchcancel` message handlers, `mobileNativeScroll` detection, `applyMobileNativeScrollFrame` |
| `client/src/pages/embed-design.tsx` | resize-report effect, wheel-forward effect (incl. `__APPAI_PARENT_WHEEL_FORWARD__` check), both touch-scroll effects |
| `client/src/index.css` | all `html[data-appai-embed]` scroll/overflow/scrollbar rules |
| `server/routes.ts` | `buildCustomizerBootHtml()` script injection (self-bootstrapped pages get the same embed JS) |

## Mandatory verification after ANY change to the above

Run all three (they use `?preview_theme_id`, the live theme is never changed;
storefront password defaults to the dev-store one):

```bash
npx tsx scripts/diagnose-scroll.ts    # desktop: Savor/Horizon/Dawn — pageMoved must be true (Savor moves .page-wrapper)
npx tsx scripts/diagnose-savor.ts     # desktop Savor: wrapper must advance exactly 120/240/315
npx tsx scripts/diagnose-mobile.ts    # mobile: hijackAttached must be false, iframeScrolledInternally must be true
```

Pass criteria:

- `diagnose-savor`: wrapper scrollTop hits 120 → 240 → 315 after three 120px ticks.
- `diagnose-scroll`: `iframeScroll.pageMoved: true` on Horizon and Dawn; on
  Savor the movement shows in `scrolledElements` (`.page-wrapper`).
- `diagnose-mobile`: `hijackAttached: false` and `iframeScrolledInternally: true`
  on every theme.

**If any criterion fails: `git revert` the change and redeploy (Railway
`production` push + `npx shopify app deploy -f`) BEFORE investigating further.**

## What was tried and rejected (do not redo)

- Plain `scrollTop +=` writes — frozen by theme `scroll-behavior: smooth`.
- `window.scrollBy({behavior:'smooth'})` per tick — overlapping animations,
  glitchy bounce-back.
- Always scrolling `document.scrollingElement` — dead on inner-wrapper themes
  (Savor `.page-wrapper`).
- Attaching the wheel hijack unconditionally (mobile) — parent-only scroll,
  iframe content unreachable.
- Smoothing trackpad deltas — feels laggy; only discrete notches are animated.
