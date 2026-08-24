---
name: testing-mobile-expo-web
description: How to boot and end-to-end test the React Native app in mobile/ in a real browser via `npx expo start --web` when no emulator is available, including a session-cookie auth harness, SecureStore on web, and the known runtime traps.
---

# Testing mobile/ (React Native + Expo SDK 50) in a browser

There is usually no Android/iOS emulator on these boxes. `npx expo start --web` from `mobile/` is the
only way to render and click the native screens. Everything below is harness setup — disclose it as
such in reports, and never present a web-only result as native verification (RN Web maps the same
component tree, so React logic/data bugs reproduce, but native modules — camera/QR, biometrics,
push, real SecureStore — do not).

## Bring-up

```bash
cd mobile && npm ci                      # SDK 50; datetimepicker must stay ~7.6.2
EXPO_PUBLIC_API_URL=http://127.0.0.1:3200 npx expo start --web --port 8081 --clear
```

Traps:
- `npx expo start` **rewrites `mobile/tsconfig.json`** — `git checkout mobile/tsconfig.json` afterwards.
- `mobile/app.json` names `./assets/{icon,splash,adaptive-icon,favicon}.png`; if `mobile/assets/` is
  absent the favicon middleware throws `ENOENT` and can kill the dev server. Create throwaway PNGs
  (use real, valid PNGs — 1px stubs make Jimp log errors) and delete them in cleanup.
- Confirm the bundle line says `Web Bundled … (node_modules/expo/AppEntry.js)`; that is the entry the
  app is supposed to use (`App.tsx` is the root, there is no `app/` dir / expo-router).

## Auth (the important part)

`mobile/src/services/trpc.ts` reads a token from `SecureStore.getItemAsync('auth_token')` and sends it
as a **`Cookie: app_session_id=<jwt>` header**. Browsers forbid scripts setting `Cookie`, and
`expo-secure-store` has no web implementation on SDK 50, so on web you need two shims:

1. A forwarding proxy (e.g. `:3200` → real dev server `:3000`) that answers CORS preflights and
   injects `Cookie: app_session_id=<jwt>` read from a file; swap that file to change identity.
2. A localStorage shim for `mobile/node_modules/expo-secure-store/build/ExpoSecureStore.web.js`
   (keep a `.orig` copy), then seed `localStorage['secure:auth_token']` with a JWT for a real `users`
   row and reload.

OAuth (`expo-auth-session`) is not testable locally: the server exposes `/api/oauth/callback` but no
`/api/oauth/authorize`. Say so rather than faking a login.

## Driving the UI

The `browser` tool is unreliable here; Playwright over Chrome CDP works:
`chromium.connectOverCDP('http://127.0.0.1:29229')`.

RN Web selector tips:
- Nav groups/items are plain text nodes: `page.getByText('Admin tools', {exact:true}).first().click({force:true})`.
- The **Quick actions** group is expanded by default — clicking its header collapses it; click its
  items directly instead.
- Bottom tab labels are duplicated (icon + label), so use `.last()`.
- The dashboard's "Find a page" input stays mounted behind modals — filter with `input:visible`.
- Prefer `{force:true}`: RN Web wraps touchables in elements Playwright often considers not "stable".

## Known runtime traps to check first (they blank the whole app)

Any module-level `ReferenceError` (e.g. `Platform.OS` used without importing `Platform`) leaves
`#root` **empty with no error boundary** — a white screen, not an error. `npx tsc --noEmit -p mobile`
"Cannot find name X" errors are the cheapest predictor of this class of bug.

Second class: screens that assume a tRPC router returns an array when it returns an envelope
(`assets.list` returns `{ assets, count }`). Depending on the call it either crashes
(`x.reduce is not a function`, again a blank page) or renders a **plausible empty state** ("No assets
yet") while data exists — check every list screen against SQL/HTTP, not against the UI's own copy.

Third class: tRPC v11 removed `mutation.isLoading` (now `isPending`). Buttons reading `isLoading`
still fire the mutation successfully but never disable or show progress — verify by polling the
button label while the request is in flight and watching the POST response.

Fourth class: date/timestamp field-name and decoding mismatches. Postgres `DATE(...)` is decoded by
node-postgres into a JS `Date`, so a screen doing `row.date.slice(0,…)` throws
`date.slice is not a function` **only when the range has data** — cast `DATE(...)::text` server-side.
Similarly, a list row that reads `item.timestamp` when the router returns `createdAt` renders
`Invalid Date` per row while the aggregate tiles above look perfectly healthy. Always compare the
router's actual output shape (curl the tRPC route) with every field the screen reads.

## Rate limiting will silently end your run

`server/_core/index.ts` installs a global limiter of **300 requests / 15 min per IP**. Heavy Playwright
reloads/polling exhaust it; authenticated pages then bounce to `/` ("Please sign in to continue") and it
looks like an auth bug. Workaround: a tiny forwarding proxy that sets a fresh `x-forwarded-for`
(e.g. on `:3300` → `:3000`), restarted with a new fake IP when you need a clean budget. Check
`ratelimit-remaining` in responses before blaming the app.

## PWA admin analytics: infinite refetch loop (pre-existing)

`client/src/pages/admin/AnalyticsDashboard.tsx` computes `getDateRange()` (with
`new Date().toISOString()`) inline on every render, so every render produces a new tRPC query key →
new fetch → new data → re-render. Observed ~200 successful `adminAnalytics` batches in 12 s and the
page never leaves its skeleton, so the **Export CSV** button never appears and that flow cannot be
tested from the UI. The mobile `AdminAnalyticsScreen` avoids this with `React.useMemo`; the same fix
is what the PWA page needs. Until fixed, test CSV generation via `client/src/lib/exportUtils.ts` unit
level or report it as untested.

## Devin Secrets Needed

None. Local Postgres + locally minted JWTs for existing `users` rows are enough.
