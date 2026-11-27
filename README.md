# Everyspace

Find out how much more your property could be earning, and manage what you rent out: homes, rooms, backyards, pools, parking, storage, roofs and more.

**Live site:** https://milessilverman.github.io/everyspace/

The homepage (`index.html`) is a single address box. Submitting it opens the income estimator (`estimate/`) with the address in the URL fragment, which the estimator reads once and then removes from the address bar. Without JavaScript the form falls back to a plain GET to `estimate/?address=`. The homepage itself makes no lookups and stores nothing.

The earlier single-file demo (earnings quiz, earnings map, marketplace screens, simulated site sync) has moved to [milessilverman/everyspace-demo](https://github.com/milessilverman/everyspace-demo), live at https://milessilverman.github.io/everyspace-demo/. `everyspace.html` redirects there so old links keep working.

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

[`estimate/`](estimate/) is a free page where anyone can type an address and see what the property could earn. It looks up the parcel in public records, lists the ways the space could earn, and shows a conservative, baseline and optimistic range for each. It will be served at `/everyspace/estimate/` once merged. The home page is the address field that starts it.

- **Where the numbers come from:** prices and bookings are Everyspace planning defaults, labelled as such, with no market source yet, so every estimate is low confidence. Enter your own price, bookings or costs and your numbers replace the defaults. Local rules (for example Los Angeles home-sharing) are marked unverified, because the official pages could not be read.
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
- `revenue.js`: conservative, baseline and optimistic earnings estimate.
- `types.js`: the shared contracts.
- `data/`: planning defaults, categories, platform fees, rules, parcel services and scenario spreads.

## Tests

Run these from the repository root unless noted. Counts are from 2026-11-27. There is no install step for the root project (`package.json` has no dependencies); the browser tests use the Playwright with Chromium that is already installed.

```bash
npm test
```

Runs the `core/` modules (`node --test core/tests/*.test.mjs`). 257 tests pass.

```bash
npm run e2e
```

Runs every `tests/*.e2e.mjs` in turn through `tests/run-e2e.mjs` and fails if any file fails. A test file added later is picked up automatically. To run some of them, pass part of a name: `node tests/run-e2e.mjs home navigation`.

```bash
npm run check
```

Runs both. The browser tests drive the pages with a mocked network: lookups are answered from recorded fixtures, anything else that leaves localhost is blocked and fails the run, so they never touch a real site or database. Each file also runs on its own (`node tests/<name>.e2e.mjs`):

| file | covers |
|---|---|
| `tests/home.e2e.mjs` | homepage: form, footer, no requests, no storage, phone width, no-JavaScript path |
| `tests/estimate.e2e.mjs` | address entry and the estimator: results equal `core/`, malformed and markup addresses, double submit, lookup failures, keyboard use |
| `tests/property-confirm.e2e.mjs` | match confirmation, parcel picker, the "Your property" table, owner corrections, rejected edits, manual mode |
| `tests/navigation.e2e.mjs` | home, estimator and Host Console links, back/forward, the old `everyspace.html` redirect, wrong URLs, every internal link at a domain root and under `/everyspace/` |
| `tests/host*.e2e.mjs`, `tests/signin.e2e.mjs` | Host Console with a mocked backend |

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

The estimator and Host Console are real; the earlier demo's marketplace, payments and listing-team ideas are not part of this repository. To take real bookings it still needs:

1. **Accounts and a backend applied to production.** Migrations and edge functions are staged, not deployed (see `docs/STATE.md`).
2. **Partner connections.** Approval from Airbnb, Booking.com and Expedia Group for direct listing, price and calendar updates. Until then sites use iCal sync.
3. **Verified fees and rules.** Platform fees and local rules are labelled planning defaults until checked against their publishers.
4. **Legal and insurance.** Terms, privacy policy, host protection insurance and local short-term-rental rules.
