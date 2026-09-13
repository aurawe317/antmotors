# Ant Motors — Native App (Employees) & Web Link (Customers)

## What this is
- **Employees** get a *real, installable native app* (iOS + Android) — built with Capacitor.
  The app loads the deployed web UI from Cloudflare Pages inside a native WebView.
  Data lives in **Supabase** (multi-tenant), so multiple salespeople and multiple companies
  can share the same inventory in real time.
- **Customers** receive a *shareable web link* (the deployed `app/` site on Cloudflare Pages).
  They do **not** install anything.

## Project layout
```
app/                 single-file web app (the UI) — also the customer-facing site
functions/api/       Cloudflare Pages Functions backend (replaces old server.js)
native/              Capacitor native project
  capacitor.config.json   points the iOS/Android shell at the live web URL
  ios/App/App.xcodeproj   real Xcode project (builds & runs on simulator)
```

## Live deployment
- Frontend: **Cloudflare Pages** (`app/` as build output). Domain: `https://antmotors.pages.dev`
  (replace in `native/capacitor.config.json` if Cloudflare assigns a different subdomain).
- Backend: **Cloudflare Pages Functions** (`functions/api/`) + **Supabase** (`mcjvlohnyfkvmftrvxeq`).
- Required Cloudflare environment variables:
  - `SUPABASE_URL` — already in `wrangler.toml`
  - `SUPABASE_SERVICE_ROLE_KEY` — set as **Secret** in Cloudflare Dashboard

## Build & run (iOS) — verified on this machine
Prereqs: macOS + Xcode 26 (no CocoaPods needed; Capacitor 8 uses SwiftPM).
```bash
cd native
npm install
npx cap sync ios            # copy latest app/ into the iOS project
open ios/App/App.xcworkspace
# or command line:
xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build
```
The iOS shell is configured to load the live Cloudflare Pages URL, so the app
updates automatically when the web deployment updates — no TestFlight round-trip for
UI changes. Distribute the shell via **TestFlight** or **Apple Business / MDM**.
Requires your Apple Developer signing certificate (Xcode → Signing & Capabilities → team).

## Build (Android)
Prereqs: Android Studio + Android SDK + a `keystore` for release signing.
```bash
cd native
npm install
npx cap add android        # only once (SDK must be installed)
npx cap sync android
npx cap open android       # opens Android Studio
```
Distribute via **Google Play** (Internal / Closed testing) or sideload the AAB/APK through MDM.

## Data persistence
- Inventory, photos, staff and showroom data are persisted in **Supabase** (multi-tenant,
  row-level security per company).
- The app also keeps a local cache for offline viewing; edits sync in the background.
- Browser/PWA users can rescue existing local-only data with `migrate-to-supabase.html`.

## Customer web link
Shared links look like `https://antmotors.pages.dev/?c=<carID>&ref=<salesID>`.
The `ref` binds the link to the employee who shared it, so customers reach that person.
