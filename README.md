# Everyspace

Free rental management for everything you rent out: homes, rooms, backyards, pools, parking, storage, roofs and more.

- One calendar and one inbox for Everyspace, Airbnb, Vrbo, Booking.com, Expedia, Swimply and other sites
- Calendar sync, double-booking alerts and price sync ("list once, live everywhere")
- Turnovers and tasks, expenses and profit, permits and insurance reminders
- Earnings quiz, pricing help, private neighbor offers and cleaning-gap rentals
- Also a marketplace with a 3% host fee and all-in prices for renters

**Live site:** https://milessilverman.github.io/everyspace/

`index.html` and `everyspace.html` are the same single-file app. It runs entirely in the browser with demo data (saved in your browser's local storage); connections to other sites are simulated until partner integrations and a backend are in place.

## Earnings map

`#/map` shows what a specific home could earn:

- **Event parking:** stadiums, arenas, fairs, festivals and parades around Los Angeles (SoFi, Dodger Stadium, the Rose Bowl, Fiesta La Ballona and more) with walking-distance zones. Tap a home or search an address to see what its driveway could earn on event days. Venue positions are approximate, and event counts and prices are typical figures, not guarantees.
- **Solar:** tap a roof to measure it from its OpenStreetMap building outline (or draw it), pick the slope, shape and facing, and see the system size and what a solar company could pay.

Data sources, all queried from the visitor's browser: LA County Assessor parcels (public.gis.lacounty.gov), OpenStreetMap buildings (Overpass API) and search (Nominatim), CARTO street tiles and Esri World Imagery. The map library is [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause), embedded in the page.

## Host Console (`host/`)

[`host/index.html`](host/index.html) is the real, signed-in app for hosts, connected to the live backend. Once it's on `main` it will be at `https://milessilverman.github.io/everyspace/host/`. Hosts can:

- add places, spaces (a room can sit inside the whole home) and the sites each is listed on;
- connect each site's calendar both ways, with copy-paste links and steps for each site;
- choose the one site that takes instant bookings;
- add a request before accepting it, and get "Close these nights on Airbnb", then "Safe to accept", or "Decline";
- see alerts, a calendar across every site, and earnings.

## Backend (`platform/`)

The real backend lives in [`platform/`](platform/). The live project runs on Supabase's free plan in West US, launching in Los Angeles. The live project has the first set of features:

- **Two-way calendar sync** with Airbnb, Vrbo and others, every 15 minutes.
- **No-double-booking rules:** one instant-book site per space; requests on other sites hold the dates, and are marked safe to accept only after the dates are proven closed everywhere; plus a guard that flags anything that slips.
- **Revenue-share billing:** 10% of the extra money Everyspace brings in, until the fee reaches $30 in a month, then 3%.

**New on this branch, NOT yet applied to the live project.** The code and migrations are tested only on a local staging database. Nothing from this branch has been applied to, or deployed to, the live project.

- **Teams:** organizations, roles and memberships (invite and accept), so co-hosts and cleaners can have limited access.
- **Lookup tables** for sites and space categories instead of fixed lists.
- **Property profile:** parcels, buildings, attributes with their source and confidence, photos, rules, and revenue opportunities.
- **Operations:** pricing rules, expenses, revenue entries, maintenance tasks and messages.
- **Availability engine:** relations between spaces, shared resources, setup and cleanup time, and an exclusion constraint. Bookings are made, cancelled and moved only through database functions, and calendar sync writes through one locked call.
- **Calendar sync health:** failure counts, last good sync and a `sync_health` view.
- **Adapters:** iCal links and manual CSV import (`booking-import`). No other site connections exist.
- **Safer fetching** of host-pasted calendar links (private addresses and unsafe redirects are refused).

The edge functions in this branch need the new migrations. Apply the migrations first, then deploy the functions (see [`platform/README.md`](platform/README.md)).

See [`platform/README.md`](platform/README.md) and the game plan in [`platform/docs/PLAN.md`](platform/docs/PLAN.md).

## Income estimator (`estimate/`)

[`estimate/`](estimate/) is a free page where anyone can type an address and see what the property could earn. It looks up the parcel in public records, lists the ways the space could earn, and shows a low, middle and high range for each. It will be served at `/everyspace/estimate/` once merged. The home page does not link to it yet.

- **Where the numbers come from:** prices and bookings are Everyspace planning defaults, labelled as such, with no market source yet, so every estimate is low confidence. Enter your own price, bookings or costs and your numbers replace the defaults. Rules for places other than the ones listed are marked unverified.
- **Nothing is saved.** No sign-in, no account, nothing stored by Everyspace. Your address is sent to OpenStreetMap's Nominatim to find it, and the parcel lookup goes to the county's public service, only when you press the button.

## Shared logic (`core/`)

Plain JavaScript with no dependencies, used by the estimator and tests (and meant for edge functions). Money is whole cents; no module reads the clock.

- `availability.js`: which bookings conflict (mirrors the database rules).
- `geometry.js`: area and distance helpers for lots and roofs.
- `opportunities.js`: which ways a property could earn, and what is still unknown.
- `optimizer.js`: the best combination of opportunities (not a plain sum).
- `parcel.js`: address to parcel to property profile.
- `profile.js`: property profile that keeps every value and its history.
- `provenance.js`: tags each value with its source and confidence; owner corrections win.
- `regulatory.js`: whether a use is allowed, from rules kept as data.
- `revenue.js`: low, middle and high earnings estimate.
- `types.js`: the shared contracts.
- `data/`: planning defaults, categories, platform fees, rules, parcel services and scenario spreads.

## What's in the app (`index.html`)

`index.html` (and its copy `everyspace.html`) is the full app, combining the newest version with everything the earlier site had:

- **Earnings quiz** as the home page. Landing cards like "Have a roof?" open it with that item ticked. Bare land and condos only show what they can really rent.
- **Earnings map** (`#/map`): event parking near LA venues and roof solar estimates.
- **Listing wizard** with photos, an AI description, smart pricing, a site picker and a results screen.
- **"Where you're listed"**: one host profile, sign-in or account creation on each site, per-site switches, "Turn on every site", and the listing team posting where there's no direct connection.
- **Host Command Center**: zones, smart locks, insurance, and a monthly statement.
- **Destination ride cursors and color themes**, including mixed colors.
- **Pricing**: managing other sites is free. Everyspace earns a revenue share only on what it brings in: 10% until $30 a month, then 3%.

It links to the real [Host Console](host/) for running actual listings.

## Tests

Run these from the repository root unless noted. Counts are from 2026-11-24.

```bash
node --test tests/*.test.mjs core/tests/*.test.mjs
```

This runs the core rules in the app (pricing, the price rule, iCal sync, listing everywhere, privacy; they load the app's domain code straight from `index.html`, so the site stays a single file) and the `core/` modules. 272 tests pass.

Two browser tests drive the pages with a mocked network (they never touch a real site or database):

```bash
node tests/estimate.e2e.mjs
```

```bash
node tests/host.e2e.mjs
```

The estimator test runs 11 browser scenarios; the Host Console test runs 18 checks. They need Playwright with Chromium.

The backend has its own tests. From `platform/`:

```bash
npm install
```

```bash
npm test
```

231 tests pass, using an in-memory Postgres.

```bash
npm run test:staging
```

This runs 16 race and replay tests on a local Postgres 16 and needs a local Postgres 16 install. All 16 pass.

## What's needed before launch

The app is a complete, working front end with demo data. To take real bookings it still needs:

1. **Accounts and a backend.** Real sign-in, a database, and server-side checks that the person making a request owns the listing or booking (the demo API trusts the user ID it's given).
2. **Payments.** Stripe Connect (or similar) for renter charges, deposits held on card, and host payouts.
3. **Partner connections.** Approval from Airbnb, Booking.com and Expedia Group (Vrbo/Expedia) partner programs for direct listing, price and calendar updates. Until then those sites use iCal sync plus our listing team.
4. **A listing team (or tooling)** to post to sites without a direct connection (Swimply, Peerspace, Neighbor and others) and confirm each is live.
5. **Verified fees.** Other sites' fees are estimates in one table (`PLATFORMS` in the code), labeled as estimates in the app until checked.
6. **Legal and insurance.** Terms, privacy policy, host protection insurance, lease and infrastructure agreement templates, and local short-term-rental rules.
7. **Photos.** Upload and storage for listing photos (the demo draws each space).
8. **Marketplace wording.** The line about a marketplace with a 3% host fee, and the demo's marketplace screens, conflict with the management-first direction. They are left as they are until the owner decides.
