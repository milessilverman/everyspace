# Everyspace

Everyspace is a rental management tool for hosts. Use the [Host Console](host/) to track listings, schedules and booking requests across 22 rental platforms.

- Manage homes, hourly spaces, parking, storage, vehicles, EV charging and other rentals.
- Sync any available calendars, review forwarded booking email, and hold dates under a property lock before accepting a request.
- Track overlap alerts and earnings while fulfillment stays on each provider.

The [launch page](https://milessilverman.github.io/everyspace/) and `everyspace.html` share the same code. Earnings tools and the original local simulator are available in the labeled [demo](https://milessilverman.github.io/everyspace/?demo=1#/earn).

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
- add a request before accepting it, and get a calendar result and next steps before accepting on a provider;
- see alerts, a calendar across every site, and earnings;
- review all 22 providers, calendar sync health, booking requests and forwarded email under Channels and Requests.

## Backend (`platform/`)

The real backend now lives in [`platform/`](platform/). It runs on Supabase's free plan in West US, launching in Los Angeles. It has:

- **Two-way calendar sync** with Airbnb, Vrbo and others, every 15 minutes.
- **Conflict prevention:** one configured instant-book site per related space, guarded holds, buffered occupancy and capacity checks. Calendar data can lag provider confirmations.
- **Revenue-share billing:** 10% of the extra money Everyspace brings in, until the fee reaches $30 in a month, then 3%.

See the [platform guide](platform/README.md), [launch plan](platform/docs/PLAN.md) and [channel support](platform/docs/UNIVERSAL_CHANNELS.md).

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

The core rules (pricing, the price rule, iCal sync, listing everywhere, privacy) have automated tests:

```bash
node --test tests/*.test.mjs
```

They load the app's domain code straight from `index.html`, so the site stays a single file.

The backend has its own test suite. From `platform/`:

```bash
npm install
```

```bash
npm test
```

## Future integrations

The simulated marketplace is separate from the Host Console. Live provider connections require partner access. Later marketplace work would also require:

1. **Accounts and a backend.** Real sign-in, a database, and server-side checks that the person making a request owns the listing or booking (the demo API trusts the user ID it's given).
2. **Payments.** Stripe Connect (or similar) for renter charges, deposits held on card, and host payouts.
3. **Partner connections.** Approval from Airbnb, Booking.com and Expedia Group (Vrbo/Expedia) partner programs for direct listing, price and calendar updates. Until then those sites use iCal sync plus our listing team.
4. **A listing team (or tooling)** to post to sites without a direct connection (Swimply, Peerspace, Neighbor and others) and confirm each is live.
5. **Verified fees.** Other sites' fees are estimates in one table (`PLATFORMS` in the code), labeled as estimates in the app until checked.
6. **Legal and insurance.** Terms, privacy policy, host protection insurance, lease and infrastructure agreement templates, and local short-term-rental rules.
7. **Photos.** Upload and storage for listing photos (the demo draws each space).
